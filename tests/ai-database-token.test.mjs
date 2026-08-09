import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(
  new URL("../ai/database-token-client.js", import.meta.url),
  "utf8",
);

function jwt(claims) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}.signature`;
}

function runtime({ appToken, fetchImpl }) {
  const values = new Map([["token", appToken]]);
  const listeners = [];
  const context = {
    fetch: fetchImpl,
    Headers,
    Date,
    Promise,
    Error,
    Object,
    JSON,
    String,
    Math,
    atob: value => Buffer.from(value, "base64").toString("binary"),
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: key => values.delete(key),
    },
    addEventListener: (type, listener) => listeners.push({ type, listener }),
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "database-token-client.js" });
  return { api: context.SunlandDatabaseToken, values, listeners };
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test("database token is validated, cached and bound to the current application user", async () => {
  const now = Math.floor(Date.now() / 1000);
  const appToken = jwt({ id: "user-a", exp: now + 3600 });
  const databaseToken = jwt({
    id: "user-a",
    sub: "user-a",
    role: "authenticated",
    aud: "authenticated",
    exp: now + 900,
  });
  const calls = [];
  const instance = runtime({
    appToken,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response({ token: databaseToken, expiresIn: 900 });
    },
  });

  assert.equal(await instance.api.get(), databaseToken);
  assert.equal(await instance.api.get(), databaseToken);
  assert.equal(calls.length, 1);
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), `Bearer ${appToken}`);
});

test("expired or cross-user database tokens are rejected", async () => {
  const now = Math.floor(Date.now() / 1000);
  const appToken = jwt({ id: "user-a", exp: now + 3600 });
  for (const claims of [
    { id: "user-a", role: "authenticated", aud: "authenticated", exp: now - 1 },
    { id: "user-b", role: "authenticated", aud: "authenticated", exp: now + 900 },
  ]) {
    const instance = runtime({
      appToken,
      fetchImpl: async () => response({ token: jwt(claims), expiresIn: 900 }),
    });
    await assert.rejects(instance.api.get(), /invalid-database-token/u);
  }
});

test("a user switch during a 401 never refreshes over the new user's token", async () => {
  const now = Math.floor(Date.now() / 1000);
  const appA = jwt({ id: "user-a", exp: now + 3600 });
  const appB = jwt({ id: "user-b", exp: now + 3600 });
  let instance;
  const calls = [];
  instance = runtime({
    appToken: appA,
    fetchImpl: async (url) => {
      calls.push(url);
      instance.values.set("token", appB);
      return response({}, 401);
    },
  });

  await assert.rejects(instance.api.get(), /identity-changed/u);
  assert.equal(instance.values.get("token"), appB);
  assert.deepEqual(calls, ["https://api.sunland.dev/v1/database-token"]);
});

test("clearing during an in-flight exchange cannot cache the previous user's token", async () => {
  const now = Math.floor(Date.now() / 1000);
  const appA = jwt({ id: "user-a", exp: now + 3600 });
  const appB = jwt({ id: "user-b", exp: now + 3600 });
  const databaseA = jwt({ id: "user-a", role: "authenticated", aud: "authenticated", exp: now + 900 });
  const databaseB = jwt({ id: "user-b", role: "authenticated", aud: "authenticated", exp: now + 900 });
  let finishA;
  let calls = 0;
  const instance = runtime({
    appToken: appA,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return await new Promise(resolve => { finishA = resolve; });
      }
      return response({ token: databaseB, expiresIn: 900 });
    },
  });

  const stale = instance.api.get();
  instance.values.set("token", appB);
  instance.api.clear();
  const fresh = instance.api.get();
  finishA(response({ token: databaseA, expiresIn: 900 }));

  await assert.rejects(stale, /identity-changed/u);
  assert.equal(await fresh, databaseB);
  assert.equal(await instance.api.get(), databaseB);
  assert.equal(calls, 2);
});
