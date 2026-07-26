import {
  copyDiagnosticsSnapshot,
  freezeDiagnosticsSnapshot,
} from "./schema.js";

const EXPORT_SCHEMA = "sunland-beta-diagnostics-export";

export function buildDiagnosticsExport(snapshot) {
  try {
    const safe = copyDiagnosticsSnapshot(snapshot);
    if (safe === null) {
      return Object.freeze({
        ok: false,
        reason: "invalid-snapshot",
      });
    }

    const exportData = freezeDiagnosticsSnapshot({
      schema: EXPORT_SCHEMA,
      diagnosticsSchemaVersion: safe.diagnosticsSchemaVersion,
      versions: safe.versions,
      counters: safe.counters,
      resultCategories: safe.resultCategories,
      reasonCategories: safe.reasonCategories,
      relationCategories: safe.relationCategories,
      clarificationKinds: safe.clarificationKinds,
      durations: safe.durations,
      knowledgeSizeBuckets: safe.knowledgeSizeBuckets,
      reasonerPathBuckets: safe.reasonerPathBuckets,
    });

    return Object.freeze({
      ok: true,
      exportData,
      json: JSON.stringify(exportData),
    });
  } catch {
    return Object.freeze({
      ok: false,
      reason: "export-failed",
    });
  }
}
