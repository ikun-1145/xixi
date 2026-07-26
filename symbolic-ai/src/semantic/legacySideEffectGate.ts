import {
  hasExplicitSideEffectProhibition,
  hasUnsafeLegacySideEffectStructure,
} from "@/parser/sideEffectSafety";
import type {
  ParseResult,
  ParsedIntent,
  ParsedStatement,
} from "@/types";
import type {
  SemanticAnalysis,
  SemanticCandidate,
  UnderstandingDecision,
} from "./types";

export type LegacySideEffectAdmissionReason =
  | "not-a-side-effect"
  | "semantic-side-effect-confirmed"
  | "semantic-clarification-required"
  | "semantic-side-effect-rejected"
  | "semantic-side-effect-not-accepted"
  | "negation-detected"
  | "question-detected"
  | "missing-required-slot"
  | "compound-or-conflicting-side-effect"
  | "side-effect-interpretation-mismatch"
  | "explicit-prohibition"
  | "unsafe-input-structure";

export type LegacySideEffectAdmission =
  | {
      readonly kind: "allow-legacy-side-effect";
      readonly reason: "semantic-side-effect-confirmed";
    }
  | {
      readonly kind: "allow-passive-legacy";
      readonly reason: "not-a-side-effect";
    }
  | {
      readonly kind: "block-and-clarify";
      readonly reason: "semantic-clarification-required";
      readonly decision: Extract<
        UnderstandingDecision,
        { readonly kind: "clarify" }
      >;
    }
  | {
      readonly kind: "block-and-no-understanding";
      readonly reason: Exclude<
        LegacySideEffectAdmissionReason,
        | "not-a-side-effect"
        | "semantic-side-effect-confirmed"
        | "semantic-clarification-required"
      >;
    }
  | {
      readonly kind: "reject";
      readonly reason: "side-effect-interpretation-mismatch";
    };

type LegacySideEffectResult = ParsedStatement | ParsedIntent;

const GREETING_PREFIX =
  /^(?:你好|您好|嗨|哈喽|hello|hi)[,，]\s*/iu;

function isRememberNameResult(
  result: ParseResult,
): result is ParsedIntent {
  return (
    result.type === "intent" &&
    result.intent === "RememberName"
  );
}

export function isLegacySideEffectResult(
  result: ParseResult,
): result is LegacySideEffectResult {
  return result.type === "statement" || isRememberNameResult(result);
}

function effectiveSideEffect(candidate: SemanticCandidate): boolean {
  return (
    candidate.sideEffect !== "none" ||
    candidate.result?.type === "statement" ||
    (candidate.result?.type === "intent" &&
      candidate.result.intent === "RememberName")
  );
}

function normalized(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("und");
}

function normalizedStatementParts(
  statement: ParsedStatement,
  analysis: SemanticAnalysis,
): readonly [string, string, string, boolean] {
  let relation = normalized(statement.relation);
  let object = normalized(statement.object);
  const hasIsAConcept = analysis.extraction.relations.some(
    ({ conceptId }) => conceptId === "is-a",
  );
  if (
    relation === "是" &&
    hasIsAConcept
  ) {
    relation = "属于";
  }
  if (
    relation === "属于" &&
    object.startsWith("一种") &&
    object.length > "一种".length
  ) {
    object = object.slice("一种".length);
  }
  if (relation === "指的是") {
    relation = "意思是";
  }
  return Object.freeze([
    normalized(statement.subject),
    relation,
    object,
    statement.negated,
  ]);
}

function sideEffectInterpretationKey(
  result: ParseResult | null,
  analysis: SemanticAnalysis,
): string | null {
  if (result?.type === "statement") {
    return `knowledge:${normalizedStatementParts(result, analysis).join("|")}`;
  }
  if (
    result?.type === "intent" &&
    result.intent === "RememberName"
  ) {
    const name = result.entities[0];
    return name === undefined
      ? null
      : `memory:name:${normalized(name)}`;
  }
  return null;
}

