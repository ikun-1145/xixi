import type {
  ClarificationCandidateLabel,
  ClarificationContext,
  ClarificationReasonCategory,
  ClarificationSlot,
  IntentName,
  ParseFailure,
  ParseResult,
  ParsedIntent,
  ParsedQuery,
  Relation,
} from "@/types";
import type {
  SemanticCandidate,
  SemanticAnalysis,
  UnderstandingDecision,
  UnderstandingReasonCode,
} from "./types";
import {
  isSemanticContextPronoun,
  isSemanticSelfReference,
} from "./context";
import {
  evaluateLegacySideEffectFallback,
  type LegacySideEffectAdmission,
} from "./legacySideEffectGate";

export type SemanticMode = "off" | "shadow" | "passive";

export type SemanticAdoptionFallbackReason =
  | "side-effect-prohibited"
  | "unsupported-result"
  | "incomplete-result"
  | "legacy-conflict"
  | "side-effect-rejected";

export type SemanticAdoptionResult =
  | {
      readonly kind: "adopt";
      readonly result: ParsedIntent | ParsedQuery;
    }
  | {
      readonly kind: "fallback-legacy";
      readonly result: ParseResult;
      readonly reason: SemanticAdoptionFallbackReason;
    }
  | {
      readonly kind: "clarification";
      readonly context: ClarificationContext;
    }
  | {
      readonly kind: "no-understanding";
      readonly failure: ParseFailure;
    };

export type SemanticShadowCandidateType =
  | "intent"
  | "query"
  | "statement"
  | "partial"
  | "unknown";

/**
 * In-memory, privacy-safe comparison data. It intentionally contains no raw
 * input, entity values, subject/object triples, candidate ids from producers,
 * user names or teaching content.
 */
export interface SemanticShadowDiagnostic {
  readonly mode: Exclude<SemanticMode, "off">;
  readonly legacyType: ParseResult["type"];
  readonly decisionType: UnderstandingDecision["kind"] | "error";
  readonly selectedCandidateId: string | null;
  readonly selectedCandidateType: SemanticShadowCandidateType | null;
  readonly confidence: number | null;
  readonly reasonCodes: readonly UnderstandingReasonCode[];
  readonly equivalentToLegacy: boolean;
  readonly semanticAdopted: boolean;
  readonly fellBackToLegacy: boolean;
  readonly adapterKind: SemanticAdoptionResult["kind"] | "error";
  readonly semanticError: boolean;
}

const PASSIVE_INTENTS: ReadonlySet<IntentName> = new Set([
  "Greeting",
  "Thanks",
  "Farewell",
  "Identity",
  "RecallName",
]);

const KNOWN_SLOTS: ReadonlySet<ClarificationSlot> = new Set([
  "subject",
  "relation",
  "object",
  "name",
  "intent",
]);

function normalized(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("und");
}

function effectiveSideEffect(candidate: SemanticCandidate): boolean {
  return (
    candidate.sideEffect !== "none" ||
    candidate.result?.type === "statement" ||
    (candidate.result?.type === "intent" &&
      candidate.result.intent === "RememberName")
  );
}

function isPassiveResult(
  result: ParseResult,
): result is ParsedIntent | ParsedQuery {
  return (
    result.type === "query" ||
    (result.type === "intent" && PASSIVE_INTENTS.has(result.intent))
  );
}

function parseResultsEquivalent(
  left: ParseResult,
  right: ParseResult,
): boolean {
  if (left.type !== right.type) return false;

  switch (left.type) {
    case "intent": {
      if (right.type !== "intent") return false;
      return (
        left.intent === right.intent &&
        left.entities.length === right.entities.length &&
        left.entities.every(
          (entity, index) =>
            normalized(entity) === normalized(right.entities[index] ?? ""),
        )
      );
    }
    case "query":
      return (
        right.type === "query" &&
        left.kind === right.kind &&
        normalized(left.subject) === normalized(right.subject) &&
        normalized(left.relation) === normalized(right.relation) &&
        normalized(left.object ?? "") === normalized(right.object ?? "") &&
        left.explain === right.explain
      );
    case "statement":
      return (
        right.type === "statement" &&
        normalized(left.subject) === normalized(right.subject) &&
        normalized(left.relation) === normalized(right.relation) &&
        normalized(left.object) === normalized(right.object) &&
        left.negated === right.negated
      );
    case "unknown":
      return right.type === "unknown";
  }
}

