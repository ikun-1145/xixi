import type { ParsedQuery, QueryKind, Relation } from "@/types";
import {
  isSemanticContextPronoun,
  isSemanticSelfReference,
} from "../context";
import { mapNormalizedRangeToRaw } from "../normalize";
import { SEMANTIC_SCORING } from "../scoring";
import {
  createConfidence,
  type MatchedFeature,
  type RawTextRange,
  type SemanticCandidate,
  type SemanticConcept,
  type SemanticContext,
  type SemanticContextEntityReference,
  type SemanticEntity,
  type SemanticExtraction,
  type SemanticTurnSummary,
} from "../types";

export interface ContextCandidateProduction {
  readonly candidates: readonly SemanticCandidate[];
  readonly supersededCandidateIds: readonly string[];
}

interface ContextFocus {
  readonly kind: "none" | "unique" | "ambiguous";
  readonly entities: readonly SemanticContextEntityReference[];
}

interface EllipsisSubject {
  readonly value: string;
  readonly rawRange: RawTextRange;
  readonly source: "explicit" | "context";
  readonly ambiguousEntities: readonly SemanticContextEntityReference[];
}

function normalized(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("und");
}

function latestRelevantTurn(
  context: SemanticContext,
): SemanticTurnSummary | undefined {
  return [...context.recentTurns]
    .reverse()
    .find(
      (turn) =>
        turn.relation !== undefined ||
        turn.focusEntity !== undefined ||
        turn.entityReferences.length > 0,
    );
}

