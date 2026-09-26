import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  appTokenFromRequest,
  verifiedActiveUserId,
} from "../supabase/functions/comment-copilot/verified-identity.js";

const userId = "user-A";
const request = (authorization, body = {}) => new Request("https://example.test", {
  method: "POST",
  headers: authorization === null ? {} : { Authorization: authorization },
  body: JSON.stringify(body),
});
const workerResponse = (status, payload) => new Response(JSON.stringify(payload), { status });

test("verified active application identity is supplied only by the Worker", async () => {
  let calls = 0;
  const result = await verifiedActiveUserId(request("Bearer valid-token", { user_id: "victim" }),
    async (url, options) => {
      calls += 1;
      assert.equal(url, "https://api.sunland.dev/v1/account/identity");
      assert.equal(options.method, "POST");
      assert.equal(options.headers.Authorization, "Bearer valid-token");
      assert.equal(options.body, "{}");
      return workerResponse(200, { user_id: userId, identity_status: "active" });
    });
  assert.deepEqual(result, { userId, status: 200 });
  assert.equal(calls, 1);
});

for (const [label, header] of [
  ["missing token", null],
  ["malformed header", "Basic abc"],
  ["empty bearer", "Bearer  "],
  ["token with whitespace", "Bearer a b"],
]) {
  test(`${label} never reaches identity service`, async () => {
    const result = await verifiedActiveUserId(request(header), () => {
      throw new Error("must not call");
    });
    assert.deepEqual(result, { userId: null, status: 401 });
  });
}

for (const [label, token] of [
  ["malformed JWT", "not-a-jwt"],
  ["two-part JWT", "header.payload"],
  ["invalid base64", "%.%.%"],
  ["alg none", "eyJhbGciOiJub25lIn0.e30."],
  ["wrong signature", "header.payload.wrong"],
  ["modified victim payload with original signature", "header.victim.original"],
  ["expired token", "expired"],
  ["future nbf token", "future-nbf"],
  ["wrong issuer token", "wrong-issuer"],
  ["wrong audience token", "wrong-audience"],
]) {
  test(`${label} is rejected when the Worker rejects it`, async () => {
    const result = await verifiedActiveUserId(request(`Bearer ${token}`),
      async (_url, options) => {
        assert.equal(options.headers.Authorization, `Bearer ${token}`);
        return workerResponse(401, { error: "Unauthorized" });
      });
    assert.deepEqual(result, { userId: null, status: 401 });
  });
}

for (const [label, payload] of [
  ["missing user ID", { identity_status: "active" }],
  ["empty user ID", { identity_status: "active", user_id: "" }],
  ["invalid user ID", { identity_status: "active", user_id: "../victim" }],
  ["inactive user", { identity_status: "deleting", user_id: userId }],
]) {
  test(`${label} in identity response fails closed`, async () => {
    const result = await verifiedActiveUserId(request("Bearer signed"),
      async () => workerResponse(200, payload));
    assert.deepEqual(result, { userId: null, status: 503 });
  });
}

test("deleting or retired identity is rejected by Worker", async () => {
  const result = await verifiedActiveUserId(request("Bearer signed"),
    async () => workerResponse(403, { error: "ACCOUNT_NOT_ACTIVE" }));
  assert.deepEqual(result, { userId: null, status: 403 });
});

test("nonexistent identity is rejected by Worker", async () => {
  const result = await verifiedActiveUserId(request("Bearer signed"),
    async () => workerResponse(503, { error: "User status unavailable" }));
  assert.deepEqual(result, { userId: null, status: 503 });
});

test("forged pro/admin claims never become authority", async () => {
  const result = await verifiedActiveUserId(request("Bearer forged-claims", {
    user_id: "victim", pro: true, role: "admin",
  }), async () => workerResponse(200, { user_id: userId, identity_status: "active" }));
  assert.deepEqual(result, { userId, status: 200 });
});

test("a replayed valid token is accepted while active and rejected after deletion", async () => {
  const req = request("Bearer signed");
  const active = await verifiedActiveUserId(req,
    async () => workerResponse(200, { user_id: userId, identity_status: "active" }));
  const deleting = await verifiedActiveUserId(req,
    async () => workerResponse(403, { error: "ACCOUNT_NOT_ACTIVE" }));
  assert.equal(active.userId, userId);
  assert.equal(deleting.userId, null);
});

test("Bearer header is case and outer-whitespace tolerant; alternate header is supported", () => {
  assert.equal(appTokenFromRequest(request("  bEaReR   signed  ")), "signed");
  assert.equal(appTokenFromRequest(new Request("https://example.test", {
    headers: { "x-sunland-token": " signed " },
  })), "signed");
});

test("identity service errors and malformed JSON fail closed", async () => {
  const req = request("Bearer signed");
  assert.deepEqual(await verifiedActiveUserId(req, async () => { throw Error("offline"); }),
    { userId: null, status: 503 });
  assert.deepEqual(await verifiedActiveUserId(req, async () => new Response("not JSON")),
    { userId: null, status: 503 });
});

test("Edge verifies before constructing the service-role client", () => {
  const source = readFileSync(new URL("../supabase/functions/comment-copilot/index.ts", import.meta.url), "utf8");
  assert.ok(source.indexOf("await verifiedActiveUserId(req)") < source.indexOf("const admin = createClient("));
  assert.doesNotMatch(source, /function decodeJwt\(/);
});
