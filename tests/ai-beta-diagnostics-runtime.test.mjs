import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { webcrypto } from "node:crypto";

import {
  createBetaDiagnosticsStorage,
  DEVICE_SECRET_STORAGE_KEY,
} from "../ai/beta-diagnostics/index.js";
import { createSunlandDiagnosticsRuntime } from
  "../ai/beta-diagnostics/runtime.js";
import { IdentityAuthority } from "../ai/verified-identity.js";
import { RequestCoordinator } from "../ai/request-context.js";

const appSource = fs.readFileSync(
  new URL("../ai/app.js", import.meta.url),
  "utf8",
);
const providerSource = fs.readFileSync(
  new URL("../ai/providers/SunlandProvider.js", import.meta.url),
  "utf8",
);
const deepSeekSource = fs.readFileSync(
  new URL("../ai/providers/DeepSeekProvider.js", import.meta.url),
  "utf8",
);

function createStorage() {
  const values = new Map();
  return {
    get length() {
      return values.size;
    },
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    entries() {
      return [...values.entries()];
    },
  };
}

function noSyncChannel() {
  return {
    subscribe() {
      return () => {};
    },
    notify() {
      return false;
    },
    dispose() {
      return true;
    },
  };
}

function tokenFor(userId) {
  const encode = value =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
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
      json: async () => ({
        token,
        user: { id: userId, email: `${userId}@example.com` },
      }),
    }),
  });
  const resolved = await authority.resolve({ token });
  assert.equal(resolved.ok, true);
  return resolved.identity;
}

function observation(overrides = {}) {
  return Object.freeze({
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
    ...overrides,
  });
}

function requestFor(runtime, identity, overrides = {}) {
  const controller = new AbortController();
  let eligible = true;
  const request = {
    providerId: "sunland",
    identity,
    diagnostics: runtime.captureRequest("sunland", identity),
    controller,
    status: "active",
    canRecordDiagnostics: () => eligible,
    ...overrides,
  };
  return {
    request,
    setEligible(value) {
      eligible = value;
    },
  };
}

async function createLocalRuntime({
  storage = createStorage(),
  identity = null,
  currentIdentity = null,
} = {}) {
  identity ??= await identityFor("runtime-user");
  currentIdentity ??= { value: identity };
  const diagnosticsStorage = createBetaDiagnosticsStorage({
    storage,
    cryptoImpl: webcrypto,
  });
  await diagnosticsStorage.saveMode(identity, "local");
  const runtime = createSunlandDiagnosticsRuntime({
    getIdentity: () => currentIdentity.value,
    storageRef: storage,
    cryptoImpl: webcrypto,
    diagnosticsStorage,
    syncChannel: noSyncChannel(),
  });
  assert.deepEqual(await runtime.initialize(), {
    ok: true,
    mode: "local",
  });
  return {
    runtime,
    storage,
    identity,
    currentIdentity,
    diagnosticsStorage,
  };
}

test("default off does not create a diagnostics storage boundary", async () => {
  const storage = createStorage();
  const identity = await identityFor("off-user");
  const runtime = createSunlandDiagnosticsRuntime({
    getIdentity: () => identity,
    storageRef: storage,
    cryptoImpl: webcrypto,
    syncChannel: noSyncChannel(),
  });

  assert.deepEqual(await runtime.initialize(), { ok: true, mode: "off" });
  assert.equal(runtime.isEnabled(), false);
  assert.equal(runtime.getObservationMode(), "off");
  assert.equal(storage.getItem(DEVICE_SECRET_STORAGE_KEY), null);
  assert.equal(
    runtime.captureRequest("sunland", identity).observationMode,
    "off",
  );
});

test("local mode records only validated aggregate snapshots", async () => {
  const harness = await createLocalRuntime();
  const { request } = requestFor(harness.runtime, harness.identity);

  const recorded = await harness.runtime.record(observation(), request);
  await harness.runtime.flush();

  assert.deepEqual(recorded, {
    ok: true,
    recorded: true,
    reason: undefined,
  });
  const loaded = await harness.diagnosticsStorage.loadSnapshot(
    harness.identity,
  );
  assert.equal(loaded.snapshot.counters.requestCompleted, 1);
  assert.equal(loaded.snapshot.counters.understood, 1);

  const serializedStorage = JSON.stringify(harness.storage.entries());
  assert.doesNotMatch(
    serializedStorage,
    /full input|full reply|Alice Chen|"(?:subject|object|conversationId|requestId|userId|token|stack|timestamp|events)"\s*:/iu,
  );
});

