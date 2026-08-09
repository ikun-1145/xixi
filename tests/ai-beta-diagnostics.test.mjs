import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { webcrypto } from "node:crypto";

import {
  createBetaDiagnosticsAggregator,
  createBetaDiagnosticsStorage,
  createEmptyDiagnosticsSnapshot,
  DEVICE_SECRET_STORAGE_KEY,
  MAX_DIAGNOSTIC_COUNT,
  SUPPORTED_OBSERVATION_VERSIONS,
  validateDiagnosticsSnapshot,
} from "../ai/beta-diagnostics/index.js";
import { IdentityAuthority } from "../ai/verified-identity.js";

const betaDirectory = new URL("../ai/beta-diagnostics/", import.meta.url);

function observation(overrides = {}) {
  return Object.freeze({
    schemaVersion: 1,
    sunlandCoreVersion: "0.1.0",
    semanticSchemaVersion: 1,
    contextSchemaVersion: 1,
    resultCategory: "understood",
    reasonCategory: "complete-passive-understanding",
    relationCategory: "会",
    semanticAdopted: true,
    legacyFallback: false,
    contextUsed: false,
    clarificationKind: "none",
    pathLengthBucket: "direct",
    knowledgeCountBucket: "1-99",
    totalDurationBucket: "1-5ms",
    semanticDurationBucket: "under-1ms",
    reasonerDurationBucket: "under-1ms",
    queriedRelation: "会",
    alternativeKnownRelation: "none",
    alignmentResult: "aligned",
    ...overrides,
  });
}

function trackedStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  const reads = [];
  const writes = [];
  const removals = [];
  return {
    reads,
    writes,
    removals,
    getItem(key) {
      reads.push(key);
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      writes.push(key);
      values.set(key, String(value));
    },
    removeItem(key) {
      removals.push(key);
      values.delete(key);
    },
    keys() {
      return [...values.keys()];
    },
    setRaw(key, value) {
      values.set(key, value);
    },
    getRaw(key) {
      return values.get(key);
    },
  };
}

