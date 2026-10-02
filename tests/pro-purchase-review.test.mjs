import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("pricing purchase calls the Production adapter and retains price, legal and support details in all six languages", () => {
  for (const language of ["zh", "zh-Hant", "en", "ja", "ko", "es"]) {
    const dom = new JSDOM(read("pricing.html"), { url: "https://sunland.dev/pricing.html", runScripts: "outside-only" });
    const { window } = dom;
    window.fetch = () => { throw new Error("unexpected purchase request"); };
    window.open = () => { throw new Error("unexpected checkout window"); };
    let calls = 0;
    window.SunlandProPayment = { text: () => "Connecting securely", createWaffoCheckout: async () => { calls++; } };
    window.eval(read("p/js/site-i18n-extra.js"));
    window.eval(read("p/js/site-i18n.js"));
    window.SiteI18n.setLanguage(language, { persist: false });
    const purchaseScript = [...window.document.scripts].find(script => script.textContent.includes('document.getElementById("purchaseProBtn").addEventListener'));
    window.eval(purchaseScript.textContent);
    const status = window.document.getElementById("purchaseStatus");
    assert.equal(status.hidden, true);
    window.document.getElementById("purchaseProBtn").click();
    assert.equal(status.hidden, false);
    assert.equal(calls, 1);
    assert.equal(window.location.href, "https://sunland.dev/pricing.html");
    assert.ok(status.textContent.trim());
    const content = window.document.querySelector(".container").textContent;
    assert.match(content, /¥15/);
    assert.match(content, /CNY/);
    assert.doesNotMatch(content, /¥10|Afdian|爱发电|愛發電|愛発電/i);
    if (language === "en") assert.match(content, /one-time.*not a subscription.*no auto-renewal/i);
    if (language === "ja") assert.match(content, /買い切り|一回/);
    assert.ok(window.document.querySelector('a[href="mailto:support@sunland.dev"]'));
    assert.ok(window.document.querySelector('a[href="privacy.html"]'));
    assert.ok(window.document.querySelector('a[href="xukexieyi.html"]'));
    dom.window.close();
  }
});

test("public support and purchasing translations contain no former payment-provider promotion", () => {
  for (const path of ["pricing.html", "pro_activation_support.html", "p/js/site-i18n.js", "p/js/site-i18n-extra.js"]) {
    assert.doesNotMatch(read(path), /Afdian|爱发电|愛發電|愛発電|afdian\.(com|net)/i, path);
  }
  for (const page of ["index.html"]) {
    assert.match(read(page), /href="pricing\.html"/, `${page} exposes the public pricing path`);
  }
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
