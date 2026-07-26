import { buildDiagnosticsExport } from "./export.js";
import {
  copyDiagnosticsSnapshot,
  createEmptyDiagnosticsSnapshot,
  freezeDiagnosticsSnapshot,
  incrementSaturated,
  inspectObservationSummary,
  sanitizeDiagnosticsSnapshot,
} from "./schema.js";

const MODES = new Set(["off", "local"]);

const RESULT_COUNTERS = Object.freeze({
  understood: "understood",
  clarification: "clarification",
  "no-understanding": "noUnderstanding",
  "missing-knowledge": "missingKnowledge",
  "relation-unsupported": "relationUnsupported",
  "context-unresolved": "contextUnresolved",
  "side-effect-blocked": "sideEffectBlocked",
  "safe-fallback": "safeFallback",
});

function increment(target, key) {
  target[key] = incrementSaturated(target[key]);
}

function updatedSnapshot(snapshot, summary) {
  const next = copyDiagnosticsSnapshot(snapshot);
  if (next === null) return null;

  increment(next.counters, "requestCompleted");
  increment(next.counters, RESULT_COUNTERS[summary.resultCategory]);
  if (summary.legacyFallback) increment(next.counters, "legacyFallback");
  if (summary.semanticAdopted) increment(next.counters, "semanticAdopted");
  if (summary.contextUsed) increment(next.counters, "contextUsed");

  increment(next.resultCategories, summary.resultCategory);
  increment(next.reasonCategories, summary.reasonCategory);
  increment(next.relationCategories, summary.relationCategory);
  increment(next.clarificationKinds, summary.clarificationKind);
  increment(next.durations.total, summary.totalDurationBucket);
  increment(next.durations.semantic, summary.semanticDurationBucket);
  increment(next.durations.reasoner, summary.reasonerDurationBucket);
  increment(next.knowledgeSizeBuckets, summary.knowledgeCountBucket);
  increment(next.reasonerPathBuckets, summary.pathLengthBucket);

  return freezeDiagnosticsSnapshot(next);
}

export function createBetaDiagnosticsAggregator({
  mode = "off",
  snapshot = null,
} = {}) {
  let currentMode = MODES.has(mode) ? mode : "off";
  let currentSnapshot =
    sanitizeDiagnosticsSnapshot(snapshot) ??
    createEmptyDiagnosticsSnapshot();
  let disposed = false;

  function unavailable() {
    return Object.freeze({
      ok: false,
      reason: "disposed",
    });
  }

  return Object.freeze({
    record(summary) {
      if (disposed) return unavailable();
      if (currentMode === "off") {
        return Object.freeze({
          ok: true,
          recorded: false,
          reason: "mode-off",
        });
      }

      try {
        const inspection = inspectObservationSummary(summary);
        if (!inspection.ok) {
          return Object.freeze({
            ok: false,
            reason: inspection.reason,
            recorded: false,
          });
        }

        const next = updatedSnapshot(currentSnapshot, summary);
        if (next === null) {
          return Object.freeze({
            ok: false,
            reason: "invalid-snapshot",
            recorded: false,
          });
        }
        currentSnapshot = next;
        return Object.freeze({ ok: true, recorded: true });
      } catch {
        return Object.freeze({
          ok: false,
          reason: "aggregation-failed",
          recorded: false,
        });
      }
    },

    getSnapshot() {
      if (disposed) return unavailable();
      const copy = sanitizeDiagnosticsSnapshot(currentSnapshot);
      return copy === null
        ? Object.freeze({ ok: false, reason: "invalid-snapshot" })
        : Object.freeze({ ok: true, snapshot: copy });
    },

    getExportPreview() {
      if (disposed) return unavailable();
      return buildDiagnosticsExport(currentSnapshot);
    },

    clear() {
      if (disposed) return unavailable();
      currentSnapshot = createEmptyDiagnosticsSnapshot();
      return Object.freeze({ ok: true });
    },

    getMode() {
      return disposed
        ? unavailable()
        : Object.freeze({ ok: true, mode: currentMode });
    },

    setMode(nextMode) {
      if (disposed) return unavailable();
      if (!MODES.has(nextMode)) {
        return Object.freeze({
          ok: false,
          reason: "invalid-mode",
        });
      }
      currentMode = nextMode;
      return Object.freeze({ ok: true, mode: currentMode });
    },

    dispose() {
      if (disposed) return unavailable();
      currentMode = "off";
      currentSnapshot = createEmptyDiagnosticsSnapshot();
      disposed = true;
      return Object.freeze({ ok: true });
    },
  });
}
