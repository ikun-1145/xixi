import type { Relation } from "@/types/knowledge";
import type {
  IntentName,
  ParseResult,
  QueryKind,
} from "@/types/parser";
import type { ClarificationKind } from "@/types/planner";

export type { ClarificationKind } from "@/types/planner";

declare const confidenceBrand: unique symbol;

/**
 * A runtime-validated score in the inclusive range [0, 1].
 *
 * Use createConfidence() at runtime instead of casting arbitrary numbers.
 */
export type Confidence = number & {
  readonly [confidenceBrand]: true;
};

export function isConfidence(value: unknown): value is Confidence {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

export function createConfidence(value: number): Confidence {
  if (!isConfidence(value)) {
    throw new RangeError("Confidence must be a finite number between 0 and 1.");
  }

  return value;
}

/**
 * UTF-16 offsets in the original raw input, expressed as [start, end).
 */
export interface RawTextRange {
  readonly start: number;
  readonly end: number;
}

export type NormalizationStage = "surface" | "match-key";

export type NormalizationKind =
  | "punctuation-normalized"
  | "whitespace-collapsed"
  | "whitespace-trimmed"
  | "case-folded"
  | "edge-filler-removed";

export interface NormalizationEvidence {
  readonly stage: NormalizationStage;
  readonly kind: NormalizationKind;
  readonly rawRange: RawTextRange;
  readonly sourceText: string;
  readonly targetText: string;
}

/**
 * Mapping arrays have one entry per UTF-16 code unit in their corresponding
 * normalized string. Each entry points to the raw span that produced it.
 */
export interface NormalizedSemanticInput {
  readonly raw: string;
  readonly surface: string;
  readonly matchKey: string;
  readonly surfaceToRaw: readonly RawTextRange[];
  readonly matchKeyToRaw: readonly RawTextRange[];
  readonly transformations: readonly NormalizationEvidence[];
}

export type SemanticEntityKind =
  | "person-name"
  | "self"
  | "subject"
  | "object"
  | "relation"
  | "pronoun";

export type SemanticEntitySource = "explicit" | "lexicon" | "context";

export interface SemanticEntity {
  readonly kind: SemanticEntityKind;
  readonly value: string;
  readonly rawText: string;
  /**
   * UTF-16 offsets in raw input, expressed as [start, end).
   */
  readonly start: number;
  readonly end: number;
  readonly source: SemanticEntitySource;
  readonly confidence: Confidence;
}

export interface SemanticConcept {
  readonly id: string;
  readonly canonical: string;
  readonly matchedAlias?: string;
  readonly confidence: Confidence;
  readonly evidence: readonly MatchedFeature[];
}

export type MatchedFeatureKind =
  | "lexicon-alias"
  | "relation-pattern"
  | "legacy-regex"
  | "context-reference"
  | "structural"
  | "question-cue"
  | "negation-cue"
  | "entity-pattern"
  | "teaching-cue"
  | "definition-query";

export interface MatchedFeature {
  readonly kind: MatchedFeatureKind;
  readonly key: string;
  readonly value?: string;
  readonly rawRange?: RawTextRange;
  readonly weight: Confidence;
}

export type CandidateProducer =
  | "legacy-regex"
  | "lexicon"
  | "relation-pattern"
  | "context";

export type CandidateSideEffect =
  | "none"
  | "memory-write"
  | "knowledge-write";

export interface SemanticCandidate {
  readonly id: string;
  readonly producer: CandidateProducer;
  readonly producerWeight: Confidence;
  /**
   * Reuses the existing Parser result instead of duplicating its public shape.
   * A semantic candidate may remain unresolved until a later adapter stage.
   */
  readonly result: ParseResult | null;
  readonly concepts: readonly SemanticConcept[];
  readonly entities: readonly SemanticEntity[];
  readonly confidence: Confidence;
  readonly evidence: readonly MatchedFeature[];
  readonly missingSlots: readonly string[];
  /**
   * Declares what accepting this candidate could mutate. Candidate generation
   * never performs the mutation.
   */
  readonly sideEffect: CandidateSideEffect;
}

export interface SemanticRelationMention {
  readonly conceptId: string;
  readonly canonical: Relation;
  readonly alias: string;
  readonly matchKeyRange: RawTextRange;
  readonly entity: SemanticEntity;
  readonly confidence: Confidence;
  readonly evidence: readonly MatchedFeature[];
}

export interface SemanticExtraction {
  readonly input: NormalizedSemanticInput;
  readonly concepts: readonly SemanticConcept[];
  readonly entities: readonly SemanticEntity[];
  readonly questionCues: readonly MatchedFeature[];
  readonly negationCues: readonly MatchedFeature[];
  readonly selfReferences: readonly SemanticEntity[];
  readonly personNames: readonly SemanticEntity[];
  readonly relations: readonly SemanticRelationMention[];
  readonly teachingCues: readonly MatchedFeature[];
  readonly definitionQueryCues: readonly MatchedFeature[];
}

export type SemanticDiagnosticLevel = "debug" | "info" | "warning";

/**
 * Internal-only diagnostics for tests and logs. They must not be forwarded to
 * Response Planner or Personality as user-visible content.
 */
export interface SemanticDiagnostic {
  readonly level: SemanticDiagnosticLevel;
  readonly code: string;
  readonly message: string;
  readonly rawRange?: RawTextRange;
}

export type SemanticContextSpeaker = "user" | "assistant";

export type SemanticContextEntityKind =
  | "subject"
  | "object"
  | "self";

/**
 * Minimal entity reference retained for conversational disambiguation.
 *
 * It intentionally excludes raw text, offsets, confidence, Memory records and
 * Knowledge records. The caller owns and serializes this value.
 */
export interface SemanticContextEntityReference {
  readonly kind: SemanticContextEntityKind;
  readonly value: string;
}

export interface SemanticContextQueryShape {
  readonly kind: QueryKind;
  readonly relation: Relation;
  readonly hasObject: boolean;
}

export interface SemanticTurnSummary {
  readonly turnId: string;
  readonly speaker: SemanticContextSpeaker;
  readonly acceptedIntent?: IntentName;
  readonly concepts: readonly string[];
  readonly entityReferences: readonly SemanticContextEntityReference[];
  readonly focusEntity?: SemanticContextEntityReference;
  readonly relation?: Relation;
  readonly queryShape?: SemanticContextQueryShape;
}

/**
 * Context is supplied and retained by the caller. Semantic modules never
 * infer a user/session identity and never persist context through module-level
 * state. `version` is an optimistic concurrency token owned by the host
 * conversation.
 */
export interface SemanticContext {
  readonly schemaVersion: 1;
  readonly version: number;
  readonly recentTurns: readonly SemanticTurnSummary[];
}

export type SemanticContextUpdate =
  | {
      readonly kind: "none";
      readonly baseVersion: number;
    }
  | {
      readonly kind: "replace";
      readonly baseVersion: number;
      readonly nextVersion: number;
      readonly context: SemanticContext;
    };

export interface SemanticAnalysis {
  readonly input: NormalizedSemanticInput;
  readonly extraction: SemanticExtraction;
  readonly candidates: readonly SemanticCandidate[];
  readonly diagnostics: readonly SemanticDiagnostic[];
}

export type UnderstandingRiskLevel = "none" | "low" | "medium" | "high";

export type UnderstandingReasonCode =
  | "threshold-met"
  | "insufficient-confidence"
  | "insufficient-margin"
  | "missing-required-slot"
  | "side-effect-evidence-insufficient"
  | "negation-conflict"
  | "compatible-secondary-candidate"
  | "conflicting-candidates"
  | "corroborated-producers"
  | "compound-query"
  | "partial-candidate"
  | "no-viable-candidate";

export type RequiredEvidence =
  | "confidence-threshold"
  | "candidate-margin"
  | "complete-slots"
  | "explicit-name"
  | "complete-triple"
  | "strong-non-alias-evidence"
  | "non-question-assertion"
  | "non-negated-assertion";

export interface MissingSlotPolicy {
  readonly partialDecision: "clarify" | "no-understanding";
  readonly sideEffectDecision: "reject-side-effect";
  readonly clarifyExplicitTeaching: boolean;
}

export interface NegationPolicy {
  readonly preserveNegatedCandidate: boolean;
  readonly rejectNegatedSideEffects: boolean;
}

export interface UnderstandingPolicy {
  readonly passiveIntentAcceptThreshold: Confidence;
  readonly queryAcceptThreshold: Confidence;
  readonly sideEffectAcceptThreshold: Confidence;
  readonly minimumCandidateMargin: Confidence;
  readonly partialCandidateThreshold: Confidence;
  readonly maximumAlternatives: number;
  readonly minimumSideEffectEvidenceUnits: number;
  readonly weakAliasMaximumLength: number;
  readonly missingSlotPolicy: MissingSlotPolicy;
  readonly negationPolicy: NegationPolicy;
}

export interface AcceptUnderstandingDecision {
  readonly kind: "accept";
  readonly selectedCandidate: SemanticCandidate;
  readonly secondaryCandidates: readonly SemanticCandidate[];
  readonly confidence: Confidence;
  readonly reasonCodes: readonly UnderstandingReasonCode[];
  readonly alternatives: readonly SemanticCandidate[];
  readonly riskLevel: UnderstandingRiskLevel;
}

export interface ClarifyUnderstandingDecision {
  readonly kind: "clarify";
  readonly candidateOptions: readonly SemanticCandidate[];
  readonly missingSlots: readonly string[];
  readonly clarificationKind: ClarificationKind;
  readonly reasonCodes: readonly UnderstandingReasonCode[];
}

export interface RejectSideEffectUnderstandingDecision {
  readonly kind: "reject-side-effect";
  readonly rejectedCandidate: SemanticCandidate;
  readonly requiredEvidence: readonly RequiredEvidence[];
  readonly reasonCodes: readonly UnderstandingReasonCode[];
}

export interface UnderstandingDiagnosticsSummary {
  readonly count: number;
  readonly codes: readonly string[];
}

export interface NoUnderstandingDecision {
  readonly kind: "no-understanding";
  readonly diagnosticsSummary: UnderstandingDiagnosticsSummary;
  readonly reasonCodes: readonly UnderstandingReasonCode[];
}

export type UnderstandingDecision =
  | AcceptUnderstandingDecision
  | ClarifyUnderstandingDecision
  | RejectSideEffectUnderstandingDecision
  | NoUnderstandingDecision;
