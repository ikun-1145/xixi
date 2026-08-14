import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(
  new URL("../ai/login-ban-status.js", import.meta.url),
  "utf8",
);

function loadApi() {
  const context = { URL, Error, Object, String };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "login-ban-status.js" });
  return context.SunlandLoginBanStatus;
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test("login ban lookup uses a fresh database token and the caller's own RLS row", async () => {
  const api = loadApi();
  const exchanges = [];
  const requests = [];
  const result = await api.check({
    appToken: "app-token",
    userId: "user-a",
    tokenClient: {
      async exchange(appToken, userId) {
        exchanges.push({ appToken, userId });
        return "database-token";
      },
    },
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return response([{ is_banned: true, ban_reason: "  repeated\nspam\u0000  " }]);
    },
  });

  assert.deepEqual(exchanges, [{ appToken: "app-token", userId: "user-a" }]);
  assert.equal(requests.length, 1);
  const url = new URL(requests[0].url);
  assert.equal(url.pathname, "/rest/v1/user_profiles");
  assert.equal(url.searchParams.get("select"), "is_banned,ban_reason");
  assert.equal(url.searchParams.get("user_id"), "eq.user-a");
  assert.equal(url.searchParams.get("limit"), "1");
  const headers = new Headers(requests[0].init.headers);
  assert.equal(headers.get("authorization"), "Bearer database-token");
  assert.match(headers.get("apikey"), /^sb_publishable_/u);
  assert.equal(result.isBanned, true);
  assert.equal(result.reason, "repeated spam");
});

test("missing profiles remain eligible, while unreadable status fails closed", async () => {
  const api = loadApi();
  const tokenClient = { exchange: async () => "database-token" };
  const allowed = await api.check({
    appToken: "app-token",
    userId: "new-user",
    tokenClient,
    fetchImpl: async () => response([]),
  });
  assert.equal(allowed.isBanned, false);
  assert.equal(allowed.reason, "");

  await assert.rejects(
    api.check({
      appToken: "app-token",
      userId: "user-a",
      tokenClient,
      fetchImpl: async () => response({}, 503),
    }),
    /account-status-unavailable/u,
  );
  await assert.rejects(
    api.check({
      appToken: "app-token",
      userId: "user-a",
      tokenClient,
      fetchImpl: async () => response({ is_banned: false }),
    }),
    /account-status-unavailable/u,
  );
});