function acceptedCandidates(
  decision: UnderstandingDecision,
): readonly SemanticCandidate[] {
  return decision.kind === "accept"
    ? Object.freeze([
        decision.selectedCandidate,
        ...decision.secondaryCandidates,
      ])
    : Object.freeze([]);
}

function distinctCompleteSideEffects(
  analysis: SemanticAnalysis,
): ReadonlySet<string> {
  return new Set(
    analysis.candidates
      .filter(effectiveSideEffect)
      .filter(
        (candidate) =>
          candidate.result !== null &&
          candidate.result.type !== "unknown" &&
          candidate.missingSlots.length === 0,
      )
      .map((candidate) =>
        sideEffectInterpretationKey(candidate.result, analysis),
      )
      .filter((key): key is string => key !== null),
  );
}

function structuralInputFor(
  legacyResult: LegacySideEffectResult,
): string {
  return isRememberNameResult(legacyResult)
    ? legacyResult.raw.trim().replace(GREETING_PREFIX, "")
    : legacyResult.raw;
}

function block(
  reason: Extract<
    LegacySideEffectAdmission,
    { readonly kind: "block-and-no-understanding" }
  >["reason"],
): LegacySideEffectAdmission {
  return Object.freeze({
    kind: "block-and-no-understanding",
    reason,
  });
}

/**
 * Final, centralized admission gate for Legacy Memory/Knowledge writes.
 * Semantic still never performs a mutation; it only confirms whether the
 * already-parsed Legacy result is safe enough to retain its existing path.
 */
export function evaluateLegacySideEffectFallback(
  semanticDecision: UnderstandingDecision,
  legacyResult: ParseResult,
  analysis: SemanticAnalysis,
): LegacySideEffectAdmission {
  if (!isLegacySideEffectResult(legacyResult)) {
    return Object.freeze({
      kind: "allow-passive-legacy",
      reason: "not-a-side-effect",
    });
  }

  if (semanticDecision.kind === "clarify") {
    return Object.freeze({
      kind: "block-and-clarify",
      reason: "semantic-clarification-required",
      decision: semanticDecision,
    });
  }
  if (semanticDecision.kind === "reject-side-effect") {
    return block("semantic-side-effect-rejected");
  }
  if (semanticDecision.kind !== "accept") {
    return block("semantic-side-effect-not-accepted");
  }

  if (analysis.extraction.negationCues.length > 0) {
    return block("negation-detected");
  }
  if (analysis.extraction.questionCues.length > 0) {
    return block("question-detected");
  }
  if (hasExplicitSideEffectProhibition(analysis.input.raw)) {
    return block("explicit-prohibition");
  }
  if (
    hasUnsafeLegacySideEffectStructure(
      structuralInputFor(legacyResult),
    )
  ) {
    return block("unsafe-input-structure");
  }

  const semanticSideEffects = acceptedCandidates(
    semanticDecision,
  ).filter(effectiveSideEffect);
  if (
    semanticSideEffects.length === 0 ||
    semanticSideEffects.some(
      (candidate) =>
        candidate.result === null ||
        candidate.missingSlots.length > 0,
    )
  ) {
    return block(
      semanticSideEffects.length === 0
        ? "semantic-side-effect-not-accepted"
        : "missing-required-slot",
    );
  }

  if (distinctCompleteSideEffects(analysis).size > 1) {
    return block("compound-or-conflicting-side-effect");
  }

  const legacyKey = sideEffectInterpretationKey(
    legacyResult,
    analysis,
  );
  const semanticKeys = new Set(
    semanticSideEffects
      .map((candidate) =>
        sideEffectInterpretationKey(candidate.result, analysis),
      )
      .filter((key): key is string => key !== null),
  );
  if (legacyKey === null || !semanticKeys.has(legacyKey)) {
    return Object.freeze({
      kind: "reject",
      reason: "side-effect-interpretation-mismatch",
    });
  }

  return Object.freeze({
    kind: "allow-legacy-side-effect",
    reason: "semantic-side-effect-confirmed",
  });
}
