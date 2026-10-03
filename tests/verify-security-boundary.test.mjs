import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { onRequestPost } from "../functions/api/verify.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const claims = [{ text: "A public fact", subject: "Agency", type: "event", search_queries: ["public fact"] }];
const usage = { userId: "user-a", date: "2026-10-03", limit: 20, remain: 20, isPro: false };

function request(stage, authorization = "Bearer fixture-signed-token") {
  return new Request("https://example.test/api/verify", {
    method: "POST",
    headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
    body: JSON.stringify({ type: "text", content: "A public fact", stage, claims, user_id: "victim", pro: true }),
  });
}

for (const [label, status, payload, expected] of [
  ["forged token", 401, { error: "Unauthorized" }, 401],
  ["expired token", 401, { error: "Unauthorized" }, 401],
  ["banned", 403, { error: "ACCOUNT_BANNED" }, 401],
  ["deleting", 403, { error: "ACCOUNT_NOT_ACTIVE" }, 401],
  ["retired", 403, { error: "ACCOUNT_NOT_ACTIVE" }, 401],
  ["missing profile", 503, {}, 503],
  ["quota exhausted", 200, { ...usage, remain: 0 }, 429],
  ["malformed quota", 200, { ...usage, remain: "20" }, 503],
  ["forged unlimited value", 200, { ...usage, remain: -1 }, 503],
  ["malformed identity", 200, { ...usage, userId: "../victim" }, 503],
]) {
  test(`${label}: all verify stages reject before any search or AI`, async () => {
    for (const stage of ["judge", "extract", undefined]) {
      let searches = 0, aiCalls = 0, checks = 0;
      globalThis.fetch = async () => { searches++; throw Error("search must not run"); };
      const response = await onRequestPost({ request: request(stage), env: {
        TAVILY_API_KEY: "fixture-search-key", BRAVE_SEARCH_API_KEY: "fixture-fallback-key",
        AI_GATEWAY: { async fetch(req) {
          if (new URL(req.url).pathname !== "/v1/usage") { aiCalls++; throw Error("AI must not run"); }
          checks++;
          assert.equal(req.headers.get("authorization"), "Bearer fixture-signed-token");
          assert.equal(await req.text(), "{}");
          return Response.json(payload, { status });
        } },
      } });
      assert.equal(response.status, expected, String(stage));
      assert.equal(checks, 1);
      assert.equal(searches, 0);
      assert.equal(aiCalls, 0);
    }
  });
}

test("missing or malformed authorization never reaches quota, search or AI", async () => {
  for (const authorization of [null, "Basic fake", "Bearer short", "Bearer a b"]) {
    let externalCalls = 0;
    globalThis.fetch = async () => { externalCalls++; throw Error("must not call"); };
    const response = await onRequestPost({ request: request("judge", authorization), env: {
      TAVILY_API_KEY: "fixture-key",
      AI_GATEWAY: { async fetch() { externalCalls++; throw Error("must not call"); } },
    } });
    assert.equal(response.status, 401);
    assert.equal(externalCalls, 0);
  }
});

test("full pipeline rechecks quota before search when extraction used the last allowance", async () => {
  let checks = 0, aiCalls = 0, searches = 0;
  globalThis.fetch = async () => { searches++; throw Error("search must not run"); };
  const response = await onRequestPost({ request: request(), env: {
    TAVILY_API_KEY: "fixture-key",
    AI_GATEWAY: { async fetch(req) {
      if (new URL(req.url).pathname === "/v1/usage") return Response.json({ ...usage, remain: checks++ === 0 ? 1 : 0 });
      aiCalls++;
      return Response.json({ choices: [{ message: { content: JSON.stringify({ claims }) } }] });
    } },
  } });
  assert.equal(response.status, 429);
  assert.equal(checks, 2);
  assert.equal(aiCalls, 1);
  assert.equal(searches, 0);
});

test("quota service network or malformed response failures reject without search", async () => {
  for (const check of [() => { throw Error("offline"); }, () => new Response("bad JSON")]) {
    let searches = 0;
    globalThis.fetch = async () => { searches++; throw Error("search must not run"); };
    const response = await onRequestPost({ request: request("judge"), env: {
      TAVILY_API_KEY: "fixture-key", AI_GATEWAY: { fetch: check },
    } });
    assert.equal(response.status, 503);
    assert.equal(searches, 0);
  }
});

test("concurrent requests denied by the quota authority all have zero search calls", async () => {
  let searches = 0;
  globalThis.fetch = async () => { searches++; throw Error("search must not run"); };
  const env = { TAVILY_API_KEY: "fixture-key", AI_GATEWAY: { fetch: async () => Response.json({ ...usage, remain: 0 }) } };
  const responses = await Promise.all(Array.from({ length: 10 }, () => onRequestPost({ request: request("judge"), env })));
  assert.ok(responses.every(response => response.status === 429));
  assert.equal(searches, 0);
});
