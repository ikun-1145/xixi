import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("pricing offers Production dual payments, legal and support details in all six languages", async () => {
  for (const language of ["zh", "zh-Hant", "en", "ja", "ko", "es"]) {
    const dom = new JSDOM(read("pricing.html"), { url: "https://sunland.dev/pricing.html", runScripts: "outside-only" });
    const { window } = dom;
    window.fetch = () => { throw new Error("unexpected purchase request"); };
    window.open = () => { throw new Error("unexpected checkout window"); };
    let calls = 0;
    window.SunlandProPayment = { AFDIAN_MERCHANDISE_ENABLED: true, text: () => "Connecting securely", createWaffoCheckout: async () => { calls++; } };
    window.eval(read("p/js/site-i18n-extra.js"));
    window.eval(read("p/js/site-i18n.js"));
    window.SiteI18n.setLanguage(language, { persist: false });
    const purchaseScript = [...window.document.scripts].find(script => script.textContent.includes('document.getElementById("purchaseProBtn").addEventListener'));
    window.eval(purchaseScript.textContent);
    const status = window.document.getElementById("purchaseStatus");
    assert.equal(status.hidden, true);
    window.document.getElementById("purchaseProBtn").click();
    assert.equal(status.hidden, true);
    assert.equal(calls, 0, "choosing a payment method must not create an order");
    window.document.getElementById("cancelPurchaseBtn").click();
    assert.equal(window.document.getElementById("paymentOptions").hidden, true);
    assert.equal(window.document.getElementById("purchaseProBtn").getAttribute("aria-expanded"), "false");
    assert.equal(calls, 0, "cancel must not create checkout or show payment success");
    window.document.getElementById("purchaseProBtn").click();
    assert.equal(window.document.getElementById("paymentOptions").hidden, false);
    const afdian = window.document.getElementById("afdianPurchaseBtn");
    assert.equal(afdian.disabled, false);
    assert.equal(calls, 0, "displaying Production options must not create orders");
    assert.match(afdian.textContent, /¥15 CNY/);
    window.document.getElementById("waffoPurchaseBtn").click();
    assert.equal(status.hidden, false);
    assert.equal(calls, 1);
    assert.equal(window.location.href, "https://sunland.dev/pricing.html");
    assert.ok(status.textContent.trim());
    const content = window.document.querySelector(".container").textContent;
    assert.match(content, /¥15/);
    assert.match(content, /CNY/);
    assert.doesNotMatch(content, /¥10/);
    if (language === "en") assert.match(content, /one-time.*not a subscription.*no auto-renewal/i);
    if (language === "ja") assert.match(content, /買い切り|一回/);
    assert.ok(window.document.querySelector('a[href="mailto:support@sunland.dev"]'));
    assert.ok(window.document.querySelector('a[href="privacy.html"]'));
    assert.ok(window.document.querySelector('a[href="xukexieyi.html"]'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(window.document.getElementById("waffoPurchaseBtn").disabled, false);
    dom.window.close();
  }
});

test("public purchase options contain no legacy checkout links or sponsorship promotion", () => {
  for (const path of ["pricing.html", "pro_activation_support.html", "p/js/site-i18n.js", "p/js/site-i18n-extra.js"]) {
    assert.doesNotMatch(read(path), /afdian\.(com|net)|product_type=0|4c2527fc6c7411f1bbe45254001e7c00/i, path);
  }
  assert.match(read("ai/pro-payment.js"), /const AFDIAN_MERCHANDISE_ENABLED = true;/);
  assert.match(read("ai/pro-payment.js"), /const WAFFO_ENABLED = true;/);
  for (const page of ["index.html"]) {
    assert.match(read(page), /href="pricing\.html"/, `${page} exposes the public pricing path`);
  }
});

test("Production merchandise UI creates an authenticated intent once and waits for server membership", async () => {
  const dom = new JSDOM(read("pricing.html"), {url:"https://sunland.dev/pricing.html",runScripts:"outside-only"});
  const {window}=dom;
  let resolveCheckout, calls=0, monitor;
  const client={rpc(){throw new Error("the adapter owns intent creation");}};
  window.SunlandDatabaseToken={get:()=>"synthetic-authenticated-token"};
  window.supabase={createClient(_url,_key,options){assert.equal(options.accessToken(),"synthetic-authenticated-token");return client;}};
  window.SunlandProPayment={AFDIAN_MERCHANDISE_ENABLED:true,text:key=>key,setIdentity(){},getState:()=>({userId:"test-buyer"}),
    createAfdianMerchandiseCheckout(options){calls++;assert.equal(options.supabase,client);return new Promise(resolve=>{resolveCheckout=resolve;});},
    createWaffoCheckout(){throw new Error("duplicate payment must be blocked");},startActivationMonitoring:options=>{monitor=options;}};
  const script=[...window.document.scripts].find(s=>s.textContent.includes('document.getElementById("purchaseProBtn").addEventListener'));
  window.eval(script.textContent);
  const button=window.document.getElementById("afdianPurchaseBtn");
  button.click();button.click();window.document.getElementById("waffoPurchaseBtn").click();
  assert.equal(calls,1);assert.equal(window.document.getElementById("cancelPurchaseBtn").disabled,true);
  resolveCheckout({userId:"test-buyer"});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(window.document.getElementById("purchaseStatus").textContent,"processing");
  assert.equal(window.location.href,"https://sunland.dev/pricing.html");
  assert.equal(button.disabled,false);assert.ok(monitor);
  monitor.onTimeout();assert.equal(window.document.getElementById("purchaseStatus").textContent,"pending");
  dom.window.close();
});

test("AI upgrade handler always enters public pricing without payment fallback", async () => {
  const app = read("ai/app.js");
  const handler = app.slice(app.indexOf("async function showPayModal()"), app.indexOf("// ===== 设备检测", app.indexOf("async function showPayModal()")));
  const { default: vm } = await import("node:vm");
  const location = { href: "https://sunland.dev/ai.html" };
  await vm.runInNewContext(handler + "showPayModal()", { window: { location, open() { throw new Error("unexpected popup"); } } });
  assert.equal(location.href, "pricing.html");
  assert.doesNotMatch(handler, /afdian|beginCheckout|activated/i);
  assert.match(app, /proBtn\.onclick[\s\S]*?showActivationModal\(\)/);
  assert.match(app, /function showActivationModal\(\)\s*\{[\s\S]*?showPayModal\(\);\s*return;/);
});


test("deep-thinking and Pro-model modal purchase buttons use the review pricing path", async () => {
  const app = read("ai/app.js");
  const { default: vm } = await import("node:vm");
  const route = app.slice(app.indexOf("async function showPayModal()"), app.indexOf("// ===== 设备检测", app.indexOf("async function showPayModal()")));
  for (const [start, end] of [["function showProRequiredModal()", "function showProModelModal()"], ["function showProModelModal()", "let usageVersion = 0;"]]) {
    const dom = new JSDOM("<body></body>", { url: "https://sunland.dev/ai.html" });
    const begin = app.indexOf(start);
    const finish = app.indexOf(end, begin + start.length);
    assert.ok(finish > begin, "modal boundary found");
    const location = { href: "https://sunland.dev/ai.html" };
    const context = vm.createContext({ document: dom.window.document, window: { location },
      setTimeout: callback => callback(), appendProRecheckControl() {} });
    vm.runInContext(route + "function showActivationModal() { showPayModal(); }\n" + app.slice(begin, finish) + start.replace("function ", "") + ";", context);
    const button = dom.window.document.getElementById("openProBtn");
    assert.match(button.textContent, /购买 Pro.*¥15 CNY/);
    button.click();
    assert.equal(location.href, "pricing.html");
    dom.window.close();
  }
});
