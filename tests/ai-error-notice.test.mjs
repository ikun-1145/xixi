import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

import {
  clearChatErrorNotices,
  showChatErrorNotice,
} from "../ai/chat-error-notice.js";

const projectRequire = createRequire(new URL("../package.json", import.meta.url));
const { JSDOM } = projectRequire("jsdom");
const appSource = fs.readFileSync(new URL("../ai/app.js", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../ai/styles-2.css", import.meta.url), "utf8");

function createChatDom() {
  return new JSDOM(`
    <div id="chatInner">
      <div class="message ai" id="failed-response">
        <div class="bubble" style="opacity: 0.8">
          <span class="thinking"><span class="dot"></span></span>
        </div>
      </div>
    </div>
  `);
}

test("request failures replace the AI placeholder with an accessible error notice", () => {
  const dom = createChatDom();
  const { document } = dom.window;
  const chatInner = document.getElementById("chatInner");
  const bubble = document.querySelector(".bubble");

  const notice = showChatErrorNotice({
    target: chatInner,
    bubble,
    message: '<img src=x onerror="alert(1)">请求失败（500），请稍后重试',
  });

  assert.equal(notice.closest(".message").id, "failed-response");
  assert.ok(notice.closest(".message").classList.contains("chat-error"));
  assert.equal(notice.getAttribute("role"), "alert");
  assert.equal(notice.getAttribute("aria-live"), "assertive");
  assert.equal(notice.querySelector(".thinking"), null);
  assert.equal(notice.querySelector("img"), null);
  assert.match(notice.textContent, /请求失败（500）/u);
  assert.equal(notice.getAttribute("style"), null);
});

test("a later thinking state clears only temporary error notices", () => {
  const dom = createChatDom();
  const { document } = dom.window;
  const chatInner = document.getElementById("chatInner");
  const bubble = document.querySelector(".bubble");

  showChatErrorNotice({ target: chatInner, bubble, message: "请求异常，请稍后重试" });
  const normalMessage = document.createElement("div");
  normalMessage.className = "message user";
  chatInner.appendChild(normalMessage);

  clearChatErrorNotices(chatInner);

  assert.equal(chatInner.querySelector(".chat-error"), null);
  assert.equal(normalMessage.isConnected, true);
});

test("HTTP and runtime errors use the temporary error UI instead of assistant history", () => {
  assert.doesNotMatch(
    appSource,
    /appendRequestMessage\([\s\S]{0,180}createAssistantHistoryMessage\(message, reasoning\)[\s\S]{0,180}renderCompletedDeepSeekResponse\(requestContext, message, reasoning\)/u,
  );
  assert.match(appSource, /requestErrorsByConversation\.set\(conversationKey, \{ message \}\)/u);
  assert.match(appSource, /requestErrorsByConversation\.get\(conversationIdKey\(id\)\)/u);
  assert.match(appSource, /requestErrorsByConversation\.delete\(conversationIdKey\(requestContext\.conversationId\)\)/u);
  assert.match(appSource, /clearChatErrorNotices\(chatInner\);[\s\S]*?thinking: true/u);
  const errorStyleStart = styles.indexOf(".message.ai .bubble.chat-error-notice {");
  assert.ok(errorStyleStart >= 0);
  const errorStyle = styles.slice(errorStyleStart, styles.indexOf("}", errorStyleStart));
  assert.match(errorStyle, /background:\s*rgba\(254,\s*226,\s*226,/u);
  assert.match(errorStyle, /border:\s*1px solid rgba\(220,\s*38,\s*38,/u);
});
