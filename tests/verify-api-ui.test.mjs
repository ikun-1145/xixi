import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { JSDOM } from "jsdom";

import { onRequestGet, onRequestPost } from "../functions/api/verify.js";
import { t } from "../verify/i18n.js";
import { renderReport, safeExternalUrl } from "../verify/render.js";

function opinionGateway(remaining = null) {
  return {
    async fetch() {
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"claims":[]}' } }] }), {
        headers: {
          "content-type": "application/json",
          ...(remaining == null ? {} : { "x-remain": String(remaining) }),
        },
      });
    },
  };
}

test("capability endpoint explicitly reports unconfigured web search", async () => {
  const response = await onRequestGet({ env: {} });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.capabilities.search.available, false);
  assert.match(payload.capabilities.search.message, /尚未配置/u);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("capability endpoint reports Tavily without exposing its binding value", async () => {
  const response = await onRequestGet({ env: { TAVILY_API_KEY: "test-only-key" } });
  const body = await response.text();
  const payload = JSON.parse(body);
  assert.equal(response.status, 200);
  assert.deepEqual(payload.capabilities.search, { available: true, provider: "tavily" });
  assert.doesNotMatch(body, /test-only-key/u);
});

test("Tavily search failures have all supported UI translations", () => {
  for (const locale of ["zh", "zh-Hant", "en", "ja", "ko", "es"]) {
    assert.notEqual(t("searchFailed", locale), "searchFailed");
    assert.notEqual(t("searchRateLimited", locale), "searchRateLimited");
  }
});

test("verify API requires authentication and never echoes secrets", async () => {
  const request = new Request("https://sunland.dev/api/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "text", content: "A fact" }),
  });
  const response = await onRequestPost({ request, env: { DEEPSEEK_API_KEY: "must-not-leak" } });
  const body = await response.text();
  assert.equal(response.status, 401);
  assert.doesNotMatch(body, /must-not-leak/u);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("verify API handles pure opinion without a search provider", async () => {
  const request = new Request("https://sunland.dev/api/verify", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer valid-test-token" },
    body: JSON.stringify({ type: "text", content: "我觉得夏天很讨厌。" }),
  });
  const response = await onRequestPost({ request, env: { AI_GATEWAY: opinionGateway() } });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.equal(payload.claims.length, 0);
});

test("verify API supports a bounded claim-extraction stage", async () => {
  const request = new Request("https://sunland.dev/api/verify", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer valid-test-token" },
    body: JSON.stringify({ type: "text", content: "我觉得夏天很讨厌。", stage: "extract" }),
  });
  const gateway = opinionGateway();
  const response = await onRequestPost({ request, env: { AI_GATEWAY: gateway } });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.outcome, "no_claims");
});

test("verify API exposes only the AI gateway's authoritative Pro usage signal", async () => {
  const request = new Request("https://sunland.dev/api/verify", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer valid-test-token" },
    body: JSON.stringify({ type: "text", content: "我觉得夏天很讨厌。", stage: "extract" }),
  });
  const response = await onRequestPost({ request, env: { AI_GATEWAY: opinionGateway(-1) } });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(payload.usage, { unlimited: true });
  assert.doesNotMatch(JSON.stringify(payload), /valid-test-token/u);
});

test("verify API rejects unknown stages before model or search work", async () => {
  const request = new Request("https://sunland.dev/api/verify", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer valid-test-token" },
    body: JSON.stringify({ type: "text", content: "A fact", stage: "unknown" }),
  });
  const response = await onRequestPost({ request, env: {} });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "VERIFY_STAGE_INVALID");
});

test("verify API does not propagate an unsupported incoming request signal to model calls", async () => {
  const incoming = new AbortController();
  incoming.abort();
  const request = {
    headers: new Headers({
      "content-type": "application/json",
      authorization: "Bearer valid-test-token",
    }),
    signal: incoming.signal,
    async json() {
      return { type: "text", content: "我觉得夏天很讨厌。" };
    },
  };
  const gateway = {
    async fetch(modelRequest) {
      assert.equal(modelRequest.signal.aborted, false);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"claims":[]}' } }] }), {
        headers: { "content-type": "application/json" },
      });
    },
  };

  const response = await onRequestPost({ request, env: { AI_GATEWAY: gateway } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).success, true);
});

test("optional request limiter fails closed before model and search calls", async () => {
  const request = new Request("https://sunland.dev/api/verify", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer valid-test-token" },
    body: JSON.stringify({ type: "text", content: "A fact" }),
  });
  const response = await onRequestPost({
    request,
    env: { VERIFY_RATE_LIMITER: { limit: async () => ({ success: false }) } },
  });
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.code, "RATE_LIMITED");
});

