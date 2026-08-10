import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { SunlandProvider } from "../ai/providers/SunlandProvider.js";
import {
  ensureSunlandLegacyMigration,
  preserveSunlandLegacyState,
} from "../ai/sunland-legacy-migration.js";
import { IdentityAuthority } from "../ai/verified-identity.js";
import { SUNLAND_LOGIN_STATE_MESSAGE } from "../ai/user-identity.js";

function tokenFor(userId) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "test" })}.${encode({
    sub: userId,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}.signature`;
}

async function identityFor(userId) {
  const token = tokenFor(userId);
  const authority = new IdentityAuthority({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ token, user: { id: userId } }),
    }),
  });
  return (await authority.resolve({ token })).identity;
}

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, String(value)]));
  const reads = [];
  const writes = [];
  return {
    reads,
    writes,
    getItem(key) {
      reads.push(key);
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      writes.push(key);
      values.set(key, String(value));
    },
    removeItem(key) {
      writes.push(key);
      values.delete(key);
    },
    get(key) {
      return values.get(key);
    },
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test("remote Provider migrates legacy state before the first turn and binds both calls to the captured identity", async () => {
  const userId = "remote-user-a";
  const identity = await identityFor(userId);
  const storage = createStorage({
    [`sunland_knowledge_${userId}`]: JSON.stringify([
      { id: "fact-1", subject: "猫", relation: "属于", object: "动物", negated: false },
    ]),
    [`sunland_knowledge_${userId}::memory`]: JSON.stringify([
      { id: "memory-1", key: "name", value: "小蓝", updatedAt: "2026-08-08T00:00:00.000Z" },
    ]),
    [`conversations_${userId}`]: JSON.stringify([
      {
        id: "conversation-1",
        provider: "sunland",
        semanticContext: { schemaVersion: 1, version: 2, recentTurns: [] },
      },
      { id: "deepseek-1", provider: "deepseek", semanticContext: { keep: true } },
    ]),
  });
  const calls = [];
  const provider = new SunlandProvider({
    storage,
    sendRequest: async (path, init, auth) => {
      calls.push({ path, init, auth, body: JSON.parse(init.body) });
      if (path.includes("migrations")) {
        return jsonResponse({ migrationId: calls.at(-1).body.migrationId, status: "complete" });
      }
      return jsonResponse({ response: "远程回答", observationSummary: { intents: { query: 1 } } });
    },
  });
  const deltas = [];
  const signal = new AbortController().signal;
  const result = await provider.send({
    conversation: { id: "conversation-1", userId, provider: "sunland" },
    messages: [{ role: "user", content: "猫是什么" }],
    identity,
    turnId: "turn-1",
    observationMode: "summary",
    signal,
    onDelta: value => deltas.push(value),
  });

  assert.deepEqual(calls.map(call => call.path), ["/v1/migrations/local-state", "/v1/turns"]);
  assert.deepEqual(calls.map(call => call.auth.userId), [userId, userId]);
  assert.deepEqual(calls.map(call => call.auth.token), [tokenFor(userId), tokenFor(userId)]);
  assert.equal(calls[0].body.knowledge.length, 1);
  assert.equal(calls[0].body.memory.length, 1);
  assert.equal(calls[0].body.contexts[0].context.version, 2);
  assert.deepEqual(calls[1].body, {
    conversationId: "conversation-1",
    turnId: "turn-1",
    input: "猫是什么",
    observationMode: "summary",
  });
  assert.equal(calls[1].init.signal, signal);
  assert.equal(result.content, "远程回答");
  assert.deepEqual(result.observationSummary, { intents: { query: 1 } });
  assert.deepEqual(deltas, ["远程回答"]);
  assert.equal(storage.get(`sunland_knowledge_${userId}`), undefined);
  assert.equal(storage.get(`sunland_knowledge_${userId}::memory`), undefined);
  const conversations = JSON.parse(storage.get(`conversations_${userId}`));
  assert.equal("semanticContext" in conversations[0], false);
  assert.deepEqual(conversations[1].semanticContext, { keep: true });
});

test("migration is idempotent and skips a second upload after a matching receipt", async () => {
  const userId = "migration-replay-user";
  const identity = await identityFor(userId);
  const storage = createStorage({ [`conversations_${userId}`]: "[]" });
  let uploads = 0;
  const sendRequest = async (_path, init) => {
    uploads += 1;
    const body = JSON.parse(init.body);
    return jsonResponse({ migrationId: body.migrationId, status: "complete" });
  };

  assert.equal((await ensureSunlandLegacyMigration({ identity, storage, sendRequest })).ok, true);
  assert.deepEqual(await ensureSunlandLegacyMigration({ identity, storage, sendRequest }), {
    ok: true,
    reused: true,
  });
  assert.equal(uploads, 1);
});

test("legacy snapshot survives hydration and receipt cleanup preserves newer conversations", async () => {
  const userId = "migration-snapshot-user";
  const identity = await identityFor(userId);
  const conversationsKey = `conversations_${userId}`;
  const storage = createStorage({
    [conversationsKey]: JSON.stringify([{
      id: "conversation-1",
      provider: "sunland",
      semanticContext: { schemaVersion: 1, version: 1, recentTurns: [] },
    }]),
  });
  preserveSunlandLegacyState({ identity, storage });
  storage.setItem(conversationsKey, JSON.stringify([{
    id: "conversation-1",
    provider: "sunland",
    title: "newer title",
    semanticContext: { schemaVersion: 1, version: 2, recentTurns: [] },
  }]));
  let uploaded;
  const result = await ensureSunlandLegacyMigration({
    identity,
    storage,
    sendRequest: async (_path, init) => {
      uploaded = JSON.parse(init.body);
      return jsonResponse({ migrationId: uploaded.migrationId, status: "complete" });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(uploaded.contexts[0].context.version, 1);
  const current = JSON.parse(storage.get(conversationsKey));
  assert.equal(current[0].title, "newer title");
  assert.equal("semanticContext" in current[0], false);
});

test("failed and mismatched migration receipts retain all local data and the stable migration id", async () => {
  const userId = "migration-retain-user";
  const identity = await identityFor(userId);
  const key = `sunland_knowledge_${userId}`;
  const storage = createStorage({
    [key]: "[]",
    [`${key}::memory`]: "[]",
    [`conversations_${userId}`]: "[]",
  });
  const first = await ensureSunlandLegacyMigration({
    identity,
    storage,
    sendRequest: async () => jsonResponse({ migrationId: "wrong", status: "complete" }),
  });
  const marker = JSON.parse(storage.get(`sunland_remote_migration_${userId}`));
  const secondBodies = [];
  const second = await ensureSunlandLegacyMigration({
    identity,
    storage,
    sendRequest: async (_path, init) => {
      secondBodies.push(JSON.parse(init.body));
      return jsonResponse({}, 503);
    },
  });

  assert.equal(first.reason, "invalid-receipt");
  assert.equal(second.reason, "remote-failure");
  assert.equal(secondBodies[0].migrationId, marker.migrationId);
  assert.equal(storage.get(key), "[]");
  assert.equal(storage.get(`${key}::memory`), "[]");
  assert.equal(storage.get(`conversations_${userId}`), "[]");
});

test("damaged legacy data remains untouched and is surfaced as a recovery warning", async () => {
  const userId = "damaged-legacy-user";
  const identity = await identityFor(userId);
  const key = `sunland_knowledge_${userId}`;
  const storage = createStorage({ [key]: "{damaged", [`conversations_${userId}`]: "[]" });
  const calls = [];
  const provider = new SunlandProvider({
    storage,
    sendRequest: async (path) => {
      calls.push(path);
      return jsonResponse({ response: "仍可远程回答" });
    },
  });
  const result = await provider.send({
    conversation: { id: "conversation-damaged", userId },
    messages: [{ role: "user", content: "你好" }],
    identity,
    turnId: "turn-damaged",
  });

  assert.deepEqual(calls, ["/v1/turns"]);
  assert.match(result.migrationWarning, /损坏.*保留/u);
  assert.equal(storage.get(key), "{damaged");
});

test("invalid or cross-user identity is blocked before storage and network access", async () => {
  const identity = await identityFor("identity-user-a");
  const storage = createStorage();
  let networkCalls = 0;
  const provider = new SunlandProvider({
    storage,
    sendRequest: async () => {
      networkCalls += 1;
      return jsonResponse({ response: "unexpected" });
    },
  });
  const deltas = [];
  const result = await provider.send({
    conversation: { id: "cross-user", userId: "identity-user-b" },
    messages: [{ role: "user", content: "不应发送" }],
    identity,
    onDelta: value => deltas.push(value),
  });

  assert.equal(result.blocked, true);
  assert.equal(result.content, SUNLAND_LOGIN_STATE_MESSAGE);
  assert.deepEqual(deltas, [SUNLAND_LOGIN_STATE_MESSAGE]);
  assert.equal(networkCalls, 0);
  assert.deepEqual(storage.reads, []);
  assert.deepEqual(storage.writes, []);
});

test("an already-aborted request performs no migration, network or UI write", async () => {
  const userId = "aborted-user";
  const identity = await identityFor(userId);
  const storage = createStorage();
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const provider = new SunlandProvider({
    storage,
    sendRequest: async () => {
      calls += 1;
      return jsonResponse({ response: "unexpected" });
    },
  });
  const result = await provider.send({
    conversation: { id: "aborted-conversation", userId },
    messages: [{ role: "user", content: "取消" }],
    identity,
    signal: controller.signal,
    onDelta: () => assert.fail("aborted request must not render"),
  });

  assert.equal(result.blocked, true);
  assert.equal(calls, 0);
  assert.deepEqual(storage.writes, []);
});

test("remote status and malformed payloads fail closed without being saved as successful answers", async () => {
  const userId = "remote-error-user";
  const identity = await identityFor(userId);
  for (const [status, expected] of [[429, /频繁/u], [503, /记忆服务/u]]) {
    const storage = createStorage({
      [`sunland_remote_migration_${userId}`]: JSON.stringify({ status: "complete" }),
    });
    const provider = new SunlandProvider({
      storage,
      sendRequest: async () => jsonResponse({}, status),
    });
    const result = await provider.send({
      conversation: { id: `error-${status}`, userId },
      messages: [{ role: "user", content: "测试" }],
      identity,
    });
    assert.equal(result.blocked, true);
    assert.match(result.content, expected);
  }
});

test("production web code contains no Symbolic Core runtime import or vendor script", () => {
  const providerSource = fs.readFileSync(new URL("../ai/providers/SunlandProvider.js", import.meta.url), "utf8");
  const conversationSource = fs.readFileSync(new URL("../ai/providers/conversation.js", import.meta.url), "utf8");
  const migrationSource = fs.readFileSync(new URL("../ai/sunland-legacy-migration.js", import.meta.url), "utf8");
  const html = fs.readFileSync(new URL("../ai.html", import.meta.url), "utf8");

  assert.doesNotMatch(providerSource, /sunland-core|createSunlandEngine|_getEngine/u);
  assert.doesNotMatch(conversationSource, /sunland-core/u);
  assert.doesNotMatch(html, /ai\/vendor\/sunland-core/u);
  assert.equal(fs.existsSync(new URL("../symbolic-ai/", import.meta.url)), false);
  assert.equal(fs.existsSync(new URL("../ai/vendor/sunland-core.js", import.meta.url)), false);
  assert.equal(fs.existsSync(new URL("../ai/vendor/sunland-core.manifest.json", import.meta.url)), false);
  assert.match(providerSource, /\/v1\/turns/u);
  assert.match(migrationSource, /\/v1\/migrations\/local-state/u);
});

test("production web claims activation server-side and never writes protected profile fields", () => {
  const appSource = fs.readFileSync(new URL("../ai/app.js", import.meta.url), "utf8");
  const settingsSource = fs.readFileSync(new URL("../ai_settings.html", import.meta.url), "utf8");

  assert.match(appSource, /\/v1\/activation\/claim/u);
  assert.doesNotMatch(appSource, /\.from\(["']activation_codes["']\)/u);
  assert.doesNotMatch(appSource, /\.from\(["']user_profiles["']\)[\s\S]{0,80}\.upsert/u);
  assert.doesNotMatch(settingsSource, /\.from\(["']user_profiles["']\)[\s\S]{0,80}\.upsert/u);
});
