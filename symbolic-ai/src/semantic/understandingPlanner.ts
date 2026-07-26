import { SEMANTIC_SCORING } from "./scoring";
import {
  DEFAULT_UNDERSTANDING_POLICY,
} from "./understandingPolicy";
import {
  createConfidence,
  type ClarificationKind,
  type Confidence,
  type RequiredEvidence,
  type SemanticAnalysis,
  type SemanticCandidate,
  type UnderstandingDecision,
  type UnderstandingPolicy,
  type UnderstandingReasonCode,
  type UnderstandingRiskLevel,
} from "./types";

interface CandidateGroup {
  readonly key: string;
  readonly representative: SemanticCandidate;
  readonly supporters: readonly SemanticCandidate[];
}

interface SideEffectAssessment {
  readonly safe: boolean;
  readonly requiredEvidence: readonly RequiredEvidence[];
  readonly reasonCodes: readonly UnderstandingReasonCode[];
}

const PASSIVE_INTENTS = new Set(["Greeting", "Thanks", "Farewell"]);

const COMPATIBLE_INTENT_PAIRS = new Set([
  "Greeting+Identity",
  "Greeting+RememberName",
  "Farewell+Thanks",
]);

const REASON_ORDER: Readonly<Record<UnderstandingReasonCode, number>> =
  Object.freeze({
    "threshold-met": 0,
    "corroborated-producers": 1,
    "compatible-secondary-candidate": 2,
    "partial-candidate": 3,
    "missing-required-slot": 4,
    "insufficient-confidence": 5,
    "insufficient-margin": 6,
    "conflicting-candidates": 7,
    "compound-query": 8,
    "side-effect-evidence-insufficient": 9,
    "negation-conflict": 10,
    "no-viable-candidate": 11,
  });

const REQUIRED_EVIDENCE_ORDER: Readonly<
  Record<RequiredEvidence, number>
> = Object.freeze({
  "confidence-threshold": 0,
  "candidate-margin": 1,
  "complete-slots": 2,
  "explicit-name": 3,
  "complete-triple": 4,
  "strong-non-alias-evidence": 5,
  "non-question-assertion": 6,
  "non-negated-assertion": 7,
});

function uniqueSorted<T extends string>(
  values: readonly T[],
  order: Readonly<Record<T, number>>,
): readonly T[] {
  return Object.freeze(
    [...new Set(values)].sort(
      (left, right) =>
        order[left] - order[right] || left.localeCompare(right),
    ),
  );
}

function reasonCodes(
  values: readonly UnderstandingReasonCode[],
): readonly UnderstandingReasonCode[] {
  return uniqueSorted(values, REASON_ORDER);
}

function requiredEvidence(
  values: readonly RequiredEvidence[],
): readonly RequiredEvidence[] {
  return uniqueSorted(values, REQUIRED_EVIDENCE_ORDER);
}

function normalizedValue(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("und");
}

function hasIsAConcept(analysis: SemanticAnalysis): boolean {
  return analysis.extraction.relations.some(
    ({ conceptId }) => conceptId === "is-a",
  );
}

function canonicalRelation(
  analysis: SemanticAnalysis,
  relation: string,
): string {
  if (
    hasIsAConcept(analysis) &&
    (relation === "是" || relation === "属于")
  ) {
    return "属于";
  }
  return relation;
}

function canonicalObject(
  analysis: SemanticAnalysis,
  relation: string,
  object: string,
): string {
  const normalized = normalizedValue(object);
  if (
    canonicalRelation(analysis, relation) === "属于" &&
    normalized.startsWith("一种") &&
    normalized.length > "一种".length
  ) {
    return normalized.slice("一种".length);
  }
  return normalized;
}

function interpretationKey(
  analysis: SemanticAnalysis,
  candidate: SemanticCandidate,
): string {
  const result = candidate.result;
  if (result === null) {
    return `partial:${candidate.id}`;
  }

  switch (result.type) {
    case "intent":
      return [
        "intent",
        result.intent,
        ...result.entities.map(normalizedValue),
      ].join(":");
    case "statement":
      return [
        "statement",
        normalizedValue(result.subject),
        canonicalRelation(analysis, result.relation),
        canonicalObject(analysis, result.relation, result.object),
        result.negated,
      ].join(":");
    case "query":
      return [
        "query",
        result.kind,
        normalizedValue(result.subject),
        canonicalRelation(analysis, result.relation),
        result.object === undefined
          ? ""
          : canonicalObject(
              analysis,
              result.relation,
              result.object,
            ),
      ].join(":");
    case "unknown":
      return `unknown:${candidate.id}`;
  }
}

