import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { JSDOM } from "../symbolic-ai/node_modules/jsdom/lib/api.js";
import { appendFurryEventMessage } from "../ai/furry-event-cards.js";

const runtimeSource = fs.readFileSync(
  new URL("../p/js/site-i18n.js", import.meta.url),
  "utf8",
);
const additionalCatalogSource = fs.readFileSync(
  new URL("../p/js/site-i18n-extra.js", import.meta.url),
  "utf8",
);

const publicPageTitles = new Map([
  ["index.html", "Frost's Personal Website"],
  ["shoushe.html", "Character Design - Frost"],
  ["banquan.html", "Copyright - Frost"],
  ["guanzhu.html", "Follow Me - Frost"],
  ["lianxi.html", "Contact - Frost"],
  ["comment.html", "Comments - Frost"],
  ["fans.html", "Live Follower Count - Frost"],
  ["game.html", "Mini Game"],
  ["ryugaku.html", "Project 2028 · Study Abroad Plan"],
  ["donate.html", "Support - Frost"],
  ["egg.html", "Hidden Layer · Frost Protocol"],
  ["deep.html", "HiddenLayer Deep"],
  ["login.html", "Sign in to Sunland AI · Beta"],
  ["ai.html", "Sunland AI · Beta"],
  ["ai_settings.html", "Settings - Sunland AI · Beta"],
  ["copilot.html", "HuFuBao · AI Reply Copilot for Furry Communities"],
  ["download.html", "Sunland AI · Beta — Redefining Intelligent Interaction"],
  ["oauth-callback.html", "Signing you in…"],
  ["privacy.html", "Sunland AI · Beta Privacy Policy"],
  ["xukexieyi.html", "Sunland AI · Beta Terms of Service"],
]);

function createDom(html, language = "en") {
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "https://sunland.dev/",
  });
  dom.window.localStorage.setItem("lang", language);
  dom.window.eval(additionalCatalogSource);
  dom.window.eval(runtimeSource);
  dom.window.SiteI18n.setLanguage(language, { persist: false });
  return dom;
}

test("all public pages load the shared language runtime and inherit the saved language", () => {
  for (const [page, expectedTitle] of publicPageTitles) {
    const html = fs.readFileSync(new URL(`../${page}`, import.meta.url), "utf8");
    const additionalCatalog = html.match(
      /<script defer src="p\/js\/site-i18n-extra\.js\?v=[^"]+"><\/script>/u,
    );
    const runtime = html.match(
      /<script defer src="p\/js\/site-i18n\.js\?v=[^"]+"><\/script>/u,
    );
    const additionalCatalogPosition = additionalCatalog?.index ?? -1;
    const runtimePosition = runtime?.index ?? -1;
    assert.ok(additionalCatalogPosition >= 0, `${page} should load the additional language catalog`);
    assert.ok(additionalCatalogPosition < runtimePosition, `${page} should load language data before the runtime`);
    assert.ok(runtimePosition >= 0, `${page} should load the shared i18n runtime`);
    assert.ok(runtimePosition < html.toLowerCase().indexOf("<body"), `${page} should load i18n before its body`);

    const dom = createDom(html, "en");
    assert.equal(dom.window.document.documentElement.lang, "en", `${page} should set html.lang`);
    assert.equal(dom.window.document.title, expectedTitle, `${page} should localize its title`);

    const walker = dom.window.document.createTreeWalker(
      dom.window.document.body,
      dom.window.NodeFilter.SHOW_TEXT,
    );
    const untranslated = new Set();
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement?.closest(
        "script,style,noscript,template,[data-site-i18n-ignore],#langSwitcher,#chatInner,#chatList,#thanksList,#terminal,#boot",
      )) continue;
      const value = (node.nodeValue || "").replace(/\s+/gu, " ").trim();
      if (/\p{Script=Han}/u.test(value)) {
        untranslated.add(value);
      }
    }
    assert.deepEqual([...untranslated], [], `${page} should not leave Chinese interface copy in English mode`);
    dom.window.close();
  }
});

test("language observer yields back to the browser after initialization", { timeout: 3000 }, async () => {
  const projectDirectory = fileURLToPath(new URL("..", import.meta.url));
  const probe = String.raw`
    const fs = require("node:fs");
    const { JSDOM } = require("./symbolic-ai/node_modules/jsdom/lib/api.js");
    const dom = new JSDOM(fs.readFileSync("index.html", "utf8"), {
      runScripts: "outside-only",
      url: "https://sunland.dev/",
    });
    dom.window.eval(fs.readFileSync("p/js/site-i18n-extra.js", "utf8"));
    dom.window.eval(fs.readFileSync("p/js/site-i18n.js", "utf8"));
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
    dom.window.setTimeout(() => {
      process.stdout.write("event-loop-yielded");
      dom.window.close();
    }, 25);
  `;

  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", probe], {
      cwd: projectDirectory,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("site i18n starved the browser event loop"));
    }, 1500);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "event-loop-yielded");
});