function contextFocus(context: SemanticContext): ContextFocus {
  const turn = latestRelevantTurn(context);
  if (turn === undefined) {
    return Object.freeze({ kind: "none", entities: Object.freeze([]) });
  }
  if (turn.focusEntity !== undefined) {
    return Object.freeze({
      kind: "unique",
      entities: Object.freeze([turn.focusEntity]),
    });
  }

  const seen = new Set<string>();
  const entities = Object.freeze(
    turn.entityReferences
      .filter(({ kind }) => kind === "subject" || kind === "self")
      .filter((entity) => {
        const key = normalized(entity.value);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
  );
  if (entities.length === 1) {
    return Object.freeze({ kind: "unique", entities });
  }
  if (entities.length > 1) {
    return Object.freeze({ kind: "ambiguous", entities });
  }
  return Object.freeze({ kind: "none", entities });
}

function inheritedRelation(context: SemanticContext): Relation | null {
  return (
    [...context.recentTurns]
      .reverse()
      .find(({ relation }) => relation !== undefined)
      ?.relation ?? null
  );
}

function contextEntity(
  kind: SemanticEntity["kind"],
  value: string,
  rawText: string,
  rawRange: RawTextRange,
  source: SemanticEntity["source"],
): SemanticEntity {
  return Object.freeze({
    kind,
    value,
    rawText,
    start: rawRange.start,
    end: rawRange.end,
    source,
    confidence: SEMANTIC_SCORING.context.resolvedQuery,
  });
}

function feature(
  key: string,
  value: string,
  weight: ReturnType<typeof createConfidence>,
  rawRange?: RawTextRange,
): MatchedFeature {
  return Object.freeze({
    kind: "context-reference",
    key,
    value,
    weight,
    ...(rawRange === undefined
      ? {}
      : { rawRange: Object.freeze({ ...rawRange }) }),
  });
}

function concept(
  id: string,
  canonical: string,
  evidence: readonly MatchedFeature[],
): SemanticConcept {
  return Object.freeze({
    id,
    canonical,
    confidence: SEMANTIC_SCORING.context.resolvedQuery,
    evidence,
  });
}

function candidate(
  id: string,
  result: ParsedQuery | null,
  entities: readonly SemanticEntity[],
  evidence: readonly MatchedFeature[],
  missingSlots: readonly string[],
  concepts: readonly SemanticConcept[],
): SemanticCandidate {
  return Object.freeze({
    id,
    producer: "context",
    producerWeight: SEMANTIC_SCORING.producerWeight.context,
    result,
    concepts: Object.freeze([...concepts]),
    entities: Object.freeze([...entities]),
    confidence:
      result === null
        ? SEMANTIC_SCORING.context.unresolvedReference
        : SEMANTIC_SCORING.context.resolvedQuery,
    evidence: Object.freeze([...evidence]),
    missingSlots: Object.freeze([...missingSlots]),
    sideEffect: "none",
  });
}

function subjectRawRange(
  extraction: SemanticExtraction,
  subject: string,
): RawTextRange {
  const start = extraction.input.matchKey.indexOf(subject);
  if (start < 0) return Object.freeze({ start: 0, end: 0 });
  return mapNormalizedRangeToRaw(
    extraction.input,
    "matchKey",
    start,
    start + subject.length,
  );
}

function isContextPronoun(value: string): boolean {
  return isSemanticContextPronoun(value);
}

function isSelfReference(value: string): boolean {
  return isSemanticSelfReference(value);
}

function queryWithResolvedSubject(
  extraction: SemanticExtraction,
  base: SemanticCandidate,
  query: ParsedQuery,
  resolvedSubject: string,
  subjectSource: "explicit" | "context",
): SemanticCandidate {
  const rawRange = subjectRawRange(extraction, normalized(query.subject));
  const rawText = extraction.input.raw.slice(rawRange.start, rawRange.end);
  const subject = contextEntity(
    isSelfReference(resolvedSubject) ? "self" : "subject",
    isSelfReference(resolvedSubject)
      ? "Sunland AI · Beta"
      : resolvedSubject,
    rawText,
    rawRange,
    subjectSource,
  );
  const result = Object.freeze({
    ...query,
    subject: subject.value,
  });
  const contextEvidence = feature(
    "context:resolved-subject",
    subject.value,
    SEMANTIC_SCORING.context.inheritedSubject,
    rawRange,
  );

  return candidate(
    `context:query:${result.subject}:${result.relation}:${result.kind}`,
    result,
    Object.freeze([
      subject,
      ...base.entities.filter(({ kind }) => kind !== "subject"),
    ]),
    Object.freeze([...base.evidence, contextEvidence]),
    Object.freeze([]),
    base.concepts,
  );
}

function unresolvedPronounCandidate(
  extraction: SemanticExtraction,
  base: SemanticCandidate,
  query: ParsedQuery,
  focus: ContextFocus,
): SemanticCandidate {
  const rawRange = subjectRawRange(extraction, normalized(query.subject));
  const evidence = Object.freeze([
    ...base.evidence,
    feature(
      focus.kind === "ambiguous"
        ? "context:ambiguous-subject"
        : "context:missing-subject",
      query.subject,
      SEMANTIC_SCORING.context.unresolvedReference,
      rawRange,
    ),
  ]);
  const ambiguityEntities = focus.entities.map((entity) =>
    contextEntity(
      entity.kind === "self" ? "self" : "subject",
      entity.value,
      "",
      Object.freeze({ start: 0, end: 0 }),
      "context",
    ),
  );

  return candidate(
    `context:partial:${query.relation}:${focus.kind}`,
    null,
    Object.freeze(ambiguityEntities),
    evidence,
    Object.freeze(["subject"]),
    base.concepts,
  );
}

function contextualizeExplicitRelations(
  extraction: SemanticExtraction,
  baseCandidates: readonly SemanticCandidate[],
  context: SemanticContext,
): ContextCandidateProduction {
  const focus = contextFocus(context);
  const candidates: SemanticCandidate[] = [];
  const superseded: string[] = [];
  const hasExplicitDefinitionQuery = baseCandidates.some(
    ({ result }) =>
      result?.type === "query" &&
      result.kind === "object-of" &&
      result.relation === "意思是",
  );

  for (const base of baseCandidates) {
    const result = base.result;
    if (
      hasExplicitDefinitionQuery &&
      base.producer === "legacy-regex" &&
      result?.type === "intent" &&
      result.intent === "Identity"
    ) {
      superseded.push(base.id);
      continue;
    }
    if (
      result?.type === "statement" &&
      isContextPronoun(result.subject)
    ) {
      const rawRange = subjectRawRange(
        extraction,
        normalized(result.subject),
      );
      const contextEvidence = feature(
        "context:side-effect-subject-prohibited",
        result.subject,
        SEMANTIC_SCORING.context.unresolvedReference,
        rawRange,
      );
      candidates.push(
        candidate(
          `context:partial:side-effect-subject:${result.relation}`,
          null,
          Object.freeze([]),
          Object.freeze([...base.evidence, contextEvidence]),
          Object.freeze(["subject"]),
          base.concepts,
        ),
      );
      superseded.push(base.id);
      continue;
    }
    if (result?.type !== "query") continue;

    if (
      result.kind === "object-of" &&
      result.relation === "意思是"
    ) {
      candidates.push(
        queryWithResolvedSubject(
          extraction,
          base,
          result,
          result.subject,
          "explicit",
        ),
      );
      superseded.push(base.id);
      continue;
    }

    if (isSelfReference(result.subject)) {
      candidates.push(
        queryWithResolvedSubject(
          extraction,
          base,
          result,
          "Sunland AI · Beta",
          "explicit",
        ),
      );
      superseded.push(base.id);
      continue;
    }

    if (!isContextPronoun(result.subject)) continue;
    superseded.push(base.id);
    if (focus.kind === "unique") {
      candidates.push(
        queryWithResolvedSubject(
          extraction,
          base,
          result,
          focus.entities[0]!.value,
          "context",
        ),
      );
    } else {
      candidates.push(
        unresolvedPronounCandidate(
          extraction,
          base,
          result,
          focus,
        ),
      );
    }
  }

  return Object.freeze({
    candidates: Object.freeze(candidates),
    supersededCandidateIds: Object.freeze(superseded),
  });
}

function ellipsisSubject(
  extraction: SemanticExtraction,
  context: SemanticContext,
): EllipsisSubject | null {
  const surface = extraction.input.surface.toLocaleLowerCase("und");
  const match = /^(?:那\s*)?(.+?)\s*呢$/u.exec(
    surface,
  );
  if (match === null) return null;
  const matchedSubject = match[1]?.trim() ?? "";
  if (matchedSubject.length === 0) return null;

  const start = surface.indexOf(matchedSubject);
  const rawRange = mapNormalizedRangeToRaw(
    extraction.input,
    "surface",
    start,
    start + matchedSubject.length,
  );
  if (isSelfReference(matchedSubject)) {
    return Object.freeze({
      value: "Sunland AI · Beta",
      rawRange,
      source: "explicit",
      ambiguousEntities: Object.freeze([]),
    });
  }
  if (isContextPronoun(matchedSubject)) {
    const focus = contextFocus(context);
    if (focus.kind !== "unique") {
      return Object.freeze({
        value: "",
        rawRange,
        source: "context",
        ambiguousEntities: focus.entities,
      });
    }
    return Object.freeze({
      value: focus.entities[0]!.value,
      rawRange,
      source: "context",
      ambiguousEntities: Object.freeze([]),
    });
  }

  return Object.freeze({
    value: extraction.input.raw
      .slice(rawRange.start, rawRange.end)
      .trim()
      .replace(/\s+/gu, " "),
    rawRange,
    source: "explicit",
    ambiguousEntities: Object.freeze([]),
  });
}

function produceEllipsisCandidate(
  extraction: SemanticExtraction,
  context: SemanticContext,
): SemanticCandidate | null {
  const subjectMatch = ellipsisSubject(extraction, context);
  if (subjectMatch === null) return null;
  const relation = inheritedRelation(context);
  const subjectEvidence = feature(
    subjectMatch.value.length === 0
      ? "context:ambiguous-subject"
      : "context:ellipsis-subject",
    subjectMatch.value,
    SEMANTIC_SCORING.context.inheritedSubject,
    subjectMatch.rawRange,
  );

  if (subjectMatch.value.length === 0 || relation === null) {
    const missingSlots = Object.freeze([
      ...(subjectMatch.value.length === 0 ? ["subject"] : []),
      ...(relation === null ? ["relation"] : []),
    ]);
    const ambiguityEntities = subjectMatch.ambiguousEntities.map((entity) =>
      contextEntity(
        entity.kind === "self" ? "self" : "subject",
        entity.value,
        "",
        Object.freeze({ start: 0, end: 0 }),
        "context",
      ),
    );
    return candidate(
      `context:ellipsis:partial:${missingSlots.join("+")}`,
      null,
      Object.freeze(ambiguityEntities),
      Object.freeze([subjectEvidence]),
      missingSlots,
      Object.freeze([
        concept(
          "context-ellipsis",
          "context ellipsis",
          Object.freeze([subjectEvidence]),
        ),
      ]),
    );
  }

  const subject = contextEntity(
    isSelfReference(subjectMatch.value) ? "self" : "subject",
    isSelfReference(subjectMatch.value)
      ? "Sunland AI · Beta"
      : subjectMatch.value,
    extraction.input.raw.slice(
      subjectMatch.rawRange.start,
      subjectMatch.rawRange.end,
    ),
    subjectMatch.rawRange,
    subjectMatch.source,
  );
  const relationEvidence = feature(
    "context:inherited-relation",
    relation,
    SEMANTIC_SCORING.context.inheritedRelation,
  );
  const queryKind: QueryKind = relation === "在" ? "locate" : "object-of";
  const result: ParsedQuery = Object.freeze({
    type: "query",
    subject: subject.value,
    relation,
    kind: queryKind,
    raw: extraction.input.raw,
  });
  const evidence = Object.freeze([subjectEvidence, relationEvidence]);

  return candidate(
    `context:ellipsis:query:${subject.value}:${relation}`,
    result,
    Object.freeze([subject]),
    evidence,
    Object.freeze([]),
    Object.freeze([
      concept("context-ellipsis", "context ellipsis", evidence),
    ]),
  );
}

export function produceContextCandidates(
  extraction: SemanticExtraction,
  baseCandidates: readonly SemanticCandidate[],
  context: SemanticContext,
): ContextCandidateProduction {
  const relationQueries = contextualizeExplicitRelations(
    extraction,
    baseCandidates,
    context,
  );
  const ellipsis = produceEllipsisCandidate(extraction, context);
  const ellipsisSuperseded =
    ellipsis?.result?.type === "query"
      ? baseCandidates
          .filter(
            ({ producer, result }) =>
              producer === "legacy-regex" &&
              result?.type === "intent" &&
              result.intent === "Identity",
          )
          .map(({ id }) => id)
      : [];

  return Object.freeze({
    candidates: Object.freeze([
      ...relationQueries.candidates,
      ...(ellipsis === null ? [] : [ellipsis]),
    ]),
    supersededCandidateIds: Object.freeze([
      ...relationQueries.supersededCandidateIds,
      ...ellipsisSuperseded,
    ]),
  });
}
