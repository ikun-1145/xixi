import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { classifyAiHttpError, classifyAiResponseError } from "../ai/ai-request-errors.js";

function response(status, payload, contentType = "application/json") {
  return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), {
    status,
    headers: { "content-type": contentType },
  });
}

test("only explicit quota limit triggers the daily-limit modal", async () => {
  const limit = await classifyAiResponseError(response(429, { error: "LIMIT" }));
  assert.equal(limit.showLimitModal, true);
  assert.match(limit.message, /今天的使用次数/);
  for (const code of ["Too Many Requests", "QUOTA_BUSY", "UPSTREAM_RATE_LIMIT", null]) {
    const result = await classifyAiResponseError(response(429, { error: code }));
    assert.equal(result.showLimitModal, false, String(code));
    assert.match(result.message, /频繁|限流/);
  }
});

test("known uncertain quota and model outcomes discourage duplicate submissions", async () => {
  for (const code of ["MODEL_OUTCOME_UNKNOWN", "QUOTA_COMMIT_UNKNOWN", "QUOTA_RELEASE_UNKNOWN"]) {
    const result = await classifyAiResponseError(response(503, { error: code }));
    assert.match(result.message, /避免重复发送/, code);
    assert.equal(result.showLimitModal, false);
  }
});

test("request conflict does not masquerade as a daily usage limit", async () => {
  const result = await classifyAiResponseError(response(409, { error: "REQUEST_IN_FLIGHT" }));
  assert.match(result.message, /正在处理/);
  assert.equal(result.showLimitModal, false);
});

test("direct upstream 402 is distinct; mapped 503 stays generic without evidence", async () => {
  const direct = await classifyAiResponseError(response(402, { error: "payment_required" }));
  const mapped = await classifyAiResponseError(response(503, { error: "服务暂时不可用" }));
  assert.match(direct.message, /上游服务额度/);
  assert.doesNotMatch(mapped.message, /额度/);
});

test("untrusted and malformed response bodies are never rendered or logged", async () => {
  const confidential = "sensitive upstream account balance: sk-secret-example";
  const invalid = await classifyAiResponseError(response(503, confidential, "application/json"));
  const embedded = await classifyAiResponseError(response(502, { error: { code: confidential, message: confidential } }));
  const html = await classifyAiResponseError(response(502, "<p>" + confidential + "</p>", "text/html"));
  for (const outcome of [invalid, embedded, html]) {
    assert.doesNotMatch(outcome.message, /sensitive|sk-secret-example/);
    assert.equal(outcome.showLimitModal, false);
  }
});

test("missing response, authorization, and generic errors always return safe values", async () => {
  assert.deepEqual(await classifyAiResponseError(null), classifyAiHttpError(undefined));
  assert.match((await classifyAiResponseError(response(401, { error: "Unauthorized" }))).message, /重新登录/);
  assert.match((await classifyAiResponseError(response(400, { error: "bad input" }))).message, /请求失败/);
  assert.match((await classifyAiResponseError(response(403, { error: "PRO_REQUIRED" }))).message, /Pro/);
});

test("chat page uses safe classification rather than logging upstream response bodies", () => {
  const app = fs.readFileSync(new URL("../ai/app.js", import.meta.url), "utf8");
  const block = app.split("async function runDeepSeekRequest(requestContext) {")[1]?.split("const lastRealSendByConversation")[0];
  assert.ok(block, "DeepSeek request handler must exist");
  assert.match(block, /await classifyAiResponseError\(res\)/u);
  assert.doesNotMatch(block, /console\.error\("API错误:",\s*res\.status,\s*errText\)/u);
});

test("all user-facing classifications are present in the shared site i18n catalog", () => {
  const source = fs.readFileSync(new URL("../p/js/site-i18n.js", import.meta.url), "utf8");
  const statuses = [
    [429, "LIMIT"], [429, null], [409, "REQUEST_IN_FLIGHT"],
    [503, "MODEL_OUTCOME_UNKNOWN"], [402, null], [503, null],
    [403, "PRO_REQUIRED"], [401, null], [400, null],
  ];
  for (const [status, code] of statuses) {
    const message = classifyAiHttpError(status, code).message;
    assert.ok(source.includes(`[${JSON.stringify(message)},`), `missing translation: ${message}`);
  }
});
test("live Worker 147 returns distinct quota, KV, and upstream 429 responses", async () => {
  const cases = [
    { payload: { error: "LIMIT", remain: 0, isPro: false }, quotaExhausted: true },
    { payload: { error: "Too Many Requests" }, quotaExhausted: false },
    { payload: { error: "AI服务繁忙，请稍后重试" }, quotaExhausted: false },
  ];
  for (const { payload, quotaExhausted } of cases) {
    const result = await classifyAiResponseError(response(429, payload));
    assert.equal(result.showLimitModal, quotaExhausted, String(payload.error));
    assert.doesNotMatch(result.message, /Too Many Requests|AI服务繁忙/u);
  }
});

test("live Worker 147 conflict and unknown-outcome codes remain non-retrying hints", async () => {
  for (const code of ["REQUEST_COMMITTED", "REQUEST_IN_FLIGHT", "REQUEST_CONFLICT"]) {
    const result = await classifyAiResponseError(response(409, { error: code }));
    assert.equal(result.showLimitModal, false);
    assert.match(result.message, /避免重复发送/u, code);
  }
  for (const code of ["MODEL_OUTCOME_UNKNOWN", "QUOTA_COMMIT_UNKNOWN", "QUOTA_RELEASE_UNKNOWN"]) {
    const result = await classifyAiResponseError(response(503, { error: code }));
    assert.equal(result.showLimitModal, false);
    assert.match(result.message, /避免重复发送/u, code);
  }
  for (const code of ["QUOTA_BUSY", "QUOTA_UNAVAILABLE", "AI_MAINTENANCE"]) {
    const result = await classifyAiResponseError(response(503, { error: code }));
    assert.equal(result.showLimitModal, false);
    assert.match(result.message, /暂时不可用/u, code);
  }
  // The live Worker deliberately maps an upstream HTTP 402 to a generic 503.
  // The frontend must not invent billing/credit explanations from this alone.
  const mapped402 = await classifyAiResponseError(response(503, { error: "服务暂时不可用" }));
  assert.doesNotMatch(mapped402.message, /上游.*额度/u);
});
