import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { createSunlandDataControlsController } from "../ai/sunland-data-controls.js";
import { IdentityAuthority } from "../ai/verified-identity.js";

const projectRequire = createRequire(new URL("../package.json", import.meta.url));
const { JSDOM } = projectRequire("jsdom");
const settingsSource = projectRequire("node:fs").readFileSync(
  new URL("../ai_settings.html", import.meta.url),
  "utf8",
);

function tokenFor(userId, suffix = "initial") {
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "test" })}.${encode({
    sub: userId,
    exp: Math.floor(Date.now() / 1000) + 3600,
    suffix,
  })}.signature`;
}

function userIdFromToken(token) {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")).sub;
}

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, String(value)]));
  const reads = [];
  return {
    reads,
    getItem(key) {
      reads.push(key);
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

function createIdentityAuthority() {
  return new IdentityAuthority({
    fetchImpl: async (_url, options) => {
      const token = String(options?.headers?.Authorization ?? "").replace(/^Bearer\s+/u, "");
      const userId = userIdFromToken(token);
      return {
        ok: true,
        status: 200,
        json: async () => ({ token, user: { id: userId, email: `${userId}@example.com` } }),
      };
    },
  });
}

function record(id, subject, relation, object, negated = false) {
  return { id, subject, relation, object, negated, confidence: 1, source: "user" };
}

function createRemoteApi(seed = {}) {
  const records = new Map(Object.entries(seed).map(([userId, value]) => [userId, structuredClone(value)]));
  const requests = [];
  let failFirstWith401 = false;
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const auth = new Headers(init.headers).get("authorization") ?? "";
    const token = auth.replace(/^Bearer\s+/u, "");
    const userId = userIdFromToken(token);
    requests.push({ path: parsed.pathname, method: init.method ?? "GET", userId, token });
    if (failFirstWith401) {
      failFirstWith401 = false;
      return { ok: false, status: 401, json: async () => ({}) };
    }
    const own = records.get(userId) ?? [];
    if ((init.method ?? "GET") === "GET" && parsed.pathname === "/v1/knowledge") {
      return { ok: true, status: 200, json: async () => ({ items: structuredClone(own), nextCursor: null }) };
    }
    if (init.method === "DELETE" && parsed.pathname === "/v1/knowledge") {
      records.set(userId, []);
      return { ok: true, status: 204, json: async () => ({}) };
    }
    const match = /^\/v1\/knowledge\/([^/]+)$/u.exec(parsed.pathname);
    if (init.method === "DELETE" && match?.[1]) {
      records.set(userId, own.filter(item => item.id !== decodeURIComponent(match[1])));
      return { ok: true, status: 204, json: async () => ({}) };
    }
    if (init.method === "DELETE" && parsed.pathname === "/v1/memory/name") {
      return { ok: true, status: 204, json: async () => ({}) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return {
    fetchImpl,
    requests,
    records,
    failNextWith401() {
      failFirstWith401 = true;
    },
  };
}

function createSyncHub() {
  const listeners = new Set();
  const notifications = [];
  return {
    notifications,
    endpoint() {
      let ownListener = null;
      return {
        notify(userId) {
          notifications.push(userId);
          for (const listener of [...listeners]) queueMicrotask(() => listener(userId));
        },
        subscribe(listener) {
          ownListener = listener;
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        dispose() {
          if (ownListener) listeners.delete(ownListener);
        },
      };
    },
  };
}

function createPage({ userId, remote, confirmations = [], syncChannel } = {}) {
  const storage = createStorage(userId ? {
    token: tokenFor(userId),
    user: JSON.stringify({ id: "untrusted-cache", email: "forged@example.com" }),
  } : {});
  const dom = new JSDOM(settingsSource, { url: "https://sunland.dev/ai_settings.html" });
  const confirmMessages = [];
  const controller = createSunlandDataControlsController({
    documentRef: dom.window.document,
    windowRef: dom.window,
    storageRef: storage,
    identityAuthority: createIdentityAuthority(),
    fetchImpl: remote?.fetchImpl,
    syncChannel: syncChannel ?? {
      notify() {},
      subscribe() { return () => {}; },
      dispose() {},
    },
    confirmImpl(message) {
      confirmMessages.push(message);
      return confirmations.length ? confirmations.shift() : false;
    },
  });
  return { dom, storage, controller, confirmMessages };
}

async function settle() {
  await new Promise(resolve => setTimeout(resolve, 20));
}

test("settings lists only records returned by the authenticated remote user endpoint", async () => {
  const userId = "knowledge-user-a";
  const remote = createRemoteApi({
    [userId]: [
      record("cat", "猫", "属于", "动物"),
      record("bird", "鸟", "有", "翅膀"),
    ],
    "knowledge-user-b": [record("secret", "用户B", "有", "私有知识")],
  });
  const page = createPage({ userId, remote });

  const result = await page.controller.initialize();
  const visible = page.dom.window.document.getElementById("sunlandKnowledgeList").textContent;

  assert.deepEqual(result, { ok: true, count: 2 });
  assert.match(visible, /猫 属于 动物/u);
  assert.match(visible, /鸟 有 翅膀/u);
  assert.doesNotMatch(visible, /用户B|私有知识|confidence|diagnostics/iu);
  assert.equal(page.controller.getState().knowledgeCount, 2);
  assert.deepEqual(remote.requests.map(request => request.userId), [userId]);
  assert.equal(page.storage.reads.some(key => key.startsWith("sunland_knowledge_")), false);
});

test("single deletion is confirmed, sent remotely and followed by a fresh list", async () => {
  const userId = "knowledge-delete-user";
  const remote = createRemoteApi({
    [userId]: [record("cat", "猫", "属于", "动物"), record("bird", "鸟", "有", "翅膀")],
  });
  const page = createPage({ userId, remote, confirmations: [true] });
  await page.controller.initialize();

  const result = await page.controller.deleteKnowledgeRecord("cat", "猫 属于 动物");

  assert.equal(result.ok, true);
  assert.match(page.confirmMessages[0], /猫 属于 动物.*无法恢复/u);
  assert.deepEqual(remote.records.get(userId).map(item => item.id), ["bird"]);
  assert.deepEqual(remote.requests.map(item => [item.method, item.path]), [
    ["GET", "/v1/knowledge"],
    ["DELETE", "/v1/knowledge/cat"],
    ["GET", "/v1/knowledge"],
  ]);
  assert.equal(page.controller.getState().knowledgeCount, 1);
});

test("clear-all and forget-name use separate remote endpoints", async () => {
  const userId = "knowledge-clear-user";
  const remote = createRemoteApi({ [userId]: [record("cat", "猫", "属于", "动物")] });
  const page = createPage({ userId, remote, confirmations: [true, true] });
  await page.controller.initialize();

  page.dom.window.document.getElementById("clearSunlandKnowledgeBtn").click();
  await settle();
  page.dom.window.document.getElementById("clearSunlandNameBtn").click();
  await settle();

  assert.deepEqual(remote.records.get(userId), []);
  assert.equal(remote.requests.some(item => item.method === "DELETE" && item.path === "/v1/knowledge"), true);
  assert.equal(remote.requests.some(item => item.method === "DELETE" && item.path === "/v1/memory/name"), true);
});

test("open settings pages refresh after a remote mutation through the sync channel", async () => {
  const userId = "knowledge-sync-user";
  const remote = createRemoteApi({
    [userId]: [record("cat", "猫", "属于", "动物"), record("bird", "鸟", "有", "翅膀")],
  });
  const hub = createSyncHub();
  const first = createPage({ userId, remote, confirmations: [true], syncChannel: hub.endpoint() });
  const second = createPage({ userId, remote, syncChannel: hub.endpoint() });
  await Promise.all([first.controller.initialize(), second.controller.initialize()]);

  await first.controller.deleteKnowledgeRecord("cat", "猫 属于 动物");
  await settle();

  assert.equal(first.controller.getState().knowledgeCount, 1);
  assert.equal(second.controller.getState().knowledgeCount, 1);
  assert.deepEqual(hub.notifications, [userId]);
});

test("a 401 refreshes verified identity once and retries the remote request once", async () => {
  const userId = "knowledge-refresh-user";
  const remote = createRemoteApi({ [userId]: [record("cat", "猫", "属于", "动物")] });
  remote.failNextWith401();
  const page = createPage({ userId, remote });

  const result = await page.controller.initialize();

  assert.equal(result.ok, true);
  assert.equal(remote.requests.length, 2);
  assert.deepEqual(remote.requests.map(item => item.userId), [userId, userId]);
});

test("invalid identity fails closed before AI data is read or deleted", async () => {
  const remote = createRemoteApi({ protected: [record("secret", "秘密", "是", "数据")] });
  const page = createPage({ remote, confirmations: [true] });

  const result = await page.controller.initialize();

  assert.equal(result.reason, "invalid-identity");
  assert.deepEqual(remote.requests, []);
  assert.equal(page.dom.window.document.getElementById("clearSunlandKnowledgeBtn").disabled, true);
  assert.match(page.dom.window.document.getElementById("sunlandKnowledgeEmpty").textContent, /登录/u);
});
