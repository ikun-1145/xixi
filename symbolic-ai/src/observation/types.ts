import type { ClarificationKind } from "@/types";

/**
 * Core version follows the package's existing SemVer. Keep this constant in
 * sync with `symbolic-ai/package.json` whenever a Core release is cut.
 */
export const SUNLAND_CORE_VERSION = "0.1.0" as const;

/** Independent, explicitly-versioned schemas for long-lived aggregation. */
export const SEMANTIC_SCHEMA_VERSION = 1 as const;
export const CONTEXT_SCHEMA_VERSION = 1 as const;
export const OBSERVATION_SCHEMA_VERSION = 1 as const;

export const OBSERVATION_RESULT_CATEGORIES = Object.freeze([
  "understood",
  "clarification",
  "no-understanding",
  "missing-knowledge",
  "relation-unsupported",
  "context-unresolved",
  "side-effect-blocked",
  "safe-fallback",
] as const);

export type ObservationResultCategory =
  (typeof OBSERVATION_RESULT_CATEGORIES)[number];

export const OBSERVATION_REASON_CATEGORIES = Object.freeze([
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
] as const);

export type ObservationReasonCategory =
  (typeof OBSERVATION_REASON_CATEGORIES)[number];

/**
 * Closed observation vocabulary. The runtime `Relation` type remains open,
 * but unknown/plugin relations are deliberately collapsed to `unknown`
 * before an observation can leave Core.
 */
export const OBSERVATION_RELATION_CATEGORIES = Object.freeze([
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
] as const);

export type ObservationRelationCategory =
  (typeof OBSERVATION_RELATION_CATEGORIES)[number];

export const OBSERVATION_CLARIFICATION_KINDS = Object.freeze([
  "ambiguous-intent",
  "missing-subject",
  "missing-relation",
  "missing-object",
  "uncertain-name",
  "uncertain-teaching",
  "conflicting-candidates",
  "none",
] as const satisfies readonly (ClarificationKind | "none")[]);

export type ObservationClarificationKind =
  (typeof OBSERVATION_CLARIFICATION_KINDS)[number];

export const DURATION_BUCKETS = Object.freeze([
  "under-1ms",
  "1-5ms",
  "5-16ms",
  "16-50ms",
  "over-50ms",
  "unavailable",
] as const);

export type DurationBucket = (typeof DURATION_BUCKETS)[number];

export const KNOWLEDGE_COUNT_BUCKETS = Object.freeze([
  "0",
  "1-99",
  "100-999",
  "1000-4999",
  "5000-plus",
  "unavailable",
] as const);

export type KnowledgeCountBucket =
  (typeof KNOWLEDGE_COUNT_BUCKETS)[number];

export const REASONER_PATH_BUCKETS = Object.freeze([
  "direct",
  "2-5",
  "6-20",
  "21-50",
  "51-plus",
  "none",
  "unavailable",
] as const);

export type ReasonerPathBucket =
  (typeof REASONER_PATH_BUCKETS)[number];

export const RELATION_ALIGNMENT_RESULTS = Object.freeze([
  "aligned",
  "possible-mismatch",
  "no-alternative-known",
  "unavailable",
] as const);

export type RelationAlignmentResult =
  (typeof RELATION_ALIGNMENT_RESULTS)[number];

export type ObservationMode = "off" | "summary";

/**
 * One request's irreversible, whitelist-only observation. Every property is
 * required so serialization cannot accidentally acquire optional object
 * fragments through spreading.
 */
export interface ObservationSummary {
  readonly schemaVersion: typeof OBSERVATION_SCHEMA_VERSION;
  readonly sunlandCoreVersion: typeof SUNLAND_CORE_VERSION;
  readonly semanticSchemaVersion: typeof SEMANTIC_SCHEMA_VERSION;
  readonly contextSchemaVersion: typeof CONTEXT_SCHEMA_VERSION;
  readonly resultCategory: ObservationResultCategory;
  readonly reasonCategory: ObservationReasonCategory;
  readonly relationCategory: ObservationRelationCategory;
  readonly semanticAdopted: boolean;
  readonly legacyFallback: boolean;
  readonly contextUsed: boolean;
  readonly clarificationKind: ObservationClarificationKind;
  readonly pathLengthBucket: ReasonerPathBucket;
  readonly knowledgeCountBucket: KnowledgeCountBucket;
  readonly totalDurationBucket: DurationBucket;
  readonly semanticDurationBucket: DurationBucket;
  readonly reasonerDurationBucket: DurationBucket;
  readonly queriedRelation: ObservationRelationCategory;
  readonly alternativeKnownRelation: ObservationRelationCategory;
  readonly alignmentResult: RelationAlignmentResult;
}
