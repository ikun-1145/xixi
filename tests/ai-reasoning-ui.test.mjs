import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  createAssistantHistoryMessage,
  getAssistantReasoning,
} from "../ai/reasoning.js";

const aiApp = fs.readFileSync(new URL("../ai/app.js", import.meta.url), "utf8");
const aiHtml = fs.readFileSync(new URL("../ai.html", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../ai/styles-2.css", import.meta.url), "utf8");
const i18n = fs.readFileSync(new URL("../p/js/site-i18n.js", import.meta.url), "utf8");
const i18nExtra = fs.readFileSync(new URL("../p/js/site-i18n-extra.js", import.meta.url), "utf8");

test("assistant reasoning survives JSON conversation persistence", () => {
  const message = createAssistantHistoryMessage("最终答案", "第一步\n第二步");
  const restored = JSON.parse(JSON.stringify(message));

  assert.deepEqual(restored, {
    role: "assistant",
    content: "最终答案",
    reasoningContent: "第一步\n第二步",
  });
  assert.equal(getAssistantReasoning(restored), "第一步\n第二步");
});

test("blank or untrusted reasoning metadata is ignored", () => {
  assert.deepEqual(createAssistantHistoryMessage("答案", "   "), {
    role: "assistant",
    content: "答案",
  });
  assert.equal(getAssistantReasoning({ role: "user", reasoningContent: "hidden" }), "");
  assert.equal(getAssistantReasoning({ role: "assistant", reasoningContent: 42 }), "");
});

test("deep thinking defaults off and resets for a new chat", () => {
  assert.match(aiApp, /let deepMode = false;/u);
  assert.match(aiApp, /function createNewChat\(\)[\s\S]*?deepMode = false;[\s\S]*?updateDeepButton\(\);/u);
  assert.match(aiHtml, /id="deepBtn" class="mini-btn"[^>]*aria-pressed="false"/u);
  assert.doesNotMatch(aiHtml, /id="deepBtn" class="[^"]*\bactive\b/u);
  assert.match(aiApp, /btn\.setAttribute\("aria-pressed", String\(enabled\)\)/u);
});

test("deep and ordinary thinking use distinct loading indicators", () => {
  assert.match(aiApp, /options\.deepThinking === true[\s\S]*?ensureReasoningDisclosure/u);
  assert.match(aiApp, /uiText\(thinking \? "正在思考" : "思考过程"\)/u);
  assert.match(aiApp, /chevron\.textContent = ">"/u);
  assert.match(aiApp, /if \(requestContext\.deep && delta\.reasoning_content\)/u);
  assert.match(aiApp, /thinking\.className = "thinking"[\s\S]*?dot\.className = "dot"/u);
  assert.match(styles, /\.reasoning-status\.is-thinking\s*\{[^}]*animation: reasoningStatusBlink/su);
  assert.match(styles, /\.thinking \.dot\s*\{[^}]*animation: thinkingFlow/su);
});

test("reasoning is collapsed by default, togglable, compact, and retained after completion", () => {
  assert.match(aiApp, /toggle\.setAttribute\("aria-expanded", "false"\)/u);
  assert.match(aiApp, /content\.hidden = true/u);
  assert.match(aiApp, /toggle\.addEventListener\("click"[\s\S]*?setReasoningExpanded/u);
  assert.match(aiApp, /createAssistantHistoryMessage\(fullText, reasoning\)/u);
  assert.match(aiApp, /renderCompletedDeepSeekResponse\(requestContext, fullText, reasoning\)/u);
  assert.match(aiApp, /getAssistantReasoning\(m\)/u);
  assert.match(styles, /\.reasoning-content\s*\{[^}]*margin: 1px 0 0;[^}]*padding: 0 2px 1px 0;[^}]*white-space: normal;/su);
  assert.match(styles, /\.reasoning-disclosure\s*\{[^}]*line-height: 1\.35;/su);
  assert.match(styles, /\.reasoning-disclosure\.is-expanded \.reasoning-chevron\s*\{[^}]*rotate\(90deg\)/su);
});

test("new reasoning labels are available in all six supported languages", () => {
  assert.match(i18n, /\["正在思考", "Thinking", "思考中"\]/u);
  assert.match(i18n, /\["思考过程", "Reasoning", "思考過程"\]/u);
  for (const label of ["正在思考", "思考过程"]) {
    const start = i18nExtra.indexOf(`"${label}": {`);
    assert.ok(start >= 0, `${label} should exist in the extra catalog`);
    const block = i18nExtra.slice(start, start + 180);
    assert.match(block, /"zh-Hant":/u);
    assert.match(block, /"ko":/u);
    assert.match(block, /"es":/u);
  }
});
