import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { webcrypto } from "node:crypto";
import { createRequire } from "node:module";

import {
  createBetaDiagnosticsAggregator,
  createBetaDiagnosticsStorage,
  DEVICE_SECRET_STORAGE_KEY,
} from "../ai/beta-diagnostics/index.js";
import { createSunlandDiagnosticsRuntime } from "../ai/beta-diagnostics/runtime.js";
import { createSunlandBetaDiagnosticsController } from "../ai/sunland-beta-diagnostics.js";
import { IdentityAuthority } from "../ai/verified-identity.js";

const symbolicRequire = createRequire(
  new URL("../symbolic-ai/package.json", import.meta.url),
);
const { JSDOM } = symbolicRequire("jsdom");
const settingsSource = fs.readFileSync(
  new URL("../ai_settings.html", import.meta.url),
  "utf8",
);
const privacySource = fs.readFileSync(
  new URL("../privacy.html", import.meta.url),
  "utf8",
);
const diagnosticsSource = fs.readFileSync(
  new URL("../ai/sunland-beta-diagnostics.js", import.meta.url),
  "utf8",
);

function tokenFor(userId, exp = Math.floor(Date.now() / 1000) + 3600) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "test" })}.${encode({ sub: userId, exp })}.signature`;
}

function userIdFromToken(token) {
  return JSON.parse(
    Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
  ).sub;
}

function createIdentityAuthority(networkCalls = []) {
  return new IdentityAuthority({
    fetchImpl: async (url, options) => {
      networkCalls.push({ url, method: options?.method });
      const token = String(options?.headers?.Authorization || "")
        .replace(/^Bearer\s+/u, "");
      const userId = userIdFromToken(token);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          token,
          user: {
            id: userId,
            email: `${userId}@example.com`,
          },
        }),
      };
    },
  });
}

async function createVerifiedIdentity(userId) {
  const token = tokenFor(userId);
  const authority = createIdentityAuthority();
  const result = await authority.resolve({ token });
  assert.equal(result.ok, true);
  return { identity: result.identity, token };
}

function recordedSnapshot() {
  const aggregator = createBetaDiagnosticsAggregator({ mode: "local" });
  const record = aggregator.record({
    schemaVersion: 1,
    sunlandCoreVersion: "0.1.0",
    semanticSchemaVersion: 1,
    contextSchemaVersion: 1,
    resultCategory: "clarification",
    reasonCategory: "missing-object",
    relationCategory: "会",
    semanticAdopted: true,
    legacyFallback: true,
    contextUsed: true,
    clarificationKind: "missing-object",
    pathLengthBucket: "none",
    knowledgeCountBucket: "1-99",
    totalDurationBucket: "1-5ms",
    semanticDurationBucket: "under-1ms",
    reasonerDurationBucket: "unavailable",
    queriedRelation: "会",
    alternativeKnownRelation: "none",
    alignmentResult: "unavailable",
  });
  assert.equal(record.ok, true);
  return aggregator.getSnapshot().snapshot;
}

function createPage({
  token = null,
  cachedUser = null,
  confirmations = [],
  clipboard,
  downloadJson,
  identityAuthority,
  diagnosticsStorage,
  createAggregator,
  syncChannel,
} = {}) {
  const dom = new JSDOM(settingsSource, {
    url: "https://sunland.example/ai_settings.html",
  });
  const { window } = dom;
  if (token) window.localStorage.setItem("token", token);
  if (cachedUser) {
    window.localStorage.setItem("user", JSON.stringify(cachedUser));
  }
  const confirmMessages = [];
  const controller = createSunlandBetaDiagnosticsController({
    documentRef: window.document,
    windowRef: window,
    storageRef: window.localStorage,
    cryptoImpl: webcrypto,
    identityAuthority: identityAuthority ?? createIdentityAuthority(),
    diagnosticsStorage: diagnosticsStorage ?? createBetaDiagnosticsStorage({
      storage: window.localStorage,
      cryptoImpl: webcrypto,
    }),
    createAggregator,
    syncChannel: syncChannel ?? {
      subscribe: () => () => {},
      notify: () => false,
      dispose: () => true,
    },
    confirmImpl(message) {
      confirmMessages.push(message);
      return confirmations.length ? confirmations.shift() : false;
    },
    clipboard,
    downloadJson,
  });

  const dialog = window.document.getElementById("diagnosticsPreviewDialog");
  dialog.showModal = function showModal() {
    this.setAttribute("open", "");
  };
  dialog.close = function close() {
    this.removeAttribute("open");
    this.dispatchEvent(new window.Event("close"));
  };

  return {
    dom,
    window,
    controller,
    confirmMessages,
    storage: window.localStorage,
  };
}

function createSyncHub() {
  const listeners = new Set();
  return {
    endpoint() {
      let listener = null;
      return {
        subscribe(nextListener) {
          listener = nextListener;
          listeners.add(nextListener);
          return () => listeners.delete(nextListener);
        },
        notify(type) {
          for (const current of [...listeners]) {
            queueMicrotask(() => current(type));
          }
          return true;
        },
        dispose() {
          if (listener) listeners.delete(listener);
          listener = null;
          return true;
        },
      };
    },
  };
}

async function waitForAsyncEvent() {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
}

test("settings UI is collapsed, explicit and keyboard-accessible by native controls", () => {
  const dom = new JSDOM(settingsSource);
  const { document } = dom.window;
  const section = document.getElementById("betaDiagnosticsSection");
  const summary = document.getElementById("betaDiagnosticsSummary");
  const toggle = document.getElementById("betaDiagnosticsToggle");

  assert.equal(section.open, false);
  assert.equal(summary.getAttribute("aria-expanded"), "false");
  assert.equal(summary.getAttribute("aria-controls"), "betaDiagnosticsBody");
  assert.equal(toggle.labels.length, 2);
  assert.equal(toggle.getAttribute("aria-describedby").includes("betaDiagnosticsDescription"), true);
  assert.equal(
    document.getElementById("diagnosticsPreviewDialog")
      .getAttribute("aria-labelledby"),
    "diagnosticsPreviewTitle",
  );
  for (const button of document.querySelectorAll(
    "#betaDiagnosticsBody button, #diagnosticsPreviewDialog button",
  )) {
    assert.equal(button.type, "button");
  }
  assert.match(settingsSource, /默认关闭，仅保存在当前设备/u);
  assert.match(settingsSource, /不会自动上传/u);
  assert.match(settingsSource, /不包含对话内容、姓名、教学知识或账号标识/u);
  assert.doesNotMatch(settingsSource, /完全匿名|绝对无法识别|百分之百安全/u);
});

test("invalid identity fails closed and forged localStorage.user never enables diagnostics", async () => {
  const page = createPage({
    cachedUser: { id: "forged-user", email: "forged@example.com" },
  });

  const result = await page.controller.initialize();

  assert.deepEqual(result, { ok: false, reason: "invalid-identity" });
  assert.equal(page.controller.getState().identityValid, false);
  assert.equal(page.window.document.getElementById("betaDiagnosticsToggle").disabled, true);
  assert.equal(page.window.document.getElementById("viewDiagnosticsExportBtn").disabled, true);
  assert.equal(page.window.document.getElementById("clearDiagnosticsBtn").disabled, true);
  assert.equal(page.storage.getItem(DEVICE_SECRET_STORAGE_KEY), null);
  assert.match(
    page.window.document.getElementById("betaDiagnosticsStatus").textContent,
    /重新登录/u,
  );
});

test("default off creates no device boundary and enabling requires confirmation", async () => {
  const { token } = await createVerifiedIdentity("consent-user");
  const page = createPage({
    token,
    cachedUser: { id: "different-cached-user" },
    confirmations: [false, true],
  });
  await page.controller.initialize();

  assert.equal(page.controller.getState().mode, "off");
  assert.equal(page.storage.getItem(DEVICE_SECRET_STORAGE_KEY), null);

  const cancelled = await page.controller.setParticipation(true);
  assert.equal(cancelled.reason, "cancelled");
  assert.equal(page.storage.getItem(DEVICE_SECRET_STORAGE_KEY), null);

  const enabled = await page.controller.setParticipation(true);
  assert.deepEqual(enabled, { ok: true, mode: "local" });
  assert.match(page.confirmMessages[0], /不会自动上传/u);
  assert.ok(page.storage.getItem(DEVICE_SECRET_STORAGE_KEY));

  const storageApi = createBetaDiagnosticsStorage({
    storage: page.storage,
    cryptoImpl: webcrypto,
  });
  const currentIdentity = (await createVerifiedIdentity("consent-user")).identity;
  assert.deepEqual(await storageApi.loadMode(currentIdentity), {
    ok: true,
    mode: "local",
  });
});

test("turning diagnostics off preserves the snapshot and reports the retention boundary", async () => {
  const prepared = await createVerifiedIdentity("retention-user");
  const page = createPage({ token: prepared.token });
  const storageApi = createBetaDiagnosticsStorage({
    storage: page.storage,
    cryptoImpl: webcrypto,
  });
  await storageApi.saveMode(prepared.identity, "local");
  await storageApi.saveSnapshot(prepared.identity, recordedSnapshot());
  await page.controller.initialize();

  assert.equal(page.controller.getState().hasData, true);
  const disabled = await page.controller.setParticipation(false);

  assert.deepEqual(disabled, { ok: true, mode: "off" });
  assert.equal((await storageApi.hasSnapshot(prepared.identity)).hasSnapshot, true);
  assert.equal((await storageApi.loadMode(prepared.identity)).mode, "off");
  assert.match(
    page.window.document.getElementById("betaDiagnosticsStatus").textContent,
    /仍保留/u,
  );
});

test("off mode loads an existing snapshot only after the user expands the section", async () => {
  const prepared = await createVerifiedIdentity("lazy-preview-user");
  const page = createPage({ token: prepared.token });
  const storageApi = createBetaDiagnosticsStorage({
    storage: page.storage,
    cryptoImpl: webcrypto,
  });
  await storageApi.saveSnapshot(prepared.identity, recordedSnapshot());
  await page.controller.initialize();

  assert.equal(page.controller.getState().mode, "off");
  assert.equal(page.controller.getState().snapshotLoaded, false);
  assert.equal(page.controller.getState().hasData, false);

  const section = page.window.document.getElementById("betaDiagnosticsSection");
  section.open = true;
  section.dispatchEvent(new page.window.Event("toggle"));
  await waitForAsyncEvent();

  assert.equal(page.controller.getState().snapshotLoaded, true);
  assert.equal(page.controller.getState().hasData, true);
  assert.equal(
    page.window.document.getElementById("betaDiagnosticsSummary")
      .getAttribute("aria-expanded"),
    "true",
  );
});

test("preview, copy and download use the same whitelisted export without identity data", async () => {
  const prepared = await createVerifiedIdentity("private-user");
  const copied = [];
  const downloads = [];
  const page = createPage({
    token: prepared.token,
    confirmations: [true],
    clipboard: {
      async writeText(value) {
        copied.push(value);
      },
    },
    downloadJson(payload) {
      downloads.push(payload);
      return true;
    },
  });
  const storageApi = createBetaDiagnosticsStorage({
    storage: page.storage,
    cryptoImpl: webcrypto,
  });
  await storageApi.saveMode(prepared.identity, "local");
  await storageApi.saveSnapshot(prepared.identity, recordedSnapshot());
  await page.controller.initialize();

  assert.equal(
    page.window.document.getElementById("betaDiagnosticsCounter-requestCompleted")
      .textContent,
    "1",
  );
  const preview = await page.controller.viewExport();
  const displayed = page.window.document
    .getElementById("diagnosticsPreviewContent").textContent;
  assert.equal(preview.ok, true);
  assert.equal(displayed, preview.json);
  assert.equal(
    page.window.document.getElementById("diagnosticsPreviewDialog")
      .hasAttribute("open"),
    true,
  );
  assert.equal(
    page.window.document.activeElement.id,
    "closeDiagnosticsPreviewBtn",
  );

  const copiedResult = await page.controller.copyExport();
  const exportedResult = await page.controller.exportJson();
  assert.equal(copiedResult.ok, true);
  assert.equal(exportedResult.ok, true);
  assert.equal(copied[0], displayed);
  assert.equal(downloads[0].json, displayed);
  assert.equal(downloads[0].filename, "sunland-beta-diagnostics.json");
  assert.doesNotMatch(
    displayed,
    /private-user|example\.com|"(?:deviceSecret|opaqueNamespace|localStorageKey|userId|conversationId|subject|object|timestamp)"\s*:/iu,
  );
  assert.deepEqual(Object.keys(JSON.parse(displayed)), [
    "schema",
    "diagnosticsSchemaVersion",
    "versions",
    "counters",
    "resultCategories",
    "reasonCategories",
    "relationCategories",
    "clarificationKinds",
    "durations",
    "knowledgeSizeBuckets",
    "reasonerPathBuckets",
  ]);
});

test("damaged snapshots reset safely without changing local mode", async () => {
  const prepared = await createVerifiedIdentity("damaged-ui-user");
  const page = createPage({ token: prepared.token });
  const storageApi = createBetaDiagnosticsStorage({
    storage: page.storage,
    cryptoImpl: webcrypto,
  });
  await storageApi.saveMode(prepared.identity, "local");
  await storageApi.saveSnapshot(prepared.identity, recordedSnapshot());
  const snapshotKey = Array.from(
    { length: page.storage.length },
    (_, index) => page.storage.key(index),
  ).find(key => key?.startsWith("sunland_beta_diag_v1::"));
  page.storage.setItem(snapshotKey, "{broken-json");

  const initialized = await page.controller.initialize();

  assert.deepEqual(initialized, { ok: true, mode: "local" });
  assert.equal(page.controller.getState().hasData, false);
  assert.equal(page.storage.getItem(snapshotKey), null);
  assert.equal((await storageApi.loadMode(prepared.identity)).mode, "local");
  assert.match(
    page.window.document.getElementById("betaDiagnosticsStatus").textContent,
    /已重置/u,
  );
});

test("clear affects only the verified current user snapshot and preserves all other data", async () => {
  const userA = await createVerifiedIdentity("clear-ui-user-a");
  const userB = await createVerifiedIdentity("clear-ui-user-b");
  const page = createPage({
    token: userA.token,
    confirmations: [true],
  });
  const storageApi = createBetaDiagnosticsStorage({
    storage: page.storage,
    cryptoImpl: webcrypto,
  });
  await storageApi.saveMode(userA.identity, "local");
  await storageApi.saveMode(userB.identity, "local");
  await storageApi.saveSnapshot(userA.identity, recordedSnapshot());
  await storageApi.saveSnapshot(userB.identity, recordedSnapshot());
  page.storage.setItem("conversations_clear-ui-user-a", "chat-data");
  page.storage.setItem("sunland_knowledge_clear-ui-user-a", "knowledge-data");
  page.storage.setItem(
    "sunland_knowledge_clear-ui-user-a::memory",
    "memory-data",
  );
  await page.controller.initialize();

  const cleared = await page.controller.clearDiagnostics();

  assert.deepEqual(cleared, { ok: true });
  assert.equal((await storageApi.hasSnapshot(userA.identity)).hasSnapshot, false);
  assert.equal((await storageApi.hasSnapshot(userB.identity)).hasSnapshot, true);
  assert.equal((await storageApi.loadMode(userA.identity)).mode, "local");
  assert.equal(page.storage.getItem("conversations_clear-ui-user-a"), "chat-data");
  assert.equal(page.storage.getItem("sunland_knowledge_clear-ui-user-a"), "knowledge-data");
  assert.equal(
    page.storage.getItem("sunland_knowledge_clear-ui-user-a::memory"),
    "memory-data",
  );
  assert.ok(page.storage.getItem(DEVICE_SECRET_STORAGE_KEY));
});

test("user switching disposes the old aggregator and keeps A/B mode and snapshot isolated", async () => {
  const userA = await createVerifiedIdentity("switch-ui-user-a");
  const userB = await createVerifiedIdentity("switch-ui-user-b");
  let disposeCount = 0;
  const createTrackedAggregator = options => {
    const inner = createBetaDiagnosticsAggregator(options);
    return Object.freeze({
      record: inner.record,
      getSnapshot: inner.getSnapshot,
      getExportPreview: inner.getExportPreview,
      clear: inner.clear,
      getMode: inner.getMode,
      setMode: inner.setMode,
      dispose() {
        disposeCount += 1;
        return inner.dispose();
      },
    });
  };
  const networkCalls = [];
  const page = createPage({
    token: userA.token,
    cachedUser: { id: "switch-ui-user-b" },
    identityAuthority: createIdentityAuthority(networkCalls),
    createAggregator: createTrackedAggregator,
  });
  const storageApi = createBetaDiagnosticsStorage({
    storage: page.storage,
    cryptoImpl: webcrypto,
  });
  await storageApi.saveMode(userA.identity, "local");
  await storageApi.saveSnapshot(userA.identity, recordedSnapshot());
  await page.controller.initialize();
  assert.equal(page.controller.getState().hasData, true);

  page.storage.setItem("token", userB.token);
  await page.controller.initialize();

  assert.ok(disposeCount >= 2);
  assert.equal(page.controller.getState().mode, "off");
  assert.equal(page.controller.getState().hasData, false);
  assert.equal((await storageApi.hasSnapshot(userA.identity)).hasSnapshot, true);
  assert.equal((await storageApi.hasSnapshot(userB.identity)).hasSnapshot, false);
  assert.equal(networkCalls.every(call => call.url.endsWith("/refresh")), true);
});

test("diagnostics failures stay inside their card and do not affect other settings", async () => {
  const prepared = await createVerifiedIdentity("failure-ui-user");
  const page = createPage({
    token: prepared.token,
    diagnosticsStorage: {
      async loadMode() {
        throw new Error("private diagnostics failure");
      },
    },
  });
  page.storage.setItem(DEVICE_SECRET_STORAGE_KEY, "0".repeat(64));

  const result = await page.controller.initialize();

  assert.equal(result.reason, "initialization-failed");
  assert.equal(page.window.document.getElementById("betaDiagnosticsToggle").disabled, true);
  assert.equal(page.window.document.getElementById("clearSunlandNameBtn").disabled, false);
  assert.match(
    page.window.document.getElementById("betaDiagnosticsStatus").textContent,
    /其他设置不受影响/u,
  );
});

test("settings page never self-generates counts or owns production collection", async () => {
  const networkCalls = [];
  const prepared = await createVerifiedIdentity("no-production-user");
  const page = createPage({
    token: prepared.token,
    identityAuthority: createIdentityAuthority(networkCalls),
  });
  const storageApi = createBetaDiagnosticsStorage({
    storage: page.storage,
    cryptoImpl: webcrypto,
  });
  await storageApi.saveMode(prepared.identity, "local");
  await page.controller.initialize();
  const before = page.controller.getState();
  await waitForAsyncEvent();
  const after = page.controller.getState();

  assert.equal(before.hasData, false);
  assert.equal(after.hasData, false);
  assert.equal(networkCalls.length, 1);
  assert.equal(networkCalls[0].url, "https://api.sunland.dev/refresh");
  assert.doesNotMatch(
    diagnosticsSource,
    /SunlandProvider|DeepSeekProvider|observationSummary|sendBeacon|XMLHttpRequest|WebSocket/iu,
  );
  assert.match(
    fs.readFileSync(new URL("../ai/app.js", import.meta.url), "utf8"),
    /createSunlandDiagnosticsRuntime/u,
  );
  assert.doesNotMatch(
    fs.readFileSync(
      new URL("../ai/providers/SunlandProvider.js", import.meta.url),
      "utf8",
    ),
    /createBetaDiagnosticsAggregator|saveSnapshot|sendBeacon|XMLHttpRequest/u,
  );
});

test("settings mode, latest snapshot and clear synchronize with an open chat runtime", async () => {
  const prepared = await createVerifiedIdentity("cross-tab-user");
  const hub = createSyncHub();
  const page = createPage({
    token: prepared.token,
    confirmations: [true, true],
    syncChannel: hub.endpoint(),
  });
  const storageApi = createBetaDiagnosticsStorage({
    storage: page.storage,
    cryptoImpl: webcrypto,
  });
  const runtime = createSunlandDiagnosticsRuntime({
    getIdentity: () => prepared.identity,
    storageRef: page.storage,
    cryptoImpl: webcrypto,
    diagnosticsStorage: storageApi,
    syncChannel: hub.endpoint(),
  });

  await page.controller.initialize();
  await runtime.initialize();
  assert.equal(runtime.getObservationMode(), "off");

  assert.equal((await page.controller.setParticipation(true)).ok, true);
  await waitForAsyncEvent();
  assert.equal(runtime.getObservationMode(), "summary");

  const controller = new AbortController();
  const requestContext = {
    providerId: "sunland",
    identity: prepared.identity,
    diagnostics: runtime.captureRequest("sunland", prepared.identity),
    controller,
    status: "active",
    canRecordDiagnostics: () => true,
  };
  const summary = {
    schemaVersion: 1,
    sunlandCoreVersion: "0.1.0",
    semanticSchemaVersion: 1,
    contextSchemaVersion: 1,
    resultCategory: "understood",
    reasonCategory: "complete-passive-understanding",
    relationCategory: "none",
    semanticAdopted: true,
    legacyFallback: false,
    contextUsed: false,
    clarificationKind: "none",
    pathLengthBucket: "none",
    knowledgeCountBucket: "0",
    totalDurationBucket: "1-5ms",
    semanticDurationBucket: "under-1ms",
    reasonerDurationBucket: "unavailable",
    queriedRelation: "none",
    alternativeKnownRelation: "none",
    alignmentResult: "unavailable",
  };
  assert.equal((await runtime.record(summary, requestContext)).recorded, true);
  await waitForAsyncEvent();

  const preview = await page.controller.viewExport();
  assert.equal(preview.ok, true);
  assert.equal(JSON.parse(preview.json).counters.requestCompleted, 1);

  const staleRequest = {
    ...requestContext,
    diagnostics: runtime.captureRequest("sunland", prepared.identity),
  };
  assert.equal((await page.controller.clearDiagnostics()).ok, true);
  await waitForAsyncEvent();
  assert.equal(
    (await runtime.record(summary, staleRequest)).recorded,
    false,
  );
  assert.equal(
    (await storageApi.loadSnapshot(prepared.identity)).snapshot,
    null,
  );

  await page.controller.setParticipation(false);
  await waitForAsyncEvent();
  assert.equal(runtime.getObservationMode(), "off");
});

test("privacy policy describes opt-in local-only behavior without absolute promises", () => {
  assert.match(privacySource, /本地诊断默认关闭/u);
  assert.match(privacySource, /主动开启/u);
  assert.match(privacySource, /不会自动上传/u);
  assert.match(privacySource, /不包含聊天内容、姓名、用户教学知识或账号标识/u);
  assert.match(privacySource, /查看、导出或清除/u);
  assert.match(privacySource, /关闭诊断不会自动删除/u);
  assert.match(privacySource, /同源脚本/u);
  assert.doesNotMatch(privacySource, /完全匿名|绝对无法识别|百分之百安全/u);
  assert.doesNotMatch(settingsSource, /后续生产接入完成后/u);
});
