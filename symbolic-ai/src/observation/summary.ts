import {
  bucketDuration,
  bucketKnowledgeCount,
  bucketReasonerPath,
} from "./buckets";
import {
  CONTEXT_SCHEMA_VERSION,
  DURATION_BUCKETS,
  KNOWLEDGE_COUNT_BUCKETS,
  OBSERVATION_CLARIFICATION_KINDS,
  OBSERVATION_REASON_CATEGORIES,
  OBSERVATION_RELATION_CATEGORIES,
  OBSERVATION_RESULT_CATEGORIES,
  OBSERVATION_SCHEMA_VERSION,
  REASONER_PATH_BUCKETS,
  RELATION_ALIGNMENT_RESULTS,
  SEMANTIC_SCHEMA_VERSION,
  SUNLAND_CORE_VERSION,
  type ObservationClarificationKind,
  type ObservationReasonCategory,
  type ObservationRelationCategory,
  type ObservationResultCategory,
  type ObservationSummary,
  type RelationAlignmentResult,
} from "./types";

export interface ObservationSummaryInput {
  readonly resultCategory: ObservationResultCategory;
  readonly reasonCategory: ObservationReasonCategory;
  readonly relationCategory: ObservationRelationCategory;
  readonly semanticAdopted: boolean;
  readonly legacyFallback: boolean;
  readonly contextUsed: boolean;
  readonly clarificationKind: ObservationClarificationKind;
  readonly reasonerPathLength: number | null;
  readonly knowledgeCount: number | null;
  readonly totalDurationMs: number | null;
  readonly semanticDurationMs: number | null;
  readonly reasonerDurationMs: number | null;
  readonly queriedRelation: ObservationRelationCategory;
  readonly alternativeKnownRelation: ObservationRelationCategory;
  readonly alignmentResult: RelationAlignmentResult;
}

const SUMMARY_KEYS = Object.freeze([
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
] as const satisfies readonly (keyof ObservationSummary)[]);

const RESULT_CATEGORIES = new Set<string>(
  OBSERVATION_RESULT_CATEGORIES,
);
const REASON_CATEGORIES = new Set<string>(
  OBSERVATION_REASON_CATEGORIES,
);
const RELATION_CATEGORIES = new Set<string>(
  OBSERVATION_RELATION_CATEGORIES,
);
const CLARIFICATION_KINDS = new Set<string>(
  OBSERVATION_CLARIFICATION_KINDS,
);
const PATH_BUCKETS = new Set<string>(REASONER_PATH_BUCKETS);
const KNOWLEDGE_BUCKETS = new Set<string>(
  KNOWLEDGE_COUNT_BUCKETS,
);
const DURATION_BUCKET_VALUES = new Set<string>(DURATION_BUCKETS);
const ALIGNMENT_RESULTS = new Set<string>(
  RELATION_ALIGNMENT_RESULTS,
);

function isRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function isAllowed(
  value: unknown,
  allowed: ReadonlySet<string>,
): value is string {
  return typeof value === "string" && allowed.has(value);
}

function exactKeys(value: Readonly<Record<string, unknown>>): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === SUMMARY_KEYS.length &&
    keys.every(
      (key) =>
        typeof key === "string" &&
        (SUMMARY_KEYS as readonly string[]).includes(key),
    )
  );
}

function hasOnlyDataProperties(
  value: Readonly<Record<string, unknown>>,
): boolean {
  return SUMMARY_KEYS.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      descriptor !== undefined &&
      "value" in descriptor &&
      descriptor.get === undefined &&
      descriptor.set === undefined
    );
  });
}

/**
 * Fixed-field constructor. Runtime callers may supply extra properties, but
 * none can cross this explicit field boundary.
 */
