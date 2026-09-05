import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

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

function loadPaymentModule({ token = databaseToken(), popup = {} } = {}) {
  const saved = new Map();
  const opened = [];
  const window = {
    SunlandDatabaseToken: { get: async () => token },
    localStorage: {
      getItem: key => saved.get(key) || null,
      setItem: (key, value) => saved.set(key, String(value)),
      removeItem: key => saved.delete(key),
    },
    open: () => {
      const result = { location: { replace(url) { result.url = url; } }, close() { result.closed = true; }, ...popup };
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
  return { api: window.SunlandProPayment, opened, saved };
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