test("runtime maps representative summaries into existing counters", async () => {
  const harness = await createLocalRuntime();
  const cases = [
    ["clarification", { resultCategory: "clarification", reasonCategory: "missing-object", clarificationKind: "missing-object" }],
    ["noUnderstanding", { resultCategory: "no-understanding", reasonCategory: "unknown-safe-fallback" }],
    ["missingKnowledge", { resultCategory: "missing-knowledge", reasonCategory: "missing-knowledge" }],
    ["contextUsed", { contextUsed: true }],
    ["legacyFallback", { legacyFallback: true, semanticAdopted: false }],
    ["sideEffectBlocked", { resultCategory: "side-effect-blocked", reasonCategory: "blocked-side-effect" }],
  ];

  for (const [, overrides] of cases) {
    const { request } = requestFor(harness.runtime, harness.identity);
    assert.equal(
      (await harness.runtime.record(observation(overrides), request)).ok,
      true,
    );
  }
  const loaded = await harness.diagnosticsStorage.loadSnapshot(
    harness.identity,
  );
  for (const [counter] of cases) {
    assert.equal(loaded.snapshot.counters[counter], 1, counter);
  }
});

test("invalid summaries and ineligible requests never change counters", async () => {
  const harness = await createLocalRuntime();
  const invalid = requestFor(harness.runtime, harness.identity);
  assert.equal(
    (await harness.runtime.record(
      { ...observation(), rawInput: "private" },
      invalid.request,
    )).recorded,
    false,
  );

  const scenarios = [
    requestFor(harness.runtime, harness.identity, { providerId: "deepseek" }),
    requestFor(harness.runtime, harness.identity, { status: "completed" }),
    requestFor(harness.runtime, harness.identity),
    requestFor(harness.runtime, harness.identity),
  ];
  scenarios[2].request.controller.abort();
  scenarios[3].setEligible(false);
  for (const scenario of scenarios) {
    assert.equal(
      (await harness.runtime.record(observation(), scenario.request)).recorded,
      false,
    );
  }

  const loaded = await harness.diagnosticsStorage.loadSnapshot(
    harness.identity,
  );
  assert.equal(loaded.snapshot, null);
});

test("turning diagnostics off invalidates an in-flight request capture", async () => {
  const harness = await createLocalRuntime();
  const { request } = requestFor(harness.runtime, harness.identity);

  await harness.diagnosticsStorage.saveMode(harness.identity, "off");
  const result = await harness.runtime.record(observation(), request);
  await harness.runtime.flush();

  assert.equal(result.recorded, false);
  assert.equal(
    (await harness.diagnosticsStorage.loadSnapshot(harness.identity)).snapshot,
    null,
  );
});

test("clear revision prevents a stale runtime from resurrecting a snapshot", async () => {
  const harness = await createLocalRuntime();
  const first = requestFor(harness.runtime, harness.identity);
  assert.equal(
    (await harness.runtime.record(observation(), first.request)).recorded,
    true,
  );
  const stale = requestFor(harness.runtime, harness.identity);

  await harness.diagnosticsStorage.clearSnapshot(harness.identity);
  const late = await harness.runtime.record(observation(), stale.request);
  await harness.runtime.flush();

  assert.equal(late.recorded, false);
  assert.equal(
    (await harness.diagnosticsStorage.loadSnapshot(harness.identity)).snapshot,
    null,
  );
});

test("identity switch and logout invalidate old request captures", async () => {
  const identityA = await identityFor("runtime-user-a");
  const identityB = await identityFor("runtime-user-b");
  const harness = await createLocalRuntime({ identity: identityA });
  const requestA = requestFor(harness.runtime, identityA);

  harness.currentIdentity.value = identityB;
  assert.equal(
    (await harness.runtime.record(observation(), requestA.request)).recorded,
    false,
  );
  harness.currentIdentity.value = null;
  assert.equal(
    (await harness.runtime.initialize()).reason,
    "invalid-identity",
  );
  assert.equal(harness.runtime.getObservationMode(), "off");
});

test("request coordinator eligibility binds diagnostics to the saved Sunland target", async () => {
  const harness = await createLocalRuntime();
  let currentUserId = "runtime-user";
  let conversations = [{
    id: 1,
    provider: "sunland",
    model: "frost",
    userId: "runtime-user",
    history: [],
    semanticContext: {
      schemaVersion: 1,
      version: 0,
      recentTurns: [],
    },
  }, {
    id: 2,
    provider: "sunland",
    model: "frost",
    userId: "runtime-user",
    history: [],
    semanticContext: {
      schemaVersion: 1,
      version: 0,
      recentTurns: [],
    },
  }];
  const coordinator = new RequestCoordinator({
    getConversation: id => conversations.find(item => item.id === id),
    getCurrentUserId: () => currentUserId,
  });

  function begin(conversationId) {
    const conversation = conversations.find(item => item.id === conversationId);
    const request = coordinator.begin({
      conversation,
      identity: harness.identity,
      userId: "runtime-user",
      providerId: "sunland",
      model: "frost",
      deep: false,
      history: conversation.history,
      diagnostics: harness.runtime.captureRequest(
        "sunland",
        harness.identity,
      ),
    });
    request.canRecordDiagnostics = () => coordinator.canWrite(request);
    return request;
  }

  const switchedViewRequest = begin(1);
  assert.equal(
    coordinator.appendMessage(
      switchedViewRequest,
      { role: "assistant", content: "saved" },
    ),
    true,
  );
  assert.equal(
    (await harness.runtime.record(
      observation(),
      switchedViewRequest,
    )).recorded,
    true,
  );
  coordinator.finish(switchedViewRequest);

  const deletedRequest = begin(2);
  conversations = conversations.filter(item => item.id !== 2);
  assert.equal(
    (await harness.runtime.record(observation(), deletedRequest)).recorded,
    false,
  );

  conversations.push({
    id: 3,
    provider: "sunland",
    model: "frost",
    userId: "runtime-user",
    history: [],
    semanticContext: {
      schemaVersion: 1,
      version: 0,
      recentTurns: [],
    },
  });
  const abortedRequest = begin(3);
  coordinator.abort(abortedRequest, "user");
  assert.equal(
    (await harness.runtime.record(observation(), abortedRequest)).recorded,
    false,
  );

  conversations.push({
    id: 4,
    provider: "sunland",
    model: "frost",
    userId: "runtime-user",
    history: [],
    semanticContext: {
      schemaVersion: 1,
      version: 0,
      recentTurns: [],
    },
  });
  const logoutRequest = begin(4);
  currentUserId = null;
  assert.equal(
    (await harness.runtime.record(observation(), logoutRequest)).recorded,
    false,
  );

  const snapshot = (
    await harness.diagnosticsStorage.loadSnapshot(harness.identity)
  ).snapshot;
  assert.equal(snapshot.counters.requestCompleted, 1);
});