function isContextResolutionOfLegacy(
  candidate: SemanticCandidate,
  legacyResult: ParseResult,
): boolean {
  const result = candidate.result;
  if (
    candidate.producer !== "context" ||
    result?.type !== "query"
  ) {
    return false;
  }
  if (
    legacyResult.type === "intent" &&
    legacyResult.intent === "Identity"
  ) {
    return (
      result.relation === "意思是" ||
      candidate.concepts.some(({ id }) => id === "context-ellipsis")
    );
  }
  if (legacyResult.type !== "query") return false;
  if (
    !isSemanticContextPronoun(legacyResult.subject) &&
    !isSemanticSelfReference(legacyResult.subject)
  ) {
    return false;
  }
  return (
    normalized(result.relation) === normalized(legacyResult.relation) &&
    result.kind === legacyResult.kind &&
    normalized(result.object ?? "") ===
      normalized(legacyResult.object ?? "")
  );
}

function candidateLabel(
  candidate: SemanticCandidate,
): ClarificationCandidateLabel {
  const result = candidate.result;
  if (result?.type === "intent") {
    switch (result.intent) {
      case "Greeting":
        return "greeting";
      case "Thanks":
        return "thanks";
      case "Farewell":
        return "farewell";
      case "Identity":
        return "identity";
      case "RecallName":
        return "recall-name";
      case "RememberName":
        return "remember-name";
    }
  }
  if (result?.type === "query") return "query";
  if (
    result?.type === "statement" ||
    candidate.concepts.some(({ id }) => id === "teaching")
  ) {
    return "teaching";
  }
  return "unknown";
}

function clarificationRelation(
  candidate: SemanticCandidate | undefined,
): Relation | undefined {
  const result = candidate?.result;
  if (result?.type === "query" || result?.type === "statement") {
    return result.relation;
  }
  return candidate?.entities.find(({ kind }) => kind === "relation")
    ?.value;
}

function reasonCategory(
  decision: Extract<UnderstandingDecision, { readonly kind: "clarify" }>,
): ClarificationReasonCategory {
  if (
    decision.clarificationKind === "ambiguous-intent" ||
    decision.clarificationKind === "conflicting-candidates"
  ) {
    return "ambiguous";
  }
  if (
    decision.clarificationKind === "uncertain-name" ||
    decision.clarificationKind === "uncertain-teaching"
  ) {
    return "uncertain";
  }
  return "missing-information";
}

function toClarificationContext(
  decision: Extract<UnderstandingDecision, { readonly kind: "clarify" }>,
): ClarificationContext {
  const missingSlots = Object.freeze(
    [...new Set(decision.missingSlots)]
      .filter((slot): slot is ClarificationSlot =>
        KNOWN_SLOTS.has(slot as ClarificationSlot),
      )
      .sort(),
  );
  const candidateLabels = Object.freeze(
    [...new Set(decision.candidateOptions.map(candidateLabel))].sort(),
  );
  const contextLabels = Object.freeze(
    [
      ...new Set(
        decision.candidateOptions.flatMap(({ entities }) =>
          entities
            .filter(
              ({ source, kind }) =>
                source === "context" &&
                (kind === "subject" || kind === "self"),
            )
            .map(({ value }) => value),
        ),
      ),
    ]
      .filter((value) => value.length > 0 && value.length <= 80)
      .slice(0, 3),
  );
  const relation = clarificationRelation(decision.candidateOptions[0]);

  return Object.freeze({
    clarificationKind: decision.clarificationKind,
    missingSlots,
    candidateLabels,
    reasonCategory: reasonCategory(decision),
    ...(relation === undefined ? {} : { relation }),
    ...(contextLabels.length === 0 ? {} : { contextLabels }),
  });
}

