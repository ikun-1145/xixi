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

function loadPaymentModule({ token = databaseToken(), popup = {}, getToken = async () => token, enableLegacyInFixture = false, enableMerchandiseInFixture = false } = {}) {
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
  const fixture = source.replace("const WAFFO_ENABLED = true;", "const WAFFO_ENABLED = false;")
    .replace("const PUBLIC_CHECKOUT_ENABLED = true;", `const PUBLIC_CHECKOUT_ENABLED = ${enableLegacyInFixture || enableMerchandiseInFixture};`)
    .replace(/const AFDIAN_MERCHANDISE_ENABLED = (?:true|false);/, `const AFDIAN_MERCHANDISE_ENABLED = ${enableMerchandiseInFixture};`)
    .replace("const LEGACY_CHECKOUT_ENABLED = false;", `const LEGACY_CHECKOUT_ENABLED = ${enableLegacyInFixture};`);
  vm.runInContext(fixture, context);
  return { api: window.SunlandProPayment, opened, saved, expire: () => expire?.() };
}

test("Pro payment creates a verified intent before sending the opened placeholder to Afdian", async () => {
  const { api, opened, saved } = loadPaymentModule({ enableLegacyInFixture: true });
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
  const { api, opened } = loadPaymentModule({ token: "not-a-token", enableLegacyInFixture: true });
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
  assert.doesNotMatch(app, /payments\.beginCheckout/);
  assert.match(settings, /window\.SunlandProPayment/);
  assert.doesNotMatch(settings, /payment\.beginCheckout/);
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
    enableLegacyInFixture: true,
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
  const { api, opened, saved, expire } = loadPaymentModule({ enableLegacyInFixture: true });
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


test("settings purchase uses the public Production pricing path", async () => {
  const settings = readFileSync(new URL("../ai_settings.html", import.meta.url), "utf8");
  const handler = settings.slice(settings.indexOf("    async function upgrade()"), settings.indexOf("    function logout()"));
  const location = { href: "" };
  await vm.runInNewContext(handler + "upgrade()", { location });
  assert.equal(location.href, "pricing.html");
});

test("public checkout disabled rejects before identity, popup or order writes", async () => {
  let reads = 0;
  const { api, opened, saved } = loadPaymentModule({ getToken: async () => { reads++; throw new Error("unexpected credential read"); } });
  assert.equal(api.WAFFO_ENABLED, false);
  assert.equal(api.PUBLIC_CHECKOUT_ENABLED, false);
  await assert.rejects(() => api.beginCheckout({ supabase: { rpc() { throw new Error("unexpected order"); } } }), /审核中/);
  assert.equal(reads, 0);
  assert.equal(opened.length, 0);
  assert.equal(saved.size, 0);
});

test("checkout rejects an old A response after A to B to A even with the same credential", async () => {
  const { api, opened, saved } = loadPaymentModule({ enableLegacyInFixture: true });
  api.setIdentity("A", null);
  let resolveIntent;
  const checkout = api.beginCheckout({ supabase: { rpc: () => new Promise(resolve => { resolveIntent = resolve; }) } });
  while (!resolveIntent) await Promise.resolve();
  api.setIdentity("B", null);
  api.setIdentity("A", null);
  resolveIntent({ data: { payment_reference: "11111111-2222-4333-8444-555555555555", status: "pending" }, error: null });
  await assert.rejects(checkout, /身份验证失败/);
  assert.equal(opened[0].closed, true);
  assert.equal(opened[0].url, undefined);
  assert.equal(saved.size, 0);
});

test("settings restores its upgrade card on confirmed Free and keeps its Pro card on temporary errors", () => {
  const settings = readFileSync(new URL("../ai_settings.html", import.meta.url), "utf8");
  const document = new JSDOM(settings).window.document;
  const { api } = loadPaymentModule();
  const render = settings.slice(settings.indexOf("    function renderActivated()"), settings.indexOf("    async function recheckSettingsPayment()"));
  vm.runInNewContext(render, { document, window: { SunlandProPayment: api }, updateProSupportLink() {} });
  api.setIdentity("A", null);
  api.applyMembership(true, api.captureRequest());
  assert.equal(document.getElementById("proCard").classList.contains("activated"), true);
  api.markUnavailable();
  assert.equal(document.getElementById("proCard").classList.contains("activated"), true);
  api.applyMembership(false, api.captureRequest());
  assert.equal(document.getElementById("proCard").classList.contains("activated"), false);
  assert.ok(document.querySelector('#proCard [onclick="upgrade()"]'));
  assert.ok(document.getElementById("proRecheckBtn"));
});

test("static settings payment retry labels agree with the shared payment module in all six languages", () => {
  const settings = readFileSync(new URL("../ai_settings.html", import.meta.url), "utf8");
  const catalog = readFileSync(new URL("../p/js/site-i18n-extra.js", import.meta.url), "utf8");
  const runtime = readFileSync(new URL("../p/js/site-i18n.js", import.meta.url), "utf8");
  const dom = new JSDOM(settings, { runScripts: "outside-only", url: "https://sunland.dev/ai_settings.html" });
  dom.window.eval(catalog);
  dom.window.eval(runtime);
  dom.window.eval(source);
  for (const language of ["zh", "zh-Hant", "en", "ja", "ko", "es"]) {
    dom.window.SiteI18n.setLanguage(language, { persist: false });
    assert.equal(dom.window.document.getElementById("proRecheckBtn").textContent,
      dom.window.SunlandProPayment.text("checkStatus"), language);
  }
  dom.window.close();
});


test("disabled merchandise checkout fails closed and its builder binds exact SKU", async () => {
  const { api, opened } = loadPaymentModule();
  let rpcCalled = false;
  await assert.rejects(() => api.createAfdianMerchandiseCheckout({ supabase: { rpc() { rpcCalled = true; } } }), /审核中/);
  assert.equal(opened.length, 0);
  assert.equal(rpcCalled, false);
  const reference = "11111111-2222-4333-8444-555555555555";
  const url = new URL(api.buildMerchandiseCheckoutUrl(reference));
  assert.equal(url.origin, "https://afdian.com");
  assert.equal(url.pathname, "/order/create");
  assert.equal(url.searchParams.get("product_type"), "1");
  assert.equal(url.searchParams.get("plan_id"), "16b23966c0a711f183dc5254001e7c00");
  assert.deepEqual(JSON.parse(url.searchParams.get("sku")), [{ sku_id: "16b98478c0a711f1bb735254001e7c00", count: 1 }]);
  assert.equal(url.searchParams.get("custom_order_id"), reference);
  assert.throws(() => api.buildMerchandiseCheckoutUrl("untrusted-user-id"));
});


test("Production merchandise adapter uses verified intent and rejects unknown intent states", async () => {
  for (const status of ["pending", "cancelled", "unresolved", "unknown"]) {
    const { api, opened } = loadPaymentModule({ enableMerchandiseInFixture: true });
    let calls = 0;
    const options = { expectedUserId: "e736a9426c7311f1851452540025c377", supabase: { rpc: async name => {
      assert.equal(name, "sunland_get_or_create_pro_payment_intent"); calls++;
      return { data: [{ payment_reference: "11111111-2222-4333-8444-555555555555", status }], error: null };
    } } };
    if (status === "pending") {
      const result = await api.createAfdianMerchandiseCheckout(options);
      assert.equal(result.userId, options.expectedUserId);
      assert.equal(new URL(opened[0].url).searchParams.get("product_type"), "1");
      assert.equal(api.getState().state, "UNKNOWN", "checkout navigation cannot activate membership");
    } else {
      await assert.rejects(() => api.createAfdianMerchandiseCheckout(options), /安全付款引用/);
      assert.equal(opened[0].url, undefined);
      assert.equal(opened[0].closed, true);
    }
    assert.equal(calls, 1);
  }
});

test("checkout rejects duplicate calls and closing pending popup prevents intent creation", async () => {
  let identityReady;
  const { api, opened } = loadPaymentModule({ enableLegacyInFixture: true,
    getToken: () => new Promise(resolve => { identityReady = resolve; }) });
  let calls = 0;
  const options = { supabase: { rpc: async () => { calls++; } } };
  const first = api.beginCheckout(options);
  await assert.rejects(() => api.beginCheckout(options), /正在安全连接/);
  assert.equal(opened.length, 1);
  opened[0].closed = true;
  identityReady(databaseToken());
  await assert.rejects(() => first, /无法打开支付窗口/);
  assert.equal(calls, 0);
});