test("language changes restore source text and update switcher state", () => {
  const dom = createDom(`<!doctype html>
    <html lang="zh-CN"><body>
      <div id="langSwitcher">
        <button data-lang="zh">中文</button>
        <button data-lang="zh-Hant">繁體中文</button>
        <button data-lang="en">EN</button>
        <button data-lang="ja">日本語</button>
        <button data-lang="ko">한국어</button>
        <button data-lang="es">Español</button>
      </div>
      <h1>关注我们</h1>
      <input placeholder="搜索历史对话">
    </body></html>`, "en");
  const { document, localStorage, SiteI18n } = dom.window;

  assert.equal(document.querySelector("h1").textContent, "Follow Me");
  assert.equal(document.querySelector("input").placeholder, "Search chat history");
  assert.equal(document.querySelector('[data-lang="en"]').getAttribute("aria-pressed"), "true");

  SiteI18n.setLanguage("ja");
  assert.equal(localStorage.getItem("lang"), "ja");
  assert.equal(document.documentElement.lang, "ja");
  assert.equal(document.querySelector("h1").textContent, "フォロー");
  assert.equal(document.querySelector('[data-lang="ja"]').getAttribute("aria-pressed"), "true");

  SiteI18n.setLanguage("zh");
  assert.equal(document.documentElement.lang, "zh-Hans");
  assert.equal(document.querySelector("h1").textContent, "关注我们");

  SiteI18n.setLanguage("zh-TW", { persist: false });
  assert.equal(SiteI18n.getLanguage(), "zh-Hant");
  assert.equal(document.documentElement.lang, "zh-Hant");
  assert.equal(document.querySelector("h1").textContent, "關注我們");
  dom.window.close();
});

test("new languages translate every public page and preserve semantic html language tags", () => {
  const expectations = {
    "zh-Hant": ["zh-Hant", "霜藍的個人主頁"],
    ko: ["ko", "Frost의 개인 웹사이트"],
    es: ["es", "Sitio web personal de Frost"],
  };

  for (const [language, [htmlLanguage, homeTitle]] of Object.entries(expectations)) {
    for (const page of publicPageTitles.keys()) {
      const html = fs.readFileSync(new URL(`../${page}`, import.meta.url), "utf8");
      const dom = createDom(html, language);
      assert.equal(dom.window.document.documentElement.lang, htmlLanguage, `${page} should use ${htmlLanguage}`);
      if (page === "index.html") assert.equal(dom.window.document.title, homeTitle);

      if (language === "ko" || language === "es") {
        const walker = dom.window.document.createTreeWalker(dom.window.document.body, dom.window.NodeFilter.SHOW_TEXT);
        const untranslated = [];
        while (walker.nextNode()) {
          if (walker.currentNode.parentElement?.closest(
            "script,style,noscript,template,[data-site-i18n-ignore],#langSwitcher,#chatInner,#chatList,#thanksList,#terminal,#boot",
          )) continue;
          const value = (walker.currentNode.nodeValue || "").replace(/\s+/gu, " ").trim();
          if (/\p{Script=Han}/u.test(value)) untranslated.push(value);
        }
        assert.deepEqual(untranslated, [], `${page} should not leave Chinese interface copy in ${language}`);
      }
      dom.window.close();
    }
  }
});