function evidenceUnits(candidate: SemanticCandidate): number {
  const entityKeys = new Set(
    candidate.entities.map(
      ({ kind, start, end, value }) =>
        `${kind}:${start}:${end}:${value}`,
    ),
  );
  return candidate.evidence.length + entityKeys.size;
}

function effectiveSideEffect(candidate: SemanticCandidate) {
  if (
    candidate.result?.type === "intent" &&
    candidate.result.intent === "RememberName"
  ) {
    return "memory-write" as const;
  }
  if (candidate.result?.type === "statement") {
    return "knowledge-write" as const;
  }
  return candidate.sideEffect;
}

function candidateComparator(
  left: SemanticCandidate,
  right: SemanticCandidate,
): number {
  const leftEffectConsistency =
    effectiveSideEffect(left) === left.sideEffect ? 0 : 1;
  const rightEffectConsistency =
    effectiveSideEffect(right) === right.sideEffect ? 0 : 1;
  return (
    leftEffectConsistency - rightEffectConsistency ||
    right.confidence - left.confidence ||
    evidenceUnits(right) - evidenceUnits(left) ||
    left.missingSlots.length - right.missingSlots.length ||
    SEMANTIC_SCORING.producerTieBreak[left.producer] -
      SEMANTIC_SCORING.producerTieBreak[right.producer] ||
    left.id.localeCompare(right.id)
  );
}

function groupCandidates(
  analysis: SemanticAnalysis,
  candidates: readonly SemanticCandidate[],
): readonly CandidateGroup[] {
  const groups = new Map<string, SemanticCandidate[]>();
  const orderedCandidates = [...candidates].sort(candidateComparator);

  for (const candidate of orderedCandidates) {
    const key = interpretationKey(analysis, candidate);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [candidate]);
    } else {
      group.push(candidate);
    }
  }

  return Object.freeze(
    [...groups.entries()]
      .map(([key, supporters]) => {
        const orderedSupporters = Object.freeze(
          [...supporters].sort(candidateComparator),
        );
        return Object.freeze({
          key,
          representative: orderedSupporters[0]!,
          supporters: orderedSupporters,
        });
      })
      .sort((left, right) =>
        candidateComparator(
          left.representative,
          right.representative,
        ),
      ),
  );
}

function thresholdForCandidate(
  candidate: SemanticCandidate,
  policy: UnderstandingPolicy,
): Confidence {
  if (effectiveSideEffect(candidate) !== "none") {
    return policy.sideEffectAcceptThreshold;
  }

  const result = candidate.result;
  if (
    result?.type === "intent" &&
    PASSIVE_INTENTS.has(result.intent)
  ) {
    return policy.passiveIntentAcceptThreshold;
  }

  if (
    result?.type === "query" ||
    (result?.type === "intent" &&
      (result.intent === "Identity" ||
        result.intent === "RecallName"))
  ) {
    return policy.queryAcceptThreshold;
  }

  return policy.partialCandidateThreshold;
}

function isNegated(candidate: SemanticCandidate): boolean {
  return (
    candidate.result?.type === "statement" &&
    candidate.result.negated
  );
}

function hasExplicitName(candidate: SemanticCandidate): boolean {
  if (
    candidate.result?.type !== "intent" ||
    candidate.result.intent !== "RememberName"
  ) {
    return false;
  }

  const rememberedName = candidate.result.entities[0];
  if (rememberedName === undefined) {
    return false;
  }

  return candidate.entities.some(
    (entity) =>
      entity.kind === "person-name" &&
      normalizedValue(entity.value) ===
        normalizedValue(rememberedName),
  );
}