function canClarifyInsteadOfLegacy(
  decision: Extract<UnderstandingDecision, { readonly kind: "clarify" }>,
  legacyResult: ParseResult,
): boolean {
  if (legacyResult.type === "unknown") return true;

  if (
    legacyResult.type === "query" &&
    isSemanticContextPronoun(legacyResult.subject) &&
    decision.missingSlots.includes("subject") &&
    decision.candidateOptions.some(
      ({ producer }) => producer === "context",
    )
  ) {
    return true;
  }

  // The Planner only emits compound-query after finding multiple complete,
  // query-like interpretations. Let that bounded, read-only clarification
  // supersede a legacy matcher that stopped at the first question.
  if (
    decision.reasonCodes.includes("compound-query") &&
    decision.candidateOptions.length >= 2 &&
    decision.candidateOptions.every(
      (candidate) => !effectiveSideEffect(candidate),
    )
  ) {
    return true;
  }

  // The legacy statement grammar can parse a question particle as an object
  // (for example "你会吗"). A structured missing-object decision is safer
  // than persisting that accidental triple.
  return (
    legacyResult.type === "statement" &&
    decision.missingSlots.includes("object") &&
    /^(?:吗|呢|什么|啥|\?)$/u.test(legacyResult.object.trim()) &&
    decision.candidateOptions.some((candidate) =>
      candidate.evidence.some(({ kind }) => kind === "question-cue"),
    )
  );
}

function blockedSideEffectFailure(
  legacyResult: ParseResult,
  reason: string,
): SemanticAdoptionResult {
  return Object.freeze({
    kind: "no-understanding",
    failure: Object.freeze({
      type: "unknown",
      raw: legacyResult.raw,
      reason,
    }),
  });
}

function adaptLegacySideEffectAdmission(
  admission: LegacySideEffectAdmission,
  legacyResult: ParseResult,
): SemanticAdoptionResult | null {
  switch (admission.kind) {
    case "allow-passive-legacy":
      return null;
    case "allow-legacy-side-effect":
      return Object.freeze({
        kind: "fallback-legacy",
        result: legacyResult,
        reason: "side-effect-prohibited",
      });
    case "block-and-clarify":
      return Object.freeze({
        kind: "clarification",
        context: toClarificationContext(admission.decision),
      });
    case "block-and-no-understanding":
      return blockedSideEffectFailure(
        legacyResult,
        `legacy-side-effect-blocked:${admission.reason}`,
      );
    case "reject":
      return blockedSideEffectFailure(
        legacyResult,
        `legacy-side-effect-rejected:${admission.reason}`,
      );
  }
}

export function adaptUnderstandingDecision(
  decision: UnderstandingDecision,
  legacyResult: ParseResult,
  analysis: SemanticAnalysis,
): SemanticAdoptionResult {
  const sideEffectAdmission = adaptLegacySideEffectAdmission(
    evaluateLegacySideEffectFallback(
      decision,
      legacyResult,
      analysis,
    ),
    legacyResult,
  );
  if (sideEffectAdmission !== null) return sideEffectAdmission;

  switch (decision.kind) {
    case "accept": {
      const accepted = [
        decision.selectedCandidate,
        ...decision.secondaryCandidates,
      ];
      if (accepted.some(effectiveSideEffect)) {
        return Object.freeze({
          kind: "fallback-legacy",
          result: legacyResult,
          reason: "side-effect-prohibited",
        });
      }

      const result = decision.selectedCandidate.result;
      if (result === null || result.type === "unknown") {
        return Object.freeze({
          kind: "fallback-legacy",
          result: legacyResult,
          reason: "incomplete-result",
        });
      }
      if (
        decision.selectedCandidate.missingSlots.length > 0 ||
        !isPassiveResult(result)
      ) {
        return Object.freeze({
          kind: "fallback-legacy",
          result: legacyResult,
          reason: "unsupported-result",
        });
      }
      if (
        legacyResult.type !== "unknown" &&
        !parseResultsEquivalent(result, legacyResult) &&
        !isContextResolutionOfLegacy(
          decision.selectedCandidate,
          legacyResult,
        )
      ) {
        return Object.freeze({
          kind: "fallback-legacy",
          result: legacyResult,
          reason: "legacy-conflict",
        });
      }
      return Object.freeze({ kind: "adopt", result });
    }
    case "clarify":
      return canClarifyInsteadOfLegacy(decision, legacyResult)
        ? Object.freeze({
            kind: "clarification",
            context: toClarificationContext(decision),
          })
        : Object.freeze({
            kind: "fallback-legacy",
            result: legacyResult,
            reason: "legacy-conflict",
          });
    case "reject-side-effect":
      return legacyResult.type === "unknown"
        ? blockedSideEffectFailure(
            legacyResult,
            "semantic-side-effect-rejected",
          )
        : Object.freeze({
            kind: "fallback-legacy",
            result: legacyResult,
            reason: "side-effect-rejected",
          });
    case "no-understanding":
      return legacyResult.type === "unknown"
        ? Object.freeze({
            kind: "no-understanding",
            failure: legacyResult,
          })
        : Object.freeze({
            kind: "fallback-legacy",
            result: legacyResult,
            reason: "legacy-conflict",
          });
  }
}