test("language dropdown shows six flagged choices and supports keyboard dismissal", () => {
  const menuPages = ["index.html", "shoushe.html", "banquan.html", "comment.html", "lianxi.html"];
  for (const page of menuPages) {
    const pageHtml = fs.readFileSync(new URL(`../${page}`, import.meta.url), "utf8");
    const pageDom = createDom(pageHtml, "ko");
    const pageChoices = [...pageDom.window.document.querySelectorAll(
      '#languageMenu [role="menuitemradio"][data-lang]',
    )];
    assert.equal(pageChoices.length, 6, `${page} should expose all six languages`);
    assert.ok(pageChoices.every(choice => choice.firstElementChild?.matches("img.language-flag")));
    pageDom.window.close();
  }

  for (const flag of ["cn.svg", "gb.svg", "jp.svg", "kr.svg", "es.svg"]) {
    assert.ok(fs.existsSync(new URL(`../p/flags/${flag}`, import.meta.url)), `${flag} should exist locally`);
  }

  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = createDom(html, "zh-Hant");
  const { document, Event, KeyboardEvent } = dom.window;
  document.dispatchEvent(new Event("DOMContentLoaded"));

  const toggle = document.getElementById("languageMenuToggle");
  const menu = document.getElementById("languageMenu");
  const choices = [...menu.querySelectorAll('[role="menuitemradio"][data-lang]')];
  assert.equal(choices.length, 6);
  assert.ok(choices.every(choice => choice.querySelector("img.language-flag")));
  assert.equal(choices.find(choice => choice.dataset.lang === "zh").querySelector("img").src,
    choices.find(choice => choice.dataset.lang === "zh-Hant").querySelector("img").src);
  assert.equal(document.querySelector("[data-language-current-label]").textContent, "繁體中文");

  toggle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  assert.equal(menu.hidden, false);
  assert.equal(document.activeElement, choices[0]);
  menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(menu.hidden, true);
  assert.equal(document.activeElement, toggle);

  toggle.click();
  choices[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
  assert.equal(menu.hidden, true);
  dom.window.close();
});

test("dynamic system UI is localized without rewriting chat content", async () => {
  const dom = createDom(`<!doctype html><html><body>
    <main id="surface"></main>
    <div id="chatInner"><div class="bubble">关注我们</div></div>
    <div id="results">
      <span id="resultLabel">评论分析</span>
      <span id="generatedCopy" data-site-i18n-ignore>关注我们</span>
    </div>
  </body></html>`, "en");
  const { document } = dom.window;

  const dynamicLabel = document.createElement("div");
  dynamicLabel.textContent = "加载中…";
  document.getElementById("surface").appendChild(dynamicLabel);
  await new Promise(resolve => dom.window.queueMicrotask(resolve));

  assert.equal(dynamicLabel.textContent, "Loading…");
  assert.equal(document.querySelector("#chatInner .bubble").textContent, "关注我们");
  assert.equal(document.getElementById("resultLabel").textContent, "Comment analysis");
  assert.equal(document.getElementById("generatedCopy").textContent, "关注我们");
  assert.equal(dom.window.SiteI18n.translate("保留\n未知格式"), "保留\n未知格式");
  dom.window.close();
});

test("legal copy and native dialogs use the same saved language", () => {
  const html = fs.readFileSync(new URL("../privacy.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "https://sunland.dev/privacy.html",
  });
  const dialogs = [];
  dom.window.localStorage.setItem("lang", "ja");
  dom.window.alert = value => dialogs.push(["alert", value]);
  dom.window.confirm = value => {
    dialogs.push(["confirm", value]);
    return true;
  };
  dom.window.eval(additionalCatalogSource);
  dom.window.eval(runtimeSource);
  dom.window.SiteI18n.apply();

  assert.equal(dom.window.document.querySelector("h2").textContent, "1. 収集する情報");
  dom.window.alert("登录已过期，请重新登录");
  assert.equal(dialogs[0][1], "ログインの有効期限が切れました。再度ログインしてください。");
  assert.equal(dom.window.confirm("确定删除这个对话吗？删除后无法恢复。"), true);
  assert.equal(dialogs[1][1], "このチャットを削除しますか？元に戻せません。");
  dom.window.close();
});

test("furry-event cards localize their interface while preserving event data", () => {
  const dom = createDom('<!doctype html><html><body><div id="chatInner"></div></body></html>', "en");
  const previousI18n = globalThis.SiteI18n;
  globalThis.SiteI18n = dom.window.SiteI18n;

  try {
    appendFurryEventMessage({
      target: dom.window.document.getElementById("chatInner"),
      message: {
        furryEvents: [{
          name: "霜蓝兽聚",
          start_at: "2026-09-06T00:00:00.000Z",
          end_at: "2026-09-07T00:00:00.000Z",
          city: "上海",
          address: "测试酒店",
          source_url: "https://events.example.com/detail",
        }],
      },
    });

    const results = dom.window.document.querySelector(".furry-event-results");
    assert.match(results.textContent, /Related furry events/u);
    assert.match(results.textContent, /1 event · Swipe sideways for more/u);
    assert.match(results.textContent, /9\/6–9\/7/u);
    assert.match(results.textContent, /Event details/u);
    assert.match(results.textContent, /霜蓝兽聚/u);
    assert.equal(results.querySelector(".furry-event-track").getAttribute("aria-label"), "1 related furry event");
  } finally {
    if (previousI18n === undefined) delete globalThis.SiteI18n;
    else globalThis.SiteI18n = previousI18n;
    dom.window.close();
  }
});
