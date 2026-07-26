export const DIAGNOSTICS_SCHEMA = "sunland-beta-diagnostics";
export const DIAGNOSTICS_SCHEMA_VERSION = 1;
export const MAX_DIAGNOSTIC_COUNT = 1_000_000_000;

export const SUPPORTED_OBSERVATION_VERSIONS = Object.freeze({
  sunlandCoreVersion: "0.1.0",
  semanticSchemaVersion: 1,
  contextSchemaVersion: 1,
  observationSchemaVersion: 1,
});

export const RESULT_CATEGORIES = Object.freeze([
  "understood",
  "clarification",
  "no-understanding",
  "missing-knowledge",
  "relation-unsupported",
  "context-unresolved",
  "side-effect-blocked",
  "safe-fallback",
]);

export const REASON_CATEGORIES = Object.freeze([
  "complete-passive-understanding",
  "missing-subject",
  "missing-relation",
  "missing-object",
  "ambiguous-intent",
  "conflicting-candidates",
  "insufficient-evidence",
  "missing-knowledge",
  "unsupported-relation",
  "unresolved-context",
  "blocked-side-effect",
  "semantic-runtime",
  "reasoner-error",
  "unknown-safe-fallback",
  "unclassified",
]);

export const RELATION_CATEGORIES = Object.freeze([
  "属于",
  "是",
  "会",
  "喜欢",
  "在",
  "有",
  "意思是",
  "开发者",
  "none",
  "unknown",
]);

export const CLARIFICATION_KINDS = Object.freeze([
  "ambiguous-intent",
  "missing-subject",
  "missing-relation",
  "missing-object",
  "uncertain-name",
  "uncertain-teaching",
  "conflicting-candidates",
  "none",
]);

export const DURATION_BUCKETS = Object.freeze([
  "under-1ms",
  "1-5ms",
  "5-16ms",
  "16-50ms",
  "over-50ms",
  "unavailable",
]);

export const KNOWLEDGE_SIZE_BUCKETS = Object.freeze([
  "0",
  "1-99",
  "100-999",
  "1000-4999",
  "5000-plus",
  "unavailable",
]);

export const REASONER_PATH_BUCKETS = Object.freeze([
  "direct",
  "2-5",
  "6-20",
  "21-50",
  "51-plus",
  "none",
  "unavailable",
]);

export const ALIGNMENT_RESULTS = Object.freeze([
  "aligned",
  "possible-mismatch",
  "no-alternative-known",
  "unavailable",
]);

export const COUNTER_KEYS = Object.freeze([
  "requestCompleted",
  "understood",
  "clarification",
  "noUnderstanding",
  "missingKnowledge",
  "relationUnsupported",
  "contextUnresolved",
  "sideEffectBlocked",
  "legacyFallback",
  "safeFallback",
  "semanticAdopted",
  "contextUsed",
]);

const OBSERVATION_KEYS = Object.freeze([
  "schemaVersion",
  "sunlandCoreVersion",
  "semanticSchemaVersion",
  "contextSchemaVersion",
  "resultCategory",
  "reasonCategory",
  "relationCategory",
  "semanticAdopted",
  "legacyFallback",
  "contextUsed",
  "clarificationKind",
  "pathLengthBucket",
  "knowledgeCountBucket",
  "totalDurationBucket",
  "semanticDurationBucket",
  "reasonerDurationBucket",
  "queriedRelation",
  "alternativeKnownRelation",
  "alignmentResult",
]);

const SNAPSHOT_KEYS = Object.freeze([
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

const VERSION_KEYS = Object.freeze([
  "sunlandCoreVersion",
  "semanticSchemaVersion",
  "contextSchemaVersion",
  "observationSchemaVersion",
]);

const DURATION_GROUP_KEYS = Object.freeze([
  "total",
  "semantic",
  "reasoner",
]);

const RESULT_CATEGORY_SET = new Set(RESULT_CATEGORIES);
const REASON_CATEGORY_SET = new Set(REASON_CATEGORIES);
const RELATION_CATEGORY_SET = new Set(RELATION_CATEGORIES);
const CLARIFICATION_KIND_SET = new Set(CLARIFICATION_KINDS);
const DURATION_BUCKET_SET = new Set(DURATION_BUCKETS);
const KNOWLEDGE_SIZE_BUCKET_SET = new Set(KNOWLEDGE_SIZE_BUCKETS);
const REASONER_PATH_BUCKET_SET = new Set(REASONER_PATH_BUCKETS);
const ALIGNMENT_RESULT_SET = new Set(ALIGNMENT_RESULTS);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactDataKeys(value, expectedKeys) {
  try {
    if (!isRecord(value)) return false;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expectedKeys.length ||
      !keys.every(key => typeof key === "string" && expectedKeys.includes(key))
    ) {
      return false;
    }
    return expectedKeys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor &&
        "value" in descriptor &&
        descriptor.get === undefined &&
        descriptor.set === undefined;
    });
  } catch {
    return false;
  }
}

