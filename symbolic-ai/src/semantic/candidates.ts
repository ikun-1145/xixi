import type { ParseResult } from "@/types";
import { extractSemanticFeatures } from "./extract";
import { normalizeSemanticInput } from "./normalize";
import { normalizeSemanticContext } from "./context";
import { produceContextCandidates } from "./producers/contextProducer";
import { produceLegacyRegexCandidate } from "./producers/legacyRegexProducer";
import { produceLexiconCandidates } from "./producers/lexiconProducer";
import { produceRelationPatternCandidates } from "./producers/relationPatternProducer";
import {
  SEMANTIC_SCORING,
  clampConfidence,
} from "./scoring";
import type {
  CandidateSideEffect,
  MatchedFeature,
  SemanticAnalysis,
  SemanticCandidate,
  SemanticConcept,
  SemanticContext,
  SemanticDiagnostic,
  SemanticEntity,
} from "./types";

function resultInterpretationKey(result: ParseResult | null): string {
  if (result === null) {
    return "partial";
  }

  switch (result.type) {
    case "intent":
      return `intent:${result.intent}:${result.entities.join("|")}`;
    case "statement":
      return `statement:${result.subject}:${result.relation}:${result.object}:${result.negated}`;
    case "query":
      return `query:${result.kind}:${result.subject}:${result.relation}:${result.object ?? ""}`;
    case "unknown":
      return "unknown";
  }
}

function dedupeKey(candidate: SemanticCandidate): string {
  const partialIdentity =
    candidate.result === null
      ? candidate.id
      : resultInterpretationKey(candidate.result);
  return [
    candidate.producer,
    partialIdentity,
    [...candidate.missingSlots].sort().join(","),
  ].join("::");
}

function featureKey(feature: MatchedFeature): string {
  return [
    feature.kind,
    feature.key,
    feature.value ?? "",
    feature.rawRange?.start ?? "",
    feature.rawRange?.end ?? "",
  ].join(":");
}

function conceptKey(concept: SemanticConcept): string {
  const evidence = concept.evidence[0];
  return [
    concept.id,
    evidence?.rawRange?.start ?? "",
    evidence?.rawRange?.end ?? "",
  ].join(":");
}

function entityKey(entity: SemanticEntity): string {
  return [
    entity.kind,
    entity.start,
    entity.end,
    entity.value,
  ].join(":");
}

function uniqueBy<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
): readonly T[] {
  const seen = new Set<string>();
  const result: T[] = [];

  for (const value of values) {
    const key = keyOf(value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }

  return Object.freeze(result);
}

function strongerSideEffect(
  left: CandidateSideEffect,
  right: CandidateSideEffect,
): CandidateSideEffect {
  const rank: Readonly<Record<CandidateSideEffect, number>> = {
    none: 0,
    "memory-write": 1,
    "knowledge-write": 2,
  };
  return rank[left] >= rank[right] ? left : right;
}

function mergeCandidates(
  left: SemanticCandidate,
  right: SemanticCandidate,
): SemanticCandidate {
  return Object.freeze({
    id: left.id.localeCompare(right.id) <= 0 ? left.id : right.id,
    producer: left.producer,
    producerWeight: clampConfidence(
      Math.max(left.producerWeight, right.producerWeight),
    ),
    result: left.result ?? right.result,
    concepts: uniqueBy(
      [...left.concepts, ...right.concepts],
      conceptKey,
    ),
    entities: uniqueBy(
      [...left.entities, ...right.entities],
      entityKey,
    ),
    confidence: clampConfidence(
      Math.max(left.confidence, right.confidence),
    ),
    evidence: uniqueBy(
      [...left.evidence, ...right.evidence],
      featureKey,
    ),
    missingSlots: Object.freeze(
      [...new Set([...left.missingSlots, ...right.missingSlots])].sort(),
    ),
    sideEffect: strongerSideEffect(
      left.sideEffect,
      right.sideEffect,
    ),
  });
}

/**
 * Deduplicates only within the same producer. Independent producers remain
 * separate candidates so a future Planner can see corroborating sources.
 */
export function deduplicateSemanticCandidates(
  candidates: readonly SemanticCandidate[],
): readonly SemanticCandidate[] {
  const merged = new Map<string, SemanticCandidate>();

  for (const candidate of candidates) {
    const key = dedupeKey(candidate);
    const existing = merged.get(key);
    merged.set(
      key,
      existing === undefined
        ? candidate
        : mergeCandidates(existing, candidate),
    );
  }

  return Object.freeze([...merged.values()]);
}

export function sortSemanticCandidates(
  candidates: readonly SemanticCandidate[],
): readonly SemanticCandidate[] {
  return Object.freeze(
    [...candidates].sort(
      (left, right) =>
        right.confidence - left.confidence ||
        left.missingSlots.length - right.missingSlots.length ||
        SEMANTIC_SCORING.producerTieBreak[left.producer] -
          SEMANTIC_SCORING.producerTieBreak[right.producer] ||
        left.id.localeCompare(right.id),
    ),
  );
}

function createDiagnostics(
  raw: string,
  candidates: readonly SemanticCandidate[],
  context: SemanticContext | undefined,
): readonly SemanticDiagnostic[] {
  const diagnostics: SemanticDiagnostic[] = [];

  if (raw.trim().length === 0) {
    diagnostics.push(
      Object.freeze({
        level: "info",
        code: "semantic.empty-input",
        message: "Input contains no semantic surface content.",
      }),
    );
  }

  if (
    candidates.every(
      (candidate) =>
        candidate.producer === "legacy-regex" &&
        candidate.result?.type === "unknown",
    )
  ) {
    diagnostics.push(
      Object.freeze({
        level: "debug",
        code: "semantic.no-structured-candidate",
        message: "No structured semantic candidate was generated.",
      }),
    );
  }

  if (
    context !== undefined &&
    candidates.some(({ producer }) => producer === "context")
  ) {
    diagnostics.push(
      Object.freeze({
        level: "debug",
        code: "semantic.context-candidate-generated",
        message: "A bounded context candidate was generated.",
      }),
    );
  }

  return Object.freeze(diagnostics);
}

export function analyzeSemanticInput(
  raw: string,
  context?: SemanticContext,
): SemanticAnalysis {
  const input = normalizeSemanticInput(raw);
  const extraction = extractSemanticFeatures(input);
  const baseCandidates = [
    produceLegacyRegexCandidate(extraction),
    ...produceLexiconCandidates(extraction),
    ...produceRelationPatternCandidates(extraction),
  ];
  const normalizedContext =
    context === undefined ? undefined : normalizeSemanticContext(context);
  const contextProduction =
    normalizedContext === undefined
      ? Object.freeze({
          candidates: Object.freeze([]),
          supersededCandidateIds: Object.freeze([]),
        })
      : produceContextCandidates(
          extraction,
          baseCandidates,
          normalizedContext,
        );
  const superseded = new Set(contextProduction.supersededCandidateIds);
  const generated = [
    ...baseCandidates.filter(({ id }) => !superseded.has(id)),
    ...contextProduction.candidates,
  ];
  const candidates = sortSemanticCandidates(
    deduplicateSemanticCandidates(generated),
  );

  return Object.freeze({
    input,
    extraction,
    candidates,
    diagnostics: createDiagnostics(
      raw,
      candidates,
      normalizedContext,
    ),
  });
}