export function createObservationSummary(
  input: ObservationSummaryInput,
): ObservationSummary {
  return Object.freeze({
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    sunlandCoreVersion: SUNLAND_CORE_VERSION,
    semanticSchemaVersion: SEMANTIC_SCHEMA_VERSION,
    contextSchemaVersion: CONTEXT_SCHEMA_VERSION,
    resultCategory: RESULT_CATEGORIES.has(input.resultCategory)
      ? input.resultCategory
      : "safe-fallback",
    reasonCategory: REASON_CATEGORIES.has(input.reasonCategory)
      ? input.reasonCategory
      : "unclassified",
    relationCategory: RELATION_CATEGORIES.has(input.relationCategory)
      ? input.relationCategory
      : "unknown",
    semanticAdopted: input.semanticAdopted === true,
    legacyFallback: input.legacyFallback === true,
    contextUsed: input.contextUsed === true,
    clarificationKind: CLARIFICATION_KINDS.has(
      input.clarificationKind,
    )
      ? input.clarificationKind
      : "none",
    pathLengthBucket: bucketReasonerPath(
      input.reasonerPathLength,
    ),
    knowledgeCountBucket: bucketKnowledgeCount(
      input.knowledgeCount,
    ),
    totalDurationBucket: bucketDuration(input.totalDurationMs),
    semanticDurationBucket: bucketDuration(
      input.semanticDurationMs,
    ),
    reasonerDurationBucket: bucketDuration(
      input.reasonerDurationMs,
    ),
    queriedRelation: RELATION_CATEGORIES.has(input.queriedRelation)
      ? input.queriedRelation
      : "unknown",
    alternativeKnownRelation: RELATION_CATEGORIES.has(
      input.alternativeKnownRelation,
    )
      ? input.alternativeKnownRelation
      : "unknown",
    alignmentResult: ALIGNMENT_RESULTS.has(input.alignmentResult)
      ? input.alignmentResult
      : "unavailable",
  });
}

/** Strict runtime guard: unknown or extra properties are rejected. */
export function validateObservationSummary(
  value: unknown,
): value is ObservationSummary {
  try {
    if (
      !isRecord(value) ||
      !exactKeys(value) ||
      !hasOnlyDataProperties(value)
    ) {
      return false;
    }

    return (
      value.schemaVersion === OBSERVATION_SCHEMA_VERSION &&
      value.sunlandCoreVersion === SUNLAND_CORE_VERSION &&
      value.semanticSchemaVersion === SEMANTIC_SCHEMA_VERSION &&
      value.contextSchemaVersion === CONTEXT_SCHEMA_VERSION &&
      isAllowed(value.resultCategory, RESULT_CATEGORIES) &&
      isAllowed(value.reasonCategory, REASON_CATEGORIES) &&
      isAllowed(value.relationCategory, RELATION_CATEGORIES) &&
      typeof value.semanticAdopted === "boolean" &&
      typeof value.legacyFallback === "boolean" &&
      typeof value.contextUsed === "boolean" &&
      isAllowed(value.clarificationKind, CLARIFICATION_KINDS) &&
      isAllowed(value.pathLengthBucket, PATH_BUCKETS) &&
      isAllowed(
        value.knowledgeCountBucket,
        KNOWLEDGE_BUCKETS,
      ) &&
      isAllowed(
        value.totalDurationBucket,
        DURATION_BUCKET_VALUES,
      ) &&
      isAllowed(
        value.semanticDurationBucket,
        DURATION_BUCKET_VALUES,
      ) &&
      isAllowed(
        value.reasonerDurationBucket,
        DURATION_BUCKET_VALUES,
      ) &&
      isAllowed(value.queriedRelation, RELATION_CATEGORIES) &&
      isAllowed(
        value.alternativeKnownRelation,
        RELATION_CATEGORIES,
      ) &&
      isAllowed(value.alignmentResult, ALIGNMENT_RESULTS)
    );
  } catch {
    return false;
  }
}

/**
 * Rebuild a validated summary property-by-property. This prevents callers
 * from retaining prototypes, getters, or hidden/free-text object members.
 */
export function sanitizeObservationSummary(
  value: unknown,
): ObservationSummary | null {
  if (!validateObservationSummary(value)) return null;

  return Object.freeze({
    schemaVersion: value.schemaVersion,
    sunlandCoreVersion: value.sunlandCoreVersion,
    semanticSchemaVersion: value.semanticSchemaVersion,
    contextSchemaVersion: value.contextSchemaVersion,
    resultCategory: value.resultCategory,
    reasonCategory: value.reasonCategory,
    relationCategory: value.relationCategory,
    semanticAdopted: value.semanticAdopted,
    legacyFallback: value.legacyFallback,
    contextUsed: value.contextUsed,
    clarificationKind: value.clarificationKind,
    pathLengthBucket: value.pathLengthBucket,
    knowledgeCountBucket: value.knowledgeCountBucket,
    totalDurationBucket: value.totalDurationBucket,
    semanticDurationBucket: value.semanticDurationBucket,
    reasonerDurationBucket: value.reasonerDurationBucket,
    queriedRelation: value.queriedRelation,
    alternativeKnownRelation: value.alternativeKnownRelation,
    alignmentResult: value.alignmentResult,
  });
}