function isSafeCount(value) {
  return Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_DIAGNOSTIC_COUNT;
}

function isCountMap(value, keys) {
  return hasExactDataKeys(value, keys) &&
    keys.every(key => isSafeCount(value[key]));
}

function zeroMap(keys) {
  return Object.fromEntries(keys.map(key => [key, 0]));
}

function copyMap(value, keys) {
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}

function deepFreeze(value) {
  if (!isRecord(value) || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function currentVersions() {
  return {
    sunlandCoreVersion: SUPPORTED_OBSERVATION_VERSIONS.sunlandCoreVersion,
    semanticSchemaVersion: SUPPORTED_OBSERVATION_VERSIONS.semanticSchemaVersion,
    contextSchemaVersion: SUPPORTED_OBSERVATION_VERSIONS.contextSchemaVersion,
    observationSchemaVersion: SUPPORTED_OBSERVATION_VERSIONS.observationSchemaVersion,
  };
}

function versionsMatchCurrent(value) {
  return hasExactDataKeys(value, VERSION_KEYS) &&
    VERSION_KEYS.every(
      key => value[key] === SUPPORTED_OBSERVATION_VERSIONS[key],
    );
}

function observationShapeIsValid(value) {
  if (!hasExactDataKeys(value, OBSERVATION_KEYS)) return false;
  return Number.isSafeInteger(value.schemaVersion) &&
    value.schemaVersion >= 0 &&
    typeof value.sunlandCoreVersion === "string" &&
    value.sunlandCoreVersion.length > 0 &&
    value.sunlandCoreVersion.length <= 32 &&
    Number.isSafeInteger(value.semanticSchemaVersion) &&
    value.semanticSchemaVersion >= 0 &&
    Number.isSafeInteger(value.contextSchemaVersion) &&
    value.contextSchemaVersion >= 0 &&
    RESULT_CATEGORY_SET.has(value.resultCategory) &&
    REASON_CATEGORY_SET.has(value.reasonCategory) &&
    RELATION_CATEGORY_SET.has(value.relationCategory) &&
    typeof value.semanticAdopted === "boolean" &&
    typeof value.legacyFallback === "boolean" &&
    typeof value.contextUsed === "boolean" &&
    CLARIFICATION_KIND_SET.has(value.clarificationKind) &&
    REASONER_PATH_BUCKET_SET.has(value.pathLengthBucket) &&
    KNOWLEDGE_SIZE_BUCKET_SET.has(value.knowledgeCountBucket) &&
    DURATION_BUCKET_SET.has(value.totalDurationBucket) &&
    DURATION_BUCKET_SET.has(value.semanticDurationBucket) &&
    DURATION_BUCKET_SET.has(value.reasonerDurationBucket) &&
    RELATION_CATEGORY_SET.has(value.queriedRelation) &&
    RELATION_CATEGORY_SET.has(value.alternativeKnownRelation) &&
    ALIGNMENT_RESULT_SET.has(value.alignmentResult);
}

export function inspectObservationSummary(value) {
  try {
    if (!observationShapeIsValid(value)) {
      return Object.freeze({ ok: false, reason: "invalid-summary" });
    }
    if (
      value.schemaVersion !== SUPPORTED_OBSERVATION_VERSIONS.observationSchemaVersion ||
      value.sunlandCoreVersion !== SUPPORTED_OBSERVATION_VERSIONS.sunlandCoreVersion ||
      value.semanticSchemaVersion !== SUPPORTED_OBSERVATION_VERSIONS.semanticSchemaVersion ||
      value.contextSchemaVersion !== SUPPORTED_OBSERVATION_VERSIONS.contextSchemaVersion
    ) {
      return Object.freeze({ ok: false, reason: "incompatible-version" });
    }
    return Object.freeze({ ok: true });
  } catch {
    return Object.freeze({ ok: false, reason: "invalid-summary" });
  }
}

export function validateObservationSummary(value) {
  return inspectObservationSummary(value).ok === true;
}

export function createEmptyDiagnosticsSnapshot() {
  return deepFreeze({
    schema: DIAGNOSTICS_SCHEMA,
    diagnosticsSchemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
    versions: currentVersions(),
    counters: zeroMap(COUNTER_KEYS),
    resultCategories: zeroMap(RESULT_CATEGORIES),
    reasonCategories: zeroMap(REASON_CATEGORIES),
    relationCategories: zeroMap(RELATION_CATEGORIES),
    clarificationKinds: zeroMap(CLARIFICATION_KINDS),
    durations: {
      total: zeroMap(DURATION_BUCKETS),
      semantic: zeroMap(DURATION_BUCKETS),
      reasoner: zeroMap(DURATION_BUCKETS),
    },
    knowledgeSizeBuckets: zeroMap(KNOWLEDGE_SIZE_BUCKETS),
    reasonerPathBuckets: zeroMap(REASONER_PATH_BUCKETS),
  });
}

export function validateDiagnosticsSnapshot(value) {
  try {
    return hasExactDataKeys(value, SNAPSHOT_KEYS) &&
      value.schema === DIAGNOSTICS_SCHEMA &&
      value.diagnosticsSchemaVersion === DIAGNOSTICS_SCHEMA_VERSION &&
      versionsMatchCurrent(value.versions) &&
      isCountMap(value.counters, COUNTER_KEYS) &&
      isCountMap(value.resultCategories, RESULT_CATEGORIES) &&
      isCountMap(value.reasonCategories, REASON_CATEGORIES) &&
      isCountMap(value.relationCategories, RELATION_CATEGORIES) &&
      isCountMap(value.clarificationKinds, CLARIFICATION_KINDS) &&
      hasExactDataKeys(value.durations, DURATION_GROUP_KEYS) &&
      DURATION_GROUP_KEYS.every(
        key => isCountMap(value.durations[key], DURATION_BUCKETS),
      ) &&
      isCountMap(value.knowledgeSizeBuckets, KNOWLEDGE_SIZE_BUCKETS) &&
      isCountMap(value.reasonerPathBuckets, REASONER_PATH_BUCKETS);
  } catch {
    return false;
  }
}

export function copyDiagnosticsSnapshot(value) {
  try {
    if (!validateDiagnosticsSnapshot(value)) return null;
    return {
      schema: DIAGNOSTICS_SCHEMA,
      diagnosticsSchemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
      versions: currentVersions(),
      counters: copyMap(value.counters, COUNTER_KEYS),
      resultCategories: copyMap(value.resultCategories, RESULT_CATEGORIES),
      reasonCategories: copyMap(value.reasonCategories, REASON_CATEGORIES),
      relationCategories: copyMap(value.relationCategories, RELATION_CATEGORIES),
      clarificationKinds: copyMap(value.clarificationKinds, CLARIFICATION_KINDS),
      durations: {
        total: copyMap(value.durations.total, DURATION_BUCKETS),
        semantic: copyMap(value.durations.semantic, DURATION_BUCKETS),
        reasoner: copyMap(value.durations.reasoner, DURATION_BUCKETS),
      },
      knowledgeSizeBuckets: copyMap(
        value.knowledgeSizeBuckets,
        KNOWLEDGE_SIZE_BUCKETS,
      ),
      reasonerPathBuckets: copyMap(
        value.reasonerPathBuckets,
        REASONER_PATH_BUCKETS,
      ),
    };
  } catch {
    return null;
  }
}

export function sanitizeDiagnosticsSnapshot(value) {
  const copy = copyDiagnosticsSnapshot(value);
  return copy === null ? null : deepFreeze(copy);
}

export function freezeDiagnosticsSnapshot(value) {
  return deepFreeze(value);
}

export function incrementSaturated(value) {
  return isSafeCount(value)
    ? Math.min(MAX_DIAGNOSTIC_COUNT, value + 1)
    : 0;
}
