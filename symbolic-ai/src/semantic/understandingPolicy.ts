import {
  createConfidence,
  type Confidence,
  type MissingSlotPolicy,
  type NegationPolicy,
  type UnderstandingPolicy,
} from "./types";

export interface UnderstandingPolicyOverrides {
  readonly passiveIntentAcceptThreshold?: number;
  readonly queryAcceptThreshold?: number;
  readonly sideEffectAcceptThreshold?: number;
  readonly minimumCandidateMargin?: number;
  readonly partialCandidateThreshold?: number;
  readonly maximumAlternatives?: number;
  readonly minimumSideEffectEvidenceUnits?: number;
  readonly weakAliasMaximumLength?: number;
  readonly missingSlotPolicy?: Partial<MissingSlotPolicy>;
  readonly negationPolicy?: Partial<NegationPolicy>;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive integer.`);
  }
  return value;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative integer.`);
  }
  return value;
}

function threshold(
  value: number | undefined,
  fallback: Confidence,
): Confidence {
  return value === undefined ? fallback : createConfidence(value);
}

export const DEFAULT_UNDERSTANDING_POLICY: UnderstandingPolicy =
  Object.freeze({
    passiveIntentAcceptThreshold: createConfidence(0.72),
    queryAcceptThreshold: createConfidence(0.74),
    sideEffectAcceptThreshold: createConfidence(0.82),
    minimumCandidateMargin: createConfidence(0.08),
    partialCandidateThreshold: createConfidence(0.35),
    maximumAlternatives: 3,
    minimumSideEffectEvidenceUnits: 2,
    weakAliasMaximumLength: 1,
    missingSlotPolicy: Object.freeze({
      partialDecision: "clarify",
      sideEffectDecision: "reject-side-effect",
      clarifyExplicitTeaching: true,
    }),
    negationPolicy: Object.freeze({
      preserveNegatedCandidate: true,
      rejectNegatedSideEffects: true,
    }),
  });

export function createUnderstandingPolicy(
  overrides: UnderstandingPolicyOverrides = {},
): UnderstandingPolicy {
  const defaults = DEFAULT_UNDERSTANDING_POLICY;
  return Object.freeze({
    passiveIntentAcceptThreshold: threshold(
      overrides.passiveIntentAcceptThreshold,
      defaults.passiveIntentAcceptThreshold,
    ),
    queryAcceptThreshold: threshold(
      overrides.queryAcceptThreshold,
      defaults.queryAcceptThreshold,
    ),
    sideEffectAcceptThreshold: threshold(
      overrides.sideEffectAcceptThreshold,
      defaults.sideEffectAcceptThreshold,
    ),
    minimumCandidateMargin: threshold(
      overrides.minimumCandidateMargin,
      defaults.minimumCandidateMargin,
    ),
    partialCandidateThreshold: threshold(
      overrides.partialCandidateThreshold,
      defaults.partialCandidateThreshold,
    ),
    maximumAlternatives: positiveInteger(
      overrides.maximumAlternatives ?? defaults.maximumAlternatives,
      "maximumAlternatives",
    ),
    minimumSideEffectEvidenceUnits: positiveInteger(
      overrides.minimumSideEffectEvidenceUnits ??
        defaults.minimumSideEffectEvidenceUnits,
      "minimumSideEffectEvidenceUnits",
    ),
    weakAliasMaximumLength: nonNegativeInteger(
      overrides.weakAliasMaximumLength ??
        defaults.weakAliasMaximumLength,
      "weakAliasMaximumLength",
    ),
    missingSlotPolicy: Object.freeze({
      ...defaults.missingSlotPolicy,
      ...overrides.missingSlotPolicy,
    }),
    negationPolicy: Object.freeze({
      ...defaults.negationPolicy,
      ...overrides.negationPolicy,
    }),
  });
}