test("report renderer treats claims and search content as text and hardens external links", () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://sunland.dev/" });
  const root = dom.window.document.getElementById("root");
  const translate = key => key;
  renderReport(root, {
    overallScore: 50,
    scoreLabel: "<img src=x onerror=alert(1)>",
    summary: "<script>window.pwned=1</script>",
    claims: [{
      claim: '<img src=x onerror="alert(1)">', verdict: "uncertain", credibilityScore: 50,
      confidence: 0.5, reason: "<svg onload=alert(1)>",
      supporting_evidence: [{
        source: "bad", title: "Unsafe title", url: "javascript:alert(1)", reason: "<b>not HTML</b>",
        sourceEvaluation: { grade: "D" },
      }],
      contradicting_evidence: [], limitations: ["<iframe srcdoc=bad>"],
    }],
    limitations: ["<script>alert(1)</script>"],
    searches: [], process: {}, aiDetection: { status: "unknown" },
  }, translate, dom.window.document);

  assert.equal(root.querySelectorAll("script,img,svg,iframe").length, 0);
  assert.match(root.textContent, /<script>window\.pwned=1<\/script>/u);
  assert.equal(root.querySelector("a"), null);
  assert.equal(safeExternalUrl("javascript:alert(1)"), "");
  assert.equal(safeExternalUrl("http://127.0.0.1/private"), "");
  dom.window.close();
});

test("report source links open safely in a new tab", () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://sunland.dev/" });
  const root = dom.window.document.getElementById("root");
  renderReport(root, {
    overallScore: 72, scoreLabel: "偏可信", summary: "Summary",
    claims: [{
      claim: "Claim", verdict: "likely_true", credibilityScore: 72, confidence: 0.8, reason: "Reason",
      supporting_evidence: [{ source: "example.gov", title: "Source", url: "https://example.gov/fact", reason: "Direct", sourceEvaluation: { grade: "A" } }],
      contradicting_evidence: [], limitations: [],
    }],
    limitations: [], searches: [], process: {}, aiDetection: { status: "unknown" },
  }, key => key, dom.window.document);
  const link = root.querySelector("a.source-link");
  assert.equal(link.target, "_blank");
  assert.equal(link.rel, "noopener noreferrer");
  assert.equal(link.href, "https://example.gov/fact");
  dom.window.close();
});

test("verify page is independent, responsive, localized, and does not expose a model key", () => {
  const html = fs.readFileSync(new URL("../verify.html", import.meta.url), "utf8");
  const css = fs.readFileSync(new URL("../verify/verify.css", import.meta.url), "utf8");
  const client = fs.readFileSync(new URL("../verify/verify.js", import.meta.url), "utf8");
  assert.match(html, /p\/css\/tokens\.css/u);
  assert.match(html, /p\/css\/base\.css/u);
  assert.match(html, /site-i18n-extra\.js/u);
  assert.match(html, /site-i18n\.js/u);
  assert.match(html, /role="tabpanel"/u);
  assert.match(css, /@media \(max-width: 760px\)/u);
  assert.match(client, /tesseract\.js@7\.0\.0/u);
  assert.match(client, /runStage\("extract"\)/u);
  assert.match(client, /runStage\("judge", extraction\.claims\)/u);
  assert.match(client, /applyUsage\(extraction\.usage\)/u);
  assert.match(client, /usageState\?\.unlimited \? "proAuthHint" : "authHint"/u);
  assert.doesNotMatch(`${html}\n${client}`, /DEEPSEEK_API_KEY|sk-[A-Za-z0-9]/u);
});

test("verify Pro policy is localized in every supported language", () => {
  for (const locale of ["zh", "zh-Hant", "en", "ja", "ko", "es"]) {
    assert.notEqual(t("proAuthHint", locale), "proAuthHint");
    assert.match(t("proAuthHint", locale), /Pro/u);
  }
});

test("verify page redirects missing local sessions to login before loading its client", () => {
  const html = fs.readFileSync(new URL("../verify.html", import.meta.url), "utf8");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map(match => match[1]);
  const guard = scripts.find(script => script.includes("login.html?return=verify.html"));
  const redirects = [];

  assert.ok(guard);
  assert.ok(html.indexOf(guard) < html.indexOf('verifyScript.src = "verify/verify.js'));
  assert.match(html, /if \(window\.__SUNLAND_VERIFY_AUTH_OK__\)/u);
  const missingSessionContext = {
    localStorage: { getItem() { return null; } },
    location: { replace(target) { redirects.push(target); } },
  };
  missingSessionContext.window = missingSessionContext;
  vm.runInNewContext(guard, missingSessionContext);
  assert.deepEqual(redirects, ["login.html?return=verify.html"]);

  redirects.length = 0;
  const existingSessionContext = {
    localStorage: { getItem() { return "existing-token"; } },
    location: { replace(target) { redirects.push(target); } },
  };
  existingSessionContext.window = existingSessionContext;
  vm.runInNewContext(guard, existingSessionContext);
  assert.deepEqual(redirects, []);
  assert.equal(existingSessionContext.window.__SUNLAND_VERIFY_AUTH_OK__, true);
});

test("verify client redirects sessions that disappear or receive an authentication failure", () => {
  const client = fs.readFileSync(new URL("../verify/verify.js", import.meta.url), "utf8");
  assert.match(client, /function redirectToLogin\(\)/u);
  assert.match(client, /if \(!token\) \{\s*redirectToLogin\(\);/u);
  assert.match(client, /response\.status === 401 \|\| code === "AUTH_REQUIRED"/u);
});
