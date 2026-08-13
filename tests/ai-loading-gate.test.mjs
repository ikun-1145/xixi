import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const aiHtml = fs.readFileSync(new URL("../ai.html", import.meta.url), "utf8");
const aiApp = fs.readFileSync(new URL("../ai/app.js", import.meta.url), "utf8");
const aiBrowserHarness = fs.readFileSync(
  new URL("./fixtures/ai-app-browser-harness.html", import.meta.url),
  "utf8",
);

function getLoadingBootstrap() {
  const scripts = [...aiHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  return scripts.find(script => script.includes("window.__SUNLAND_AI_RESOURCES_READY__"));
}

function createElement() {
  const attributes = new Map();
  const classes = new Set();
  return {
    classList: {
      add(...names) { names.forEach(name => classes.add(name)); },
      contains(name) { return classes.has(name); },
      remove(...names) { names.forEach(name => classes.delete(name)); },
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
    },
    getAttribute(name) { return attributes.get(name) ?? null; },
    hasClass(name) { return classes.has(name); },
    remove() { this.removed = true; },
    removeAttribute(name) { attributes.delete(name); },
    setAttribute(name, value) { attributes.set(name, String(value)); },
  };
}

test("ai loading shell applies the night theme before the body is rendered", async () => {
  const root = createElement();
  const themeColor = { content: "#71f8fc" };
  const listeners = new Map();
  class NightDate extends Date {
    getHours() { return 22; }
  }
  const context = {
    Date: NightDate,
    Promise,
    document: {
      body: null,
      documentElement: root,
      readyState: "loading",
      querySelector(selector) {
        return selector === 'meta[name="theme-color"]' ? themeColor : null;
      },
      getElementById() { return null; },
    },
    requestAnimationFrame(callback) { callback(); },
    setTimeout() {},
    window: {
      addEventListener(name, callback) { listeners.set(name, callback); },
    },
  };
  context.window.window = context.window;
  context.window.document = context.document;
  context.window.requestAnimationFrame = context.requestAnimationFrame;
  context.window.setTimeout = context.setTimeout;

  vm.runInNewContext(getLoadingBootstrap(), context);

  assert.equal(root.hasClass("night"), true);
  assert.equal(themeColor.content, "#020617");
  assert.equal(typeof listeners.get("load"), "function");
  listeners.get("load")();
  await context.window.__SUNLAND_AI_RESOURCES_READY__;
});

test("ai loading shell keeps the app inert until the ready signal reveals it", () => {
  const root = createElement();
  root.classList.add("preload", "app-loading");
  const body = createElement();
  body.classList.add("preload");
  body.setAttribute("aria-busy", "true");
  const app = createElement();
  app.setAttribute("aria-hidden", "true");
  app.setAttribute("inert", "");
  const loading = createElement();
  const loadingText = { textContent: "加载中..." };
  const elements = { app, aiBootScreen: loading, appLoadingText: loadingText };
  const context = {
    Date,
    Promise,
    document: {
      body,
      documentElement: root,
      readyState: "complete",
      querySelector() { return { content: "#71f8fc" }; },
      getElementById(id) { return elements[id] ?? null; },
    },
    requestAnimationFrame(callback) { callback(); },
    setTimeout(callback, delay) {
      if (delay < 1000) callback();
    },
    window: { addEventListener() {} },
  };
  context.window.window = context.window;
  context.window.document = context.document;
  context.window.requestAnimationFrame = context.requestAnimationFrame;
  context.window.setTimeout = context.setTimeout;

  vm.runInNewContext(getLoadingBootstrap(), context);
  context.window.__SUNLAND_AI_REVEAL__();

  assert.equal(app.getAttribute("aria-hidden"), null);
  assert.equal(app.getAttribute("inert"), null);
  assert.equal(body.getAttribute("aria-busy"), null);
  assert.equal(root.hasClass("app-loading"), false);
  assert.equal(root.hasClass("app-ready"), true);
  assert.equal(loading.hasClass("is-hidden"), true);
  assert.equal(loading.removed, true);
});

test("ai app waits for resources and restored user state before revealing", () => {
  const supabaseReadyIndex = aiApp.indexOf("await supabaseReady;");
  const loginReadyIndex = aiApp.indexOf("await checkLogin({ waitForUserState: true });");
  const resourceReadyIndex = aiApp.indexOf("window.__SUNLAND_AI_RESOURCES_READY__");
  const revealIndex = aiApp.indexOf("window.__SUNLAND_AI_REVEAL__?.();");

  assert.ok(supabaseReadyIndex > -1);
  assert.ok(loginReadyIndex > supabaseReadyIndex);
  assert.ok(resourceReadyIndex > loginReadyIndex);
  assert.ok(revealIndex > resourceReadyIndex);
  assert.match(aiApp, /await Promise\.allSettled\(\[profileRequest, activationRequest\]\)/);
  assert.match(aiApp, /currentChatRender/);
  assert.match(aiHtml, /<div id="app" aria-hidden="true" inert>/);
  assert.match(aiHtml, /appScript\.addEventListener\("error"/);
  assert.match(aiHtml, /}, 15000\);/);
  assert.match(aiBrowserHarness, /refreshDelayMs/);
  assert.match(aiBrowserHarness, /document\.documentElement\.className = shell\.documentElement\.className/);
});