function decisionCandidate(
  decision: UnderstandingDecision,
): SemanticCandidate | undefined {
  switch (decision.kind) {
    case "accept":
      return decision.selectedCandidate;
    case "clarify":
      return decision.candidateOptions[0];
    case "reject-side-effect":
      return decision.rejectedCandidate;
    case "no-understanding":
      return undefined;
  }
}

function shadowCandidateType(
  candidate: SemanticCandidate | undefined,
): SemanticShadowCandidateType | null {
  if (candidate === undefined) return null;
  return candidate.result?.type ?? "partial";
}

function privacySafeCandidateId(
  candidate: SemanticCandidate | undefined,
): string | null {
  if (candidate === undefined) return null;
  const result = candidate.result;
  if (result?.type === "intent") {
    return `semantic:${candidate.producer}:intent:${result.intent}`;
  }
  return `semantic:${candidate.producer}:${result?.type ?? "partial"}`;
}

function decisionReasonCodes(
  decision: UnderstandingDecision,
): readonly UnderstandingReasonCode[] {
  return Object.freeze([...decision.reasonCodes]);
}

function decisionConfidence(
  decision: UnderstandingDecision,
  candidate: SemanticCandidate | undefined,
): number | null {
  return decision.kind === "accept"
    ? decision.confidence
    : candidate?.confidence ?? null;
}

export function createSemanticShadowDiagnostic(
  mode: Exclude<SemanticMode, "off">,
  legacyResult: ParseResult,
  decision: UnderstandingDecision,
  adaptation: SemanticAdoptionResult,
): SemanticShadowDiagnostic {
  const candidate = decisionCandidate(decision);
  const equivalent =
    candidate?.result === undefined || candidate.result === null
      ? false
      : parseResultsEquivalent(candidate.result, legacyResult);
  const semanticAdopted =
    mode === "passive" && adaptation.kind !== "fallback-legacy";

  return Object.freeze({
    mode,
    legacyType: legacyResult.type,
    decisionType: decision.kind,
    selectedCandidateId: privacySafeCandidateId(candidate),
    selectedCandidateType: shadowCandidateType(candidate),
    confidence: decisionConfidence(decision, candidate),
    reasonCodes: decisionReasonCodes(decision),
    equivalentToLegacy: equivalent,
    semanticAdopted,
    fellBackToLegacy:
      mode === "shadow" || adaptation.kind === "fallback-legacy",
    adapterKind: adaptation.kind,
    semanticError: false,
  });
}

export function createSemanticErrorShadowDiagnostic(
  mode: Exclude<SemanticMode, "off">,
  legacyResult: ParseResult,
): SemanticShadowDiagnostic {
  return Object.freeze({
    mode,
    legacyType: legacyResult.type,
    decisionType: "error",
    selectedCandidateId: null,
    selectedCandidateType: null,
    confidence: null,
    reasonCodes: Object.freeze([]),
    equivalentToLegacy: false,
    semanticAdopted: false,
    fellBackToLegacy: true,
    adapterKind: "error",
    semanticError: true,
  });
}