function hasCompleteTriple(candidate: SemanticCandidate): boolean {
  const result = candidate.result;
  return (
    result?.type === "statement" &&
    result.subject.trim().length > 0 &&
    result.relation.trim().length > 0 &&
    result.object.trim().length > 0
  );
}

function hasStrongEvidence(
  candidate: SemanticCandidate,
  policy: UnderstandingPolicy,
): boolean {
  const strongKinds = new Set([
    "legacy-regex",
    "relation-pattern",
    "entity-pattern",
    "teaching-cue",
  ]);
  if (
    candidate.evidence.some(({ kind }) => strongKinds.has(kind))
  ) {
    return true;
  }

  const onlyWeakAliases =
    candidate.evidence.length > 0 &&
    candidate.evidence.every(
      ({ kind, value }) =>
        kind === "lexicon-alias" &&
        (value?.length ?? 0) <= policy.weakAliasMaximumLength,
    );

  return (
    !onlyWeakAliases &&
    evidenceUnits(candidate) >=
      policy.minimumSideEffectEvidenceUnits
  );
}

function assessSideEffect(
  candidate: SemanticCandidate,
  analysis: SemanticAnalysis,
  policy: UnderstandingPolicy,
): SideEffectAssessment {
  const sideEffect = effectiveSideEffect(candidate);
  if (sideEffect === "none") {
    return Object.freeze({
      safe: true,
      requiredEvidence: Object.freeze([]),
      reasonCodes: Object.freeze([]),
    });
  }

  const required: RequiredEvidence[] = [];
  const reasons: UnderstandingReasonCode[] = [];

  if (candidate.missingSlots.length > 0 || candidate.result === null) {
    required.push("complete-slots");
    reasons.push("missing-required-slot");
  }
  if (candidate.confidence < policy.sideEffectAcceptThreshold) {
    required.push("confidence-threshold");
    reasons.push("insufficient-confidence");
  }
  if (
    policy.negationPolicy.rejectNegatedSideEffects &&
    isNegated(candidate)
  ) {
    required.push("non-negated-assertion");
    reasons.push("negation-conflict");
  }
  if (
    candidate.result?.type === "statement" &&
    analysis.extraction.questionCues.length > 0
  ) {
    required.push("non-question-assertion");
    reasons.push("side-effect-evidence-insufficient");
  }
  if (
    sideEffect === "memory-write" &&
    !hasExplicitName(candidate)
  ) {
    required.push("explicit-name");
    reasons.push("side-effect-evidence-insufficient");
  }
  if (
    sideEffect === "knowledge-write" &&
    !hasCompleteTriple(candidate)
  ) {
    required.push("complete-triple");
    reasons.push("side-effect-evidence-insufficient");
  }
  if (!hasStrongEvidence(candidate, policy)) {
    required.push("strong-non-alias-evidence");
    reasons.push("side-effect-evidence-insufficient");
  }

  return Object.freeze({
    safe: required.length === 0,
    requiredEvidence: requiredEvidence(required),
    reasonCodes: reasonCodes(reasons),
  });
}

function isCompleteCandidate(candidate: SemanticCandidate): boolean {
  return (
    candidate.result !== null &&
    candidate.result.type !== "unknown" &&
    candidate.missingSlots.length === 0
  );
}

function isViableCandidate(
  candidate: SemanticCandidate,
  analysis: SemanticAnalysis,
  policy: UnderstandingPolicy,
): boolean {
  if (
    isNegated(candidate) &&
    !policy.negationPolicy.preserveNegatedCandidate
  ) {
    return false;
  }

  return (
    isCompleteCandidate(candidate) &&
    candidate.confidence >= thresholdForCandidate(candidate, policy) &&
    assessSideEffect(candidate, analysis, policy).safe
  );
}

function viableGroups(
  analysis: SemanticAnalysis,
  policy: UnderstandingPolicy,
): readonly CandidateGroup[] {
  const viable = analysis.candidates.filter((candidate) =>
    isViableCandidate(candidate, analysis, policy),
  );
  return groupCandidates(analysis, viable);
}

function intentName(candidate: SemanticCandidate): string | null {
  return candidate.result?.type === "intent"
    ? candidate.result.intent
    : null;
}

