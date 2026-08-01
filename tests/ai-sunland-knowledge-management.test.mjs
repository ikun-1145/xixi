import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

import {
  createSunlandDataControlsController,
} from "../ai/sunland-data-controls.js";
import { IdentityAuthority } from "../ai/verified-identity.js";

const symbolicRequire = createRequire(
  new URL("../symbolic-ai/package.json", import.meta.url),
);
const { JSDOM } = symbolicRequire("jsdom");
const settingsSource = fs.readFileSync(
  new URL("../ai_settings.html", import.meta.url),
  "utf8",
);
const appSource = fs.readFileSync(
  new URL("../ai/app.js", import.meta.url),
  "utf8",
);

function tokenFor(userId) {
  const encode = value =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "test" })}.${encode({
    sub: userId,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}.signature`;
}

function userIdFromToken(token) {
  return JSON.parse(
    Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
  ).sub;
}

function createIdentityAuthority() {
  return new IdentityAuthority({
    fetchImpl: async (_url, options) => {
      const token = String(
        options?.headers?.Authorization ?? "",
      ).replace(/^Bearer\s+/u, "");
      const userId = userIdFromToken(token);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          token,
          user: { id: userId, email: `${userId}@example.com` },
        }),
      };
    },
  });
}

function createStorage(initial = {}) {
  const values = new Map(
    Object.entries(initial).map(([key, value]) => [
      key,
      String(value),
    ]),
  );
  const reads = [];
  return {
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
    reads,
    dump() {
      return Object.fromEntries(values);
    },
  };
}

function knowledgeRecord({
  id,
  subject,
  relation,
  object,
  source = "user",
  confidence = 0.42,
  createdAt = "2026-07-26T00:00:00.000Z",
}) {
  return {
    id,
    subject,
    relation,
    object,
    negated: false,
    source,
    confidence,
    createdAt,
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
          for (const listener of [...listeners]) {
            queueMicrotask(() => listener(userId));
          }
          return true;
        },
        subscribe(listener) {
          ownListener = listener;
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        dispose() {
          if (ownListener) listeners.delete(ownListener);
          ownListener = null;
          return true;
        },
      };
    },
  };
}

function createPage({
  storage,
  confirmations = [],
  syncChannel,
} = {}) {
  const dom = new JSDOM(settingsSource, {
    url: "https://sunland.example/ai_settings.html",
  });
  const confirmMessages = [];
  const controller = createSunlandDataControlsController({
    documentRef: dom.window.document,
    windowRef: dom.window,
    storageRef: storage,
    identityAuthority: createIdentityAuthority(),
    syncChannel: syncChannel ?? {
      notify: () => false,
      subscribe: () => () => {},
      dispose: () => true,
    },
    confirmImpl(message) {
      confirmMessages.push(message);
      return confirmations.length ? confirmations.shift() : false;
    },
  });
  return {
    dom,
    window: dom.window,
    controller,
    confirmMessages,
  };
}

function storedRecords(storage, key) {
  const value = storage.getItem(key);
  return value ? JSON.parse(value) : [];
}

async function waitForUi() {
  await new Promise(resolve => setTimeout(resolve, 20));
}

test("settings lists only the Verified Identity user's teaching knowledge", async () => {
  const userA = "knowledge-user-a";
  const userB = "knowledge-user-b";
  const keyA = `sunland_knowledge_${userA}`;
  const keyB = `sunland_knowledge_${userB}`;
  const tokenA = tokenFor(userA);
  const storage = createStorage({
    token: tokenA,
    user: JSON.stringify({
      id: userB,
      email: "forged@example.com",
    }),
    [keyA]: JSON.stringify([
      knowledgeRecord({
        id: "a-cat",
        subject: "猫",
        relation: "属于",
        object: "动物",
      }),
      knowledgeRecord({
        id: "a-bird",
        subject: "鸟",
        relation: "有",
        object: "翅膀",
        source: undefined,
      }),
      knowledgeRecord({
        id: "system-self",
        subject: "Sunland AI · Beta",
        relation: "是",
        object: "系统知识",
        source: "seed",
      }),
    ]),
    [`${keyA}::memory`]: JSON.stringify([
      { id: "memory-name", key: "name", value: "小明" },
    ]),
    [keyB]: JSON.stringify([
      knowledgeRecord({
        id: "b-secret",
        subject: "用户B",
        relation: "有",
        object: "私有知识",
      }),
    ]),
  });
  const page = createPage({ storage });

  const result = await page.controller.initialize();
  const visibleText = page.window.document
    .getElementById("sunlandKnowledgeList").textContent;

  assert.equal(result.ok, true);
  assert.equal(page.controller.getState().knowledgeCount, 2);
  assert.match(visibleText, /猫 属于 动物/u);
  assert.match(visibleText, /鸟 有 翅膀/u);
  assert.doesNotMatch(visibleText, /系统知识|用户B|私有知识|小明/u);
  assert.doesNotMatch(visibleText, /confidence|reasoning|diagnostics|0\.42/iu);
  assert.equal(
    page.window.document.querySelectorAll(
      "#sunlandKnowledgeList .knowledge-delete-btn",
    ).length,
    2,
  );
});

test("single deletion is confirmed, immediate, cumulative and resistant to stale snapshot restore", async () => {
  const userId = "knowledge-delete-user";
  const key = `sunland_knowledge_${userId}`;
  const original = [
    knowledgeRecord({
      id: "delete-cat",
      subject: "猫",
      relation: "属于",
      object: "动物",
    }),
    knowledgeRecord({
      id: "delete-bird",
      subject: "鸟",
      relation: "有",
      object: "翅膀",
    }),
    knowledgeRecord({
      id: "keep-seed",
      subject: "系统",
      relation: "是",
      object: "内置知识",
      source: "seed",
    }),
  ];
  const userBKey = "sunland_knowledge_knowledge-delete-user-b";
  const memoryKey = `${key}::memory`;
  const storage = createStorage({
    token: tokenFor(userId),
    [key]: JSON.stringify(original),
    [userBKey]: JSON.stringify([
      knowledgeRecord({
        id: "user-b-record",
        subject: "B",
        relation: "有",
        object: "知识",
      }),
    ]),
    [memoryKey]: JSON.stringify([
      { id: "memory-name", key: "name", value: "小明" },
    ]),
  });
  const syncHub = createSyncHub();
  const page = createPage({
    storage,
    confirmations: [true, true],
    syncChannel: syncHub.endpoint(),
  });
  await page.controller.initialize();

  const first = await page.controller.deleteKnowledgeRecord(
    "delete-cat",
    "猫 属于 动物",
  );
  assert.equal(first.ok, true);
  assert.equal(first.removedCount, 1);
  assert.match(page.confirmMessages[0], /猫 属于 动物/u);
  assert.match(page.confirmMessages[0], /删除后无法恢复/u);
  assert.deepEqual(
    storedRecords(storage, key).map(record => record.id),
    ["delete-bird", "keep-seed"],
  );
  assert.equal(page.controller.getState().knowledgeCount, 1);

  const second = await page.controller.deleteKnowledgeRecord(
    "delete-bird",
    "鸟 有 翅膀",
  );
  assert.equal(second.removedCount, 1);
  assert.deepEqual(
    storedRecords(storage, key).map(record => record.id),
    ["keep-seed"],
  );

  storage.setItem(key, JSON.stringify(original));
  page.window.dispatchEvent(
    new page.window.StorageEvent("storage", { key }),
  );
  await waitForUi();

  assert.deepEqual(
    storedRecords(storage, key).map(record => record.id),
    ["keep-seed"],
  );
  assert.equal(page.controller.getState().knowledgeCount, 0);
  assert.equal(storage.getItem(memoryKey).includes("小明"), true);
  assert.equal(storage.getItem(userBKey).includes("user-b-record"), true);
  assert.deepEqual(syncHub.notifications, [userId, userId]);
});

test("open settings pages refresh through the existing data-control sync channel", async () => {
  const userId = "knowledge-sync-user";
  const key = `sunland_knowledge_${userId}`;
  const storage = createStorage({
    token: tokenFor(userId),
    [key]: JSON.stringify([
      knowledgeRecord({
        id: "sync-cat",
        subject: "猫",
        relation: "属于",
        object: "动物",
      }),
      knowledgeRecord({
        id: "sync-bird",
        subject: "鸟",
        relation: "有",
        object: "翅膀",
      }),
    ]),
  });
  const syncHub = createSyncHub();
  const firstPage = createPage({
    storage,
    confirmations: [true],
    syncChannel: syncHub.endpoint(),
  });
  const secondPage = createPage({
    storage,
    syncChannel: syncHub.endpoint(),
  });
  await Promise.all([
    firstPage.controller.initialize(),
    secondPage.controller.initialize(),
  ]);

  await firstPage.controller.deleteKnowledgeRecord(
    "sync-cat",
    "猫 属于 动物",
  );
  await waitForUi();

  assert.equal(firstPage.controller.getState().knowledgeCount, 1);
  assert.equal(secondPage.controller.getState().knowledgeCount, 1);
  assert.doesNotMatch(
    secondPage.window.document
      .getElementById("sunlandKnowledgeList").textContent,
    /猫 属于 动物/u,
  );
});

test("clear-all keeps seed knowledge, Memory and other users untouched", async () => {
  const userId = "knowledge-clear-user";
  const key = `sunland_knowledge_${userId}`;
  const memoryKey = `${key}::memory`;
  const otherKey = "sunland_knowledge_knowledge-clear-other";
  const storage = createStorage({
    token: tokenFor(userId),
    [key]: JSON.stringify([
      knowledgeRecord({
        id: "clear-user-record",
        subject: "猫",
        relation: "属于",
        object: "动物",
      }),
      knowledgeRecord({
        id: "keep-system-record",
        subject: "系统",
        relation: "是",
        object: "内置知识",
        source: "seed",
      }),
    ]),
    [memoryKey]: JSON.stringify([
      { id: "memory-name", key: "name", value: "小明" },
    ]),
    [otherKey]: JSON.stringify([
      knowledgeRecord({
        id: "other-user-record",
        subject: "其他用户",
        relation: "有",
        object: "知识",
      }),
    ]),
  });
  const page = createPage({
    storage,
    confirmations: [true],
  });
  await page.controller.initialize();

  page.window.document
    .getElementById("clearSunlandKnowledgeBtn")
    .click();
  await waitForUi();

  assert.deepEqual(
    storedRecords(storage, key).map(record => record.id),
    ["keep-system-record"],
  );
  assert.equal(storage.getItem(memoryKey).includes("小明"), true);
  assert.equal(storage.getItem(otherKey).includes("other-user-record"), true);
  assert.equal(page.controller.getState().knowledgeCount, 0);
});

test("invalid identity and damaged knowledge fail closed without deleting data", async () => {
  const protectedKey = "sunland_knowledge_protected-user";
  const invalidStorage = createStorage({
    user: JSON.stringify({ id: "protected-user" }),
    [protectedKey]: JSON.stringify([
      knowledgeRecord({
        id: "protected-record",
        subject: "秘密",
        relation: "是",
        object: "数据",
      }),
    ]),
  });
  const invalidPage = createPage({ storage: invalidStorage });
  const invalidResult = await invalidPage.controller.initialize();

  assert.equal(invalidResult.ok, false);
  assert.equal(
    invalidStorage.reads.includes(protectedKey),
    false,
  );
  assert.equal(
    invalidPage.window.document
      .getElementById("clearSunlandKnowledgeBtn").disabled,
    true,
  );

  const userId = "damaged-knowledge-user";
  const damagedKey = `sunland_knowledge_${userId}`;
  const damagedStorage = createStorage({
    token: tokenFor(userId),
    [damagedKey]: "{damaged",
  });
  const damagedPage = createPage({
    storage: damagedStorage,
    confirmations: [true],
  });
  const damagedResult = await damagedPage.controller.initialize();

  assert.equal(damagedResult.ok, false);
  assert.equal(damagedStorage.getItem(damagedKey), "{damaged");
  assert.equal(
    damagedPage.window.document
      .getElementById("clearSunlandKnowledgeBtn").disabled,
    true,
  );
  assert.match(
    damagedPage.window.document
      .getElementById("sunlandKnowledgeEmpty").textContent,
    /暂时无法读取/u,
  );
});

test("chat runtime aborts active Sunland requests and rebuilds engines on knowledge deletion", () => {
  assert.match(
    appSource,
    /requestCoordinator\.abort\(activeRequest,\s*"sunland-data-cleared"\)/u,
  );
  assert.match(
    appSource,
    /providerRegistry\s*=\s*createProviderRegistry\(\{\s*sendRequest:\s*apiFetch\s*\}\)/u,
  );
  assert.match(
    appSource,
    /event\.data\?\.type\s*===\s*"sunland-data-cleared"/u,
  );
});