test("two users have independent modes and snapshots", async () => {
  const storage = createStorage();
  const identityA = await identityFor("isolation-a");
  const identityB = await identityFor("isolation-b");
  const currentIdentity = { value: identityA };
  const diagnosticsStorage = createBetaDiagnosticsStorage({
    storage,
    cryptoImpl: webcrypto,
  });
  await diagnosticsStorage.saveMode(identityA, "local");
  await diagnosticsStorage.saveMode(identityB, "local");
  const runtime = createSunlandDiagnosticsRuntime({
    getIdentity: () => currentIdentity.value,
    storageRef: storage,
    cryptoImpl: webcrypto,
    diagnosticsStorage,
    syncChannel: noSyncChannel(),
  });

  await runtime.initialize();
  await runtime.record(
    observation(),
    requestFor(runtime, identityA).request,
  );
  currentIdentity.value = identityB;
  await runtime.initialize();
  await runtime.record(
    observation({ resultCategory: "clarification", reasonCategory: "missing-object", clarificationKind: "missing-object" }),
    requestFor(runtime, identityB).request,
  );

  const snapshotA = (await diagnosticsStorage.loadSnapshot(identityA)).snapshot;
  const snapshotB = (await diagnosticsStorage.loadSnapshot(identityB)).snapshot;
  assert.equal(snapshotA.counters.understood, 1);
  assert.equal(snapshotA.counters.clarification, 0);
  assert.equal(snapshotB.counters.understood, 0);
  assert.equal(snapshotB.counters.clarification, 1);
});

test("diagnostics storage failures are isolated from request completion", async () => {
  const identity = await identityFor("storage-failure-user");
  const diagnosticsStorage = {
    async loadRevision() {
      return { ok: true, revision: 1 };
    },
    async loadMode() {
      return { ok: true, mode: "local" };
    },
    async loadSnapshot() {
      return { ok: true, snapshot: null };
    },
    async saveSnapshot() {
      throw new Error("private storage failure");
    },
  };
  const storage = createStorage();
  storage.setItem(DEVICE_SECRET_STORAGE_KEY, "0".repeat(64));
  const runtime = createSunlandDiagnosticsRuntime({
    getIdentity: () => identity,
    storageRef: storage,
    diagnosticsStorage,
    syncChannel: noSyncChannel(),
  });
  await runtime.initialize();

  const result = await runtime.record(
    observation(),
    requestFor(runtime, identity).request,
  );
  assert.equal(result.ok, false);
  assert.equal(result.recorded, false);
});

test("production wiring is Sunland-only and never logs or uploads summaries", () => {
  assert.match(
    providerSource,
    /observationMode:\s*observationMode\s*===\s*["']summary["']\s*\?\s*["']summary["']\s*:\s*["']off["']/u,
  );
  assert.match(providerSource, /payload\.observationSummary/u);
  assert.doesNotMatch(
    providerSource,
    /localStorage.*observation|saveSnapshot|createBetaDiagnosticsAggregator|console\.(?:log|debug|info).*observation/iu,
  );
  assert.doesNotMatch(
    deepSeekSource,
    /observationMode|observationSummary|SunlandDiagnostics|beta-diagnostics/u,
  );
  assert.match(
    appSource,
    /requestContext\.diagnostics\?\.observationMode\s*\?\?\s*["']off["']/u,
  );
  assert.match(
    appSource,
    /sunlandDiagnosticsRuntime\.record\(\s*result\.observationSummary,\s*requestContext/u,
  );
  assert.doesNotMatch(
    appSource,
    /sendBeacon|sunlandDiagnosticsRuntime\.(?:upload|send)|console\.(?:log|debug|info)\([^)]*observation/iu,
  );
  assert.doesNotMatch(
    appSource,
    /console\.(?:log|debug|info)\([^)]*(?:current user|Realtime:|标题API返回|identity|deviceSecret|namespace)/iu,
  );
});