function compatibleCandidates(
  left: SemanticCandidate,
  right: SemanticCandidate,
): boolean {
  const leftIntent = intentName(left);
  const rightIntent = intentName(right);
  if (leftIntent === null || rightIntent === null) {
    return false;
  }

  const pair = [leftIntent, rightIntent].sort().join("+");
  return COMPATIBLE_INTENT_PAIRS.has(pair);
}

function isQueryLike(candidate: SemanticCandidate): boolean {
  const result = candidate.result;
  return (
    result?.type === "query" ||
    (result?.type === "intent" &&
      (result.intent === "Identity" ||
        result.intent === "RecallName"))
  );
}

function riskLevel(
  candidate: SemanticCandidate,
): UnderstandingRiskLevel {
  if (effectiveSideEffect(candidate) !== "none") {
    return "high";
  }
  if (isQueryLike(candidate)) {
    return "low";
  }
  if (
    candidate.result?.type === "intent" &&
    PASSIVE_INTENTS.has(candidate.result.intent)
  ) {
    return "none";
  }
  return "medium";
}

function candidateOptions(
  groups: readonly CandidateGroup[],
  policy: UnderstandingPolicy,
): readonly SemanticCandidate[] {
  return Object.freeze(
    groups
      .slice(0, policy.maximumAlternatives)
      .map(({ representative }) => representative),
  );
}

function clarificationKindForMissing(
  candidate: SemanticCandidate,
): ClarificationKind {
  if (
    candidate.concepts.some(({ id }) => id === "remember-name")
  ) {
    return "uncertain-name";
  }
  if (
    candidate.concepts.some(({ id }) => id === "teaching") &&
    candidate.missingSlots.length > 1
  ) {
    return "uncertain-teaching";
  }
  if (candidate.missingSlots.includes("relation")) {
    return "missing-relation";
  }
  if (candidate.missingSlots.includes("subject")) {
    return "missing-subject";
  }
  if (candidate.missingSlots.includes("object")) {
    return "missing-object";
  }
  return "ambiguous-intent";
}

function explicitTeachingPartial(candidate: SemanticCandidate): boolean {
  return (
    candidate.result === null &&
    candidate.concepts.some(({ id }) => id === "teaching")
  );
}

function planPartialClarification(
  analysis: SemanticAnalysis,
  policy: UnderstandingPolicy,
): UnderstandingDecision | null {
  if (policy.missingSlotPolicy.partialDecision !== "clarify") {
    return null;
  }

  const partials = analysis.candidates
    .filter(
      (candidate) =>
        candidate.result === null ||
        candidate.missingSlots.length > 0,
    )
    .filter(
      (candidate) =>
        effectiveSideEffect(candidate) === "none" &&
        (candidate.confidence >= policy.partialCandidateThreshold ||
          (policy.missingSlotPolicy.clarifyExplicitTeaching &&
            explicitTeachingPartial(candidate))),
    )
    .sort(candidateComparator);
  const primary = partials[0];
  if (primary === undefined) {
    return null;
  }

  return Object.freeze({
    kind: "clarify",
    candidateOptions: Object.freeze(
      partials.slice(0, policy.maximumAlternatives),
    ),
    missingSlots: Object.freeze([...primary.missingSlots]),
    clarificationKind: clarificationKindForMissing(primary),
    reasonCodes: reasonCodes([
      "partial-candidate",
      "missing-required-slot",
      ...(primary.confidence < policy.partialCandidateThreshold
        ? (["insufficient-confidence"] as const)
        : []),
    ]),
  });
}

function rejectedSideEffectDecision(
  analysis: SemanticAnalysis,
  policy: UnderstandingPolicy,
): UnderstandingDecision | null {
  const rejected = analysis.candidates
    .filter((candidate) => effectiveSideEffect(candidate) !== "none")
    .filter(
      (candidate) =>
        !isNegated(candidate) ||
        policy.negationPolicy.preserveNegatedCandidate,
    )
    .map((candidate) =>
      Object.freeze({
        candidate,
        assessment: assessSideEffect(candidate, analysis, policy),
      }),
    )
    .filter(({ assessment }) => !assessment.safe)
    .sort((left, right) =>
      candidateComparator(left.candidate, right.candidate),
    );
  const first = rejected[0];
  if (first === undefined) {
    return null;
  }

  return Object.freeze({
    kind: "reject-side-effect",
    rejectedCandidate: first.candidate,
    requiredEvidence: first.assessment.requiredEvidence,
    reasonCodes: first.assessment.reasonCodes,
  });
}

