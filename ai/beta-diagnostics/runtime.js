import {
  createBetaDiagnosticsAggregator,
  createBetaDiagnosticsStorage,
  DEVICE_SECRET_STORAGE_KEY,
  isBetaDiagnosticsRevisionKey,
} from "./index.js";
import { createBetaDiagnosticsSyncChannel } from "./sync.js";
import {
  getVerifiedUserId,
  isVerifiedIdentity,
} from "../verified-identity.js";

function result(ok, details = {}) {
  return Object.freeze({ ok, ...details });
}

function sameIdentity(left, right) {
  if (!isVerifiedIdentity(left) || !isVerifiedIdentity(right)) return false;
  return left === right &&
    getVerifiedUserId(left) === getVerifiedUserId(right);
}

export function createSunlandDiagnosticsRuntime({
  getIdentity,
  storageRef = globalThis.localStorage,
  windowRef = globalThis.window,
  cryptoImpl = globalThis.crypto,
  diagnosticsStorage = createBetaDiagnosticsStorage({
    storage: storageRef,
    cryptoImpl,
  }),
  aggregatorFactory = createBetaDiagnosticsAggregator,
  syncChannel = createBetaDiagnosticsSyncChannel({
    BroadcastChannelImpl: windowRef?.BroadcastChannel,
  }),
} = {}) {
  let identity = null;
  let aggregator = null;
  let mode = "off";
  let storageRevision = 0;
  let generation = 0;
  let initializationVersion = 0;
  let disposed = false;
  let persistChain = Promise.resolve();

  function currentIdentity() {
    try {
      const current = getIdentity?.() ?? null;
      return isVerifiedIdentity(current) ? current : null;
    } catch {
      return null;
    }
  }

  function deviceBoundaryExists() {
    try {
      return storageRef?.getItem(DEVICE_SECRET_STORAGE_KEY) !== null;
    } catch {
      return null;
    }
  }

  function replaceAggregator(nextMode, snapshot = null) {
    aggregator?.dispose();
    aggregator = nextMode === "local"
      ? aggregatorFactory({ mode: "local", snapshot })
      : null;
    mode = nextMode;
  }

  function invalidate() {
    generation += 1;
    replaceAggregator("off");
    identity = null;
    storageRevision = 0;
  }

  async function loadStableState(targetIdentity, version) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = await diagnosticsStorage.loadRevision(targetIdentity);
      const loadedMode = await diagnosticsStorage.loadMode(targetIdentity);
      const loadedSnapshot = loadedMode.ok && loadedMode.mode === "local"
        ? await diagnosticsStorage.loadSnapshot(targetIdentity)
        : result(true, { snapshot: null });
      const after = await diagnosticsStorage.loadRevision(targetIdentity);

      if (
        disposed ||
        version !== initializationVersion ||
        !sameIdentity(targetIdentity, currentIdentity())
      ) {
        return result(false, { reason: "stale-initialization" });
      }
      if (!before.ok || !loadedMode.ok || !loadedSnapshot.ok || !after.ok) {
        return result(false, { reason: "storage-unavailable" });
      }
      if (before.revision !== after.revision) continue;

      identity = targetIdentity;
      storageRevision = after.revision;
      replaceAggregator(
        loadedMode.mode,
        loadedMode.mode === "local" ? loadedSnapshot.snapshot : null,
      );
      return result(true, { mode });
    }
    return result(false, { reason: "unstable-storage-state" });
  }

  async function initialize() {
    if (disposed) return result(false, { reason: "disposed" });
    const version = ++initializationVersion;
    invalidate();

    const targetIdentity = currentIdentity();
    if (!targetIdentity) return result(false, { reason: "invalid-identity" });

    const boundary = deviceBoundaryExists();
    if (boundary === null) {
      return result(false, { reason: "storage-unavailable" });
    }
    if (!boundary) {
      identity = targetIdentity;
      return result(true, { mode: "off" });
    }

    try {
      const loaded = await loadStableState(targetIdentity, version);
      if (!loaded.ok && version === initializationVersion) invalidate();
      return loaded;
    } catch {
      if (version === initializationVersion) invalidate();
      return result(false, { reason: "initialization-failed" });
    }
  }

  function captureRequest(providerId, requestIdentity) {
    const enabled = (
      !disposed &&
      providerId === "sunland" &&
      mode === "local" &&
      aggregator &&
      sameIdentity(identity, requestIdentity) &&
      sameIdentity(identity, currentIdentity())
    );
    return Object.freeze({
      mode: enabled ? "local" : "off",
      observationMode: enabled ? "summary" : "off",
      generation,
      storageRevision,
      identity: enabled ? identity : null,
    });
  }

  function captureIsCurrent(capture) {
    return Boolean(
      capture &&
      capture.mode === "local" &&
      capture.observationMode === "summary" &&
      capture.generation === generation &&
      capture.storageRevision === storageRevision &&
      mode === "local" &&
      aggregator &&
      sameIdentity(capture.identity, identity) &&
      sameIdentity(identity, currentIdentity())
    );
  }

  function record(summary, requestContext) {
    try {
      const capture = requestContext?.diagnostics;
      if (
        disposed ||
        requestContext?.providerId !== "sunland" ||
        requestContext?.controller?.signal?.aborted ||
        requestContext?.status !== "active" ||
        requestContext?.identity !== capture?.identity ||
        typeof requestContext?.canRecordDiagnostics !== "function" ||
        requestContext.canRecordDiagnostics() !== true ||
        !captureIsCurrent(capture)
      ) {
        return Promise.resolve(result(true, {
          recorded: false,
          reason: "request-ineligible",
        }));
      }

      const recorded = aggregator.record(summary);
      if (!recorded.ok || !recorded.recorded) {
        return Promise.resolve(result(false, {
          recorded: false,
          reason: recorded.reason ?? "invalid-summary",
        }));
      }
      const snapshotResult = aggregator.getSnapshot();
      if (!snapshotResult.ok) {
        return Promise.resolve(result(false, {
          recorded: false,
          reason: "invalid-snapshot",
        }));
      }

      const snapshot = snapshotResult.snapshot;
      const capturedGeneration = generation;
      const capturedRevision = storageRevision;
      const capturedIdentity = identity;
      persistChain = persistChain
        .catch(() => {})
        .then(async () => {
          if (
            disposed ||
            generation !== capturedGeneration ||
            storageRevision !== capturedRevision ||
            !sameIdentity(capturedIdentity, identity) ||
            !sameIdentity(identity, currentIdentity()) ||
            mode !== "local"
          ) {
            return result(false, { reason: "stale-runtime" });
          }
          let saved;
          try {
            saved = await diagnosticsStorage.saveSnapshot(
              capturedIdentity,
              snapshot,
              { expectedRevision: capturedRevision },
            );
          } catch {
            return result(false, { reason: "storage-failed" });
          }
          if (saved.reason === "stale-revision") {
            void initialize();
          }
          if (saved.ok) syncChannel?.notify?.("snapshot-updated");
          return saved;
        });
      return persistChain.then(saved => result(saved.ok, {
        recorded: saved.ok,
        reason: saved.reason,
      }));
    } catch {
      return Promise.resolve(result(false, {
        recorded: false,
        reason: "runtime-failed",
      }));
    }
  }

  function isEnabled() {
    return mode === "local" &&
      Boolean(aggregator) &&
      sameIdentity(identity, currentIdentity());
  }

  function getObservationMode() {
    return isEnabled() ? "summary" : "off";
  }

  async function flush() {
    try {
      await persistChain;
      return result(true);
    } catch {
      return result(false, { reason: "flush-failed" });
    }
  }

  function dispose() {
    if (disposed) return result(false, { reason: "disposed" });
    disposed = true;
    ++initializationVersion;
    invalidate();
    unsubscribeSync?.();
    syncChannel?.dispose?.();
    windowRef?.removeEventListener?.("storage", handleStorageChange);
    return result(true);
  }

  function handleStorageChange(event) {
    if (
      disposed ||
      !isBetaDiagnosticsRevisionKey(event?.key)
    ) return;
    ++initializationVersion;
    invalidate();
    void initialize();
  }

  const unsubscribeSync = syncChannel?.subscribe?.(type => {
    if (type === "snapshot-updated") return;
    if (disposed) return;
    ++initializationVersion;
    invalidate();
    void initialize();
  });
  windowRef?.addEventListener?.("storage", handleStorageChange);

  return Object.freeze({
    initialize,
    isEnabled,
    getObservationMode,
    captureRequest,
    record,
    flush,
    dispose,
  });
}
