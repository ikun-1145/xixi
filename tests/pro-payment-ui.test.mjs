import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { JSDOM } from "jsdom";

const source = readFileSync(new URL("../ai/pro-payment.js", import.meta.url), "utf8");

function base64Url(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function databaseToken(id = "e736a9426c7311f1851452540025c377") {
  return `${base64Url({ alg: "none" })}.${base64Url({
    role: "authenticated",
    aud: "authenticated",
    id,
    exp: Math.floor(Date.now() / 1000) + 300,
  })}.signature`;
}

function loadPaymentModule({ token = databaseToken(), popup = {}, getToken = async () => token } = {}) {
  const saved = new Map();
  const opened = [];
  let expire;
  const popupDocument = new JSDOM("<!doctype html><html><body></body></html>").window.document;
  const window = {
    SunlandDatabaseToken: { get: getToken },
    localStorage: {
      getItem: key => saved.get(key) || null,
      setItem: (key, value) => saved.set(key, String(value)),
      removeItem: key => saved.delete(key),
    },
    setTimeout(callback) { expire = callback; return 1; },
    clearTimeout() { expire = null; },
    open: () => {
      const result = { document: popupDocument, location: { replace(url) { result.url = url; } }, close() { result.closed = true; }, ...popup };
      opened.push(result);
      return result;
    },
    addEventListener() {},
    removeEventListener() {},
    document: { visibilityState: "visible" },
  };
  const context = vm.createContext({
    window,
    localStorage: window.localStorage,
    atob: value => Buffer.from(value, "base64").toString("binary"),
    Date,
    JSON,
    Math,
    Promise,
    URL,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(source, context);
  return { api: window.SunlandProPayment, opened, saved, expire: () => expire?.() };
}

test("Pro payment creates a verified intent before sending the opened placeholder to Afdian", async () => {
  const { api, opened, saved } = loadPaymentModule();
  const calls = [];
  const reference = "11111111-2222-4333-8444-555555555555";
  const supabase = {
    rpc: async (name, args) => {
      calls.push({ name, args });
      return { data: [{ payment_reference: reference, status: "pending" }], error: null };
    },
  };

  const result = await api.beginCheckout({ supabase });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { name: "sunland_get_or_create_pro_payment_intent", args: undefined });
  assert.equal(opened.length, 1, "placeholder must be opened synchronously with the user gesture");
  assert.match(opened[0].url, /custom_order_id=11111111-2222-4333-8444-555555555555/);
  assert.equal(result.paymentReference, reference);
  assert.equal(saved.size, 1, "pending state is isolated by verified user id");
});

test("Pro payment closes the placeholder and never enters checkout when identity verification fails", async () => {
  const { api, opened } = loadPaymentModule({ token: "not-a-token" });
  let rpcCalled = false;

  await assert.rejects(
    () => api.beginCheckout({ supabase: { rpc: async () => { rpcCalled = true; } } }),
    /身份验证失败/,
  );

  assert.equal(rpcCalled, false);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].closed, true);
});

test("both Pro entry pages use the shared payment module and expose the static support route", () => {
  const app = readFileSync(new URL("../ai/app.js", import.meta.url), "utf8");
  const settings = readFileSync(new URL("../ai_settings.html", import.meta.url), "utf8");
  const support = readFileSync(new URL("../pro_activation_support.html", import.meta.url), "utf8");

  assert.match(app, /window\.SunlandProPayment/);
  assert.match(app, /payments\.beginCheckout/);
  assert.match(settings, /window\.SunlandProPayment/);
  assert.match(settings, /payment\.beginCheckout/);
  assert.match(app, /pro_activation_support\.html/);
  assert.match(settings, /pro_activation_support\.html/);
  assert.match(support, /support@sunland\.dev/);
  for (const language of ["zh", "zh-Hant", "en", "ja", "ko", "es"]) {
    assert.match(support, new RegExp(`"${language}"`));
  }
});

test("Pro payment monitoring does not interrupt either entry page with an unpaid support prompt", () => {
  const app = readFileSync(new URL("../ai/app.js", import.meta.url), "utf8");
  const settings = readFileSync(new URL("../ai_settings.html", import.meta.url), "utf8");

  assert.doesNotMatch(app, /onTimeout:\s*\(/);
  assert.doesNotMatch(settings, /onTimeout:\s*\(/);
});

test("checkout shows progress while identity is pending and times out without late navigation", async () => {
  let resolveToken;
  const { api, opened, saved, expire } = loadPaymentModule({
    getToken: () => new Promise(resolve => { resolveToken = resolve; }),
  });
  let called = false;
  const checkout = api.beginCheckout({ supabase: { rpc: () => { called = true; } } });
  assert.match(opened[0].document.body.textContent, /正在安全连接/);
  assert.equal(opened[0].opener, null);
  expire();
  await assert.rejects(checkout, /暂时无法创建安全付款引用/);
  resolveToken(databaseToken());
  await Promise.resolve();
  assert.equal(called, false);
  assert.equal(opened[0].closed, true);
  assert.equal(opened[0].url, undefined);
  assert.equal(saved.size, 0);
});

test("a stalled intent times out and its late response cannot open checkout", async () => {
  const { api, opened, saved, expire } = loadPaymentModule();
  let resolveIntent;
  const checkout = api.beginCheckout({ supabase: {
    rpc: () => new Promise(resolve => { resolveIntent = resolve; }),
  } });
  while (!resolveIntent) await Promise.resolve();
  expire();
  await assert.rejects(checkout, /暂时无法创建安全付款引用/);
  resolveIntent({ data: { payment_reference: "11111111-2222-4333-8444-555555555555", status: "pending" } });
  await Promise.resolve();
  assert.equal(opened[0].closed, true);
  assert.equal(opened[0].url, undefined);
  assert.equal(saved.size, 0);
});


test("settings checkout does not block popup navigation with a success alert", async () => {
  const settings = readFileSync(new URL("../ai_settings.html", import.meta.url), "utf8");
  const handler = settings.slice(settings.indexOf("    async function upgrade()"), settings.indexOf("    function logout()"));
  const alerts = [];
  let monitoring = false;
  const context = vm.createContext({
    window: { SunlandProPayment: {
      text: key => key,
      beginCheckout: async () => ({ userId: "test-user" }),
    } },
    supabase: {}, confirm: () => true, alert: message => alerts.push(message),
    startSettingsProPaymentMonitoring: () => { monitoring = true; },
  });
  await vm.runInContext(handler + "upgrade()", context);
  assert.equal(monitoring, true);
  assert.deepEqual(alerts, []);
});