function diagnosticsSummary(analysis: SemanticAnalysis) {
  return Object.freeze({
    count: analysis.diagnostics.length,
    codes: Object.freeze(
      [...new Set(analysis.diagnostics.map(({ code }) => code))].sort(),
    ),
  });
}

export function planUnderstanding(
  analysis: SemanticAnalysis,
  policy: UnderstandingPolicy = DEFAULT_UNDERSTANDING_POLICY,
): UnderstandingDecision {
  const groups = viableGroups(analysis, policy);
  const queryGroups = groups.filter(({ representative }) =>
    isQueryLike(representative),
  );

  if (
    analysis.extraction.questionCues.length >= 2 &&
    queryGroups.length >= 2
  ) {
    return Object.freeze({
      kind: "clarify",
      candidateOptions: candidateOptions(queryGroups, policy),
      missingSlots: Object.freeze([]),
      clarificationKind: "ambiguous-intent",
      reasonCodes: reasonCodes([
        "compound-query",
        "conflicting-candidates",
      ]),
    });
  }

  const primaryGroup = groups[0];
  if (primaryGroup === undefined) {
    const partial = planPartialClarification(analysis, policy);
    if (partial !== null) {
      return partial;
    }

    const rejectedSideEffect = rejectedSideEffectDecision(
      analysis,
      policy,
    );
    if (rejectedSideEffect !== null) {
      return rejectedSideEffect;
    }

    const hasStructuredCandidate = analysis.candidates.some(
      (candidate) =>
        candidate.result !== null &&
        candidate.result.type !== "unknown",
    );
    return Object.freeze({
      kind: "no-understanding",
      diagnosticsSummary: diagnosticsSummary(analysis),
      reasonCodes: reasonCodes([
        ...(hasStructuredCandidate
          ? (["insufficient-confidence"] as const)
          : []),
        "no-viable-candidate",
      ]),
    });
  }

  const primary = primaryGroup.representative;
  const compatibleGroups = groups
    .slice(1)
    .filter(({ representative }) =>
      compatibleCandidates(primary, representative),
    );
  const conflictingGroups = groups
    .slice(1)
    .filter(
      ({ representative }) =>
        !compatibleCandidates(primary, representative),
    );
  const nearestConflict = conflictingGroups[0];

  if (
    nearestConflict !== undefined &&
    primary.confidence -
      nearestConflict.representative.confidence <
      policy.minimumCandidateMargin
  ) {
    if (effectiveSideEffect(primary) !== "none") {
      return Object.freeze({
        kind: "reject-side-effect",
        rejectedCandidate: primary,
        requiredEvidence: requiredEvidence(["candidate-margin"]),
        reasonCodes: reasonCodes([
          "insufficient-margin",
          "conflicting-candidates",
        ]),
      });
    }

    return Object.freeze({
      kind: "clarify",
      candidateOptions: candidateOptions(
        [primaryGroup, nearestConflict],
        policy,
      ),
      missingSlots: Object.freeze([]),
      clarificationKind: "conflicting-candidates",
      reasonCodes: reasonCodes([
        "insufficient-margin",
        "conflicting-candidates",
      ]),
    });
  }

  const secondaryCandidates = Object.freeze(
    compatibleGroups
      .slice(0, policy.maximumAlternatives)
      .map(({ representative }) => representative),
  );
  const alternatives = candidateOptions(
    conflictingGroups,
    policy,
  );

  return Object.freeze({
    kind: "accept",
    selectedCandidate: primary,
    secondaryCandidates,
    confidence: createConfidence(primary.confidence),
    reasonCodes: reasonCodes([
      "threshold-met",
      ...(primaryGroup.supporters.length > 1
        ? (["corroborated-producers"] as const)
        : []),
      ...(secondaryCandidates.length > 0
        ? (["compatible-secondary-candidate"] as const)
        : []),
    ]),
    alternatives,
    riskLevel: riskLevel(primary),
  });
}