function tokenFor(userId, exp = Math.floor(Date.now() / 1000) + 3600) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "test" })}.${encode({ sub: userId, exp })}.signature`;
}

async function verifiedIdentity(userId) {
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
  return { authority, identity: resolved.identity };
}

function recordedSnapshot(summary = observation()) {
  const aggregator = createBetaDiagnosticsAggregator({ mode: "local" });
  assert.deepEqual(aggregator.record(summary), { ok: true, recorded: true });
  const result = aggregator.getSnapshot();
  assert.equal(result.ok, true);
  return result.snapshot;
}

test("aggregator defaults off and off record has no state or side effects", () => {
  const aggregator = createBetaDiagnosticsAggregator();
  const before = aggregator.getSnapshot().snapshot;
  const recordResult = aggregator.record({
    raw: "must not be inspected while off",
  });
  const after = aggregator.getSnapshot().snapshot;

  assert.deepEqual(aggregator.getMode(), { ok: true, mode: "off" });
  assert.deepEqual(recordResult, {
    ok: true,
    recorded: false,
    reason: "mode-off",
  });
  assert.deepEqual(after, before);
  assert.equal(after.counters.requestCompleted, 0);
});

test("local aggregation increments only fixed counters and buckets", () => {
  const aggregator = createBetaDiagnosticsAggregator({ mode: "local" });
  assert.equal(aggregator.record(observation()).ok, true);
  assert.equal(aggregator.record(observation({
    resultCategory: "clarification",
    reasonCategory: "missing-object",
    relationCategory: "有",
    semanticAdopted: false,
    legacyFallback: true,
    contextUsed: true,
    clarificationKind: "missing-object",
    pathLengthBucket: "none",
    knowledgeCountBucket: "100-999",
    totalDurationBucket: "5-16ms",
    semanticDurationBucket: "1-5ms",
    reasonerDurationBucket: "unavailable",
    queriedRelation: "有",
    alignmentResult: "unavailable",
  })).ok, true);

  const snapshot = aggregator.getSnapshot().snapshot;
  assert.equal(snapshot.counters.requestCompleted, 2);
  assert.equal(snapshot.counters.understood, 1);
  assert.equal(snapshot.counters.clarification, 1);
  assert.equal(snapshot.counters.legacyFallback, 1);
  assert.equal(snapshot.counters.semanticAdopted, 1);
  assert.equal(snapshot.counters.contextUsed, 1);
  assert.equal(snapshot.resultCategories.clarification, 1);
  assert.equal(snapshot.reasonCategories["missing-object"], 1);
  assert.equal(snapshot.relationCategories["有"], 1);
  assert.equal(snapshot.clarificationKinds["missing-object"], 1);
  assert.equal(snapshot.durations.total["5-16ms"], 1);
  assert.equal(snapshot.knowledgeSizeBuckets["100-999"], 1);
  assert.equal(snapshot.reasonerPathBuckets.none, 1);
});

test("invalid, extra-field and incompatible summaries are rejected unchanged", () => {
  const aggregator = createBetaDiagnosticsAggregator({ mode: "local" });
  const before = aggregator.getSnapshot().snapshot;

  assert.deepEqual(aggregator.record(null), {
    ok: false,
    reason: "invalid-summary",
    recorded: false,
  });
  assert.equal(
    aggregator.record({ ...observation(), raw: "private" }).reason,
    "invalid-summary",
  );
  assert.equal(
    aggregator.record(observation({ resultCategory: "custom-private" })).reason,
    "invalid-summary",
  );
  assert.equal(
    aggregator.record(observation({ schemaVersion: 2 })).reason,
    "incompatible-version",
  );
  assert.deepEqual(aggregator.getSnapshot().snapshot, before);
});

test("snapshot has fixed maps, no event arrays, order or free-text fields", () => {
  const snapshot = recordedSnapshot();
  const serialized = JSON.stringify(snapshot);

  assert.equal(validateDiagnosticsSnapshot(snapshot), true);
  assert.equal(
    Object.values(snapshot).some(value => Array.isArray(value)),
    false,
  );
  assert.doesNotMatch(
    serialized,
    /Alice Chen|private input|full reply|"(?:subject|object|conversationId|requestId|turnId|candidateId|stack|timestamp)"\s*:/iu,
  );
  assert.deepEqual(Object.keys(snapshot), [
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

test("counters saturate safely and returned snapshots cannot mutate state", () => {
  const saturated = JSON.parse(
    JSON.stringify(createEmptyDiagnosticsSnapshot()),
  );
  saturated.counters.requestCompleted = MAX_DIAGNOSTIC_COUNT;
  saturated.counters.understood = MAX_DIAGNOSTIC_COUNT;
  const aggregator = createBetaDiagnosticsAggregator({
    mode: "local",
    snapshot: saturated,
  });
  aggregator.record(observation());
  const first = aggregator.getSnapshot().snapshot;

  assert.equal(first.counters.requestCompleted, MAX_DIAGNOSTIC_COUNT);
  assert.equal(first.counters.understood, MAX_DIAGNOSTIC_COUNT);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.counters), true);
  assert.throws(() => {
    first.counters.requestCompleted = 0;
  }, TypeError);
  assert.equal(
    aggregator.getSnapshot().snapshot.counters.requestCompleted,
    MAX_DIAGNOSTIC_COUNT,
  );
});

test("anonymous export is rebuilt from a strict whitelist", () => {
  const aggregator = createBetaDiagnosticsAggregator({ mode: "local" });
  aggregator.record(observation());
  const preview = aggregator.getExportPreview();

  assert.equal(preview.ok, true);
  assert.deepEqual(Object.keys(preview.exportData), [
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
  assert.doesNotMatch(
    preview.json,
    /Alice Chen|"(?:deviceSecret|opaqueNamespace|localStorageKey|userId|conversationId|requestId|turnId|timestamp|subject|object)"\s*:/iu,
  );
});

test("dispose clears memory for logout or user switch", () => {
  const userA = createBetaDiagnosticsAggregator({ mode: "local" });
  userA.record(observation());
  assert.equal(userA.getSnapshot().snapshot.counters.requestCompleted, 1);
  assert.deepEqual(userA.dispose(), { ok: true });
  assert.equal(userA.getSnapshot().reason, "disposed");

  const userB = createBetaDiagnosticsAggregator({ mode: "local" });
  assert.equal(userB.getSnapshot().snapshot.counters.requestCompleted, 0);
});

test("invalid identity fails closed before storage or crypto access", async () => {
  const storage = trackedStorage({ user: JSON.stringify({ id: "user-b" }) });
  let cryptoReads = 0;
  const diagnosticsStorage = createBetaDiagnosticsStorage({
    storage,
    cryptoImpl: {
      get subtle() {
        cryptoReads += 1;
        throw new Error("must not access crypto");
      },
      getRandomValues() {
        cryptoReads += 1;
        throw new Error("must not generate");
      },
    },
  });

  for (const identity of [null, undefined, {}, "user-a"]) {
    assert.equal((await diagnosticsStorage.loadSnapshot(identity)).reason, "invalid-identity");
    assert.equal((await diagnosticsStorage.saveSnapshot(identity, createEmptyDiagnosticsSnapshot())).reason, "invalid-identity");
    assert.equal((await diagnosticsStorage.clearSnapshot(identity)).reason, "invalid-identity");
  }
  assert.deepEqual(storage.reads, []);
  assert.deepEqual(storage.writes, []);
  assert.deepEqual(storage.removals, []);
  assert.equal(cryptoReads, 0);
});

test("Verified Identity uses HMAC opaque per-user keys and ignores cached user", async () => {
  const storage = trackedStorage({
    user: JSON.stringify({ id: "forged-user" }),
  });
  let digestCalls = 0;
  let hmacSigns = 0;
  const cryptoImpl = {
    getRandomValues(array) {
      return webcrypto.getRandomValues(array);
    },
    subtle: {
      importKey(...args) {
        assert.equal(args[2].name, "HMAC");
        assert.equal(args[2].hash, "SHA-256");
        return webcrypto.subtle.importKey(...args);
      },
      sign(...args) {
        hmacSigns += 1;
        assert.equal(args[0], "HMAC");
        return webcrypto.subtle.sign(...args);
      },
      digest() {
        digestCalls += 1;
        throw new Error("plain digest must not be used");
      },
    },
  };
  const diagnosticsStorage = createBetaDiagnosticsStorage({
    storage,
    cryptoImpl,
  });
  const identityA = (await verifiedIdentity("user-a")).identity;
  const identityB = (await verifiedIdentity("user-b")).identity;
  const snapshot = createEmptyDiagnosticsSnapshot();

  assert.equal((await diagnosticsStorage.saveSnapshot(identityA, snapshot)).ok, true);
  assert.equal((await diagnosticsStorage.saveSnapshot(identityB, snapshot)).ok, true);
  const snapshotKeys = storage.keys().filter(key =>
    key.startsWith("sunland_beta_diag_v1::"),
  );

  assert.equal(snapshotKeys.length, 2);
  assert.notEqual(snapshotKeys[0], snapshotKeys[1]);
  assert.equal(snapshotKeys.some(key => /user-a|user-b|forged-user/u.test(key)), false);
  assert.equal(storage.reads.includes("user"), false);
  assert.equal(storage.writes.includes("user"), false);
  assert.equal(digestCalls, 0);
  assert.ok(hmacSigns >= 2);
  assert.ok(storage.keys().includes(DEVICE_SECRET_STORAGE_KEY));
  assert.match(storage.getRaw(DEVICE_SECRET_STORAGE_KEY), /^[0-9a-f]{64}$/u);
});

test("mode defaults off and is isolated in the same opaque identity boundary", async () => {
  const storage = trackedStorage();
  const diagnosticsStorage = createBetaDiagnosticsStorage({
    storage,
    cryptoImpl: webcrypto,
  });
  const identityA = (await verifiedIdentity("mode-user-a")).identity;
  const identityB = (await verifiedIdentity("mode-user-b")).identity;

  assert.deepEqual(await diagnosticsStorage.loadMode(identityA), {
    ok: true,
    mode: "off",
  });
  assert.deepEqual(await diagnosticsStorage.saveMode(identityA, "local"), {
    ok: true,
    mode: "local",
  });
  assert.deepEqual(await diagnosticsStorage.loadMode(identityA), {
    ok: true,
    mode: "local",
  });
  assert.deepEqual(await diagnosticsStorage.loadMode(identityB), {
    ok: true,
    mode: "off",
  });
  assert.equal(
    storage.keys().filter(key => key.startsWith("sunland_beta_diag_mode_v1::")).length,
    1,
  );
});

test("damaged JSON and extra snapshot fields are rejected without migration", async () => {
  const storage = trackedStorage();
  const diagnosticsStorage = createBetaDiagnosticsStorage({
    storage,
    cryptoImpl: webcrypto,
  });
  const identity = (await verifiedIdentity("damaged-user")).identity;
  const snapshot = createEmptyDiagnosticsSnapshot();
  await diagnosticsStorage.saveSnapshot(identity, snapshot);
  const key = storage.keys().find(value => value.startsWith("sunland_beta_diag_v1::"));

  storage.setRaw(key, "{not-json");
  assert.deepEqual(await diagnosticsStorage.loadSnapshot(identity), {
    ok: true,
    reason: "invalid-snapshot",
    snapshot: null,
    discarded: true,
  });
  assert.equal(storage.getRaw(key), undefined);
  await diagnosticsStorage.saveSnapshot(identity, snapshot);
  storage.setRaw(key, JSON.stringify({ ...snapshot, metadata: "private" }));
  assert.deepEqual(await diagnosticsStorage.loadSnapshot(identity), {
    ok: true,
    reason: "invalid-snapshot",
    snapshot: null,
    discarded: true,
  });
  assert.equal(storage.getRaw(key), undefined);
});

test("storage enforces its bounded byte limit before writing", async () => {
  const storage = trackedStorage();
  const diagnosticsStorage = createBetaDiagnosticsStorage({
    storage,
    cryptoImpl: webcrypto,
    maxBytes: 64,
  });
  const identity = (await verifiedIdentity("size-user")).identity;
  const beforeWrites = storage.writes.length;
  const saved = await diagnosticsStorage.saveSnapshot(
    identity,
    createEmptyDiagnosticsSnapshot(),
  );

  assert.equal(saved.reason, "snapshot-too-large");
  assert.deepEqual(storage.writes.slice(beforeWrites), []);
});

test("clear removes only the current user's snapshot", async () => {
  const storage = trackedStorage();
  const diagnosticsStorage = createBetaDiagnosticsStorage({
    storage,
    cryptoImpl: webcrypto,
  });
  const identityA = (await verifiedIdentity("clear-user-a")).identity;
  const identityB = (await verifiedIdentity("clear-user-b")).identity;
  const snapshot = recordedSnapshot();
  await diagnosticsStorage.saveSnapshot(identityA, snapshot);
  await diagnosticsStorage.saveSnapshot(identityB, snapshot);
  assert.equal((await diagnosticsStorage.clearSnapshot(identityA)).ok, true);

  assert.deepEqual(await diagnosticsStorage.hasSnapshot(identityA), {
    ok: true,
    hasSnapshot: false,
  });
  assert.deepEqual(await diagnosticsStorage.hasSnapshot(identityB), {
    ok: true,
    hasSnapshot: true,
  });
  assert.ok(storage.keys().includes(DEVICE_SECRET_STORAGE_KEY));
});

test("storage failures return structured results and never throw", async () => {
  const failingStorage = {
    getItem() {
      throw new Error("private storage error");
    },
    setItem() {
      throw new Error("private storage error");
    },
    removeItem() {
      throw new Error("private storage error");
    },
  };
  const diagnosticsStorage = createBetaDiagnosticsStorage({
    storage: failingStorage,
    cryptoImpl: webcrypto,
  });
  const identity = (await verifiedIdentity("failure-user")).identity;

  assert.equal((await diagnosticsStorage.loadSnapshot(identity)).reason, "storage-failed");
  assert.equal((await diagnosticsStorage.saveSnapshot(identity, createEmptyDiagnosticsSnapshot())).reason, "storage-failed");
  assert.equal((await diagnosticsStorage.clearSnapshot(identity)).reason, "storage-failed");
  assert.equal((await diagnosticsStorage.loadMode(identity)).reason, "storage-failed");
});

test("diagnostics modules contain no network path or production integration", () => {
  const files = ["aggregator.js", "schema.js", "storage.js", "export.js", "index.js"];
  const source = files
    .map(file => fs.readFileSync(new URL(file, betaDirectory), "utf8"))
    .join("\n");

  assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon/iu);
  assert.doesNotMatch(source, /localStorage\.user|conversations_|sunland_knowledge_/u);
  assert.doesNotMatch(source, /subtle\.digest\s*\(/u);
  assert.doesNotMatch(source, /SunlandProvider|DeepSeek|ai\/app\.js|sunland-core\.js/u);
});

test("browser diagnostics accepts only the deployed 0.1.0 remote contract", () => {
  assert.deepEqual(SUPPORTED_OBSERVATION_VERSIONS, {
    sunlandCoreVersion: "0.1.0",
    semanticSchemaVersion: 1,
    contextSchemaVersion: 1,
    observationSchemaVersion: 1,
  });
});
