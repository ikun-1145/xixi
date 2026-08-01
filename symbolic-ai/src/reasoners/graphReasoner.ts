/**
 * Sunland AI's first real `Reasoner` (Stage 6 — Knowledge Graph v1).
 *
 * Pipeline position: Parser -> Knowledge -> **Reasoner** -> Response Planner
 * -> Personality -> Output. This module only ever reads `KnowledgeQuery`
 * (never mutates a store) and produces a fully-explainable `ReasoningResult`
 * — it never decides tone or phrasing (that is Personality's job, via the
 * Response Planner glue in `engine/sunlandEngine.ts`).
 *
 * Two sources of answers, combined:
 *   1. Direct facts already in the store (works for every relation, exactly
 *      like the old `answerQuery` MVP it replaces).
 *   2. For `CoreRelations.IsA` ("属于") specifically, multi-hop inferences
 *      from `isaTransitivityRule` (see `@/rules`) — real graph search, not
 *      just a lookup. Every other relation (会/喜欢/在/是) still only ever
 *      gets direct-fact answers; broadening transitivity to more relations
 *      is explicitly out of scope for this stage.
 * Direct facts and derived inferences for the same object are de-duplicated
 * (a fact directly known is never ALSO reported as "derived").
 */
import type {
  Inference,
  KnowledgeQuery,
  KnowledgeRecord,
  ParsedQuery,
  Reasoner,
  ReasoningResult,
} from "@/types";
import { CoreRelations } from "@/types";
import {
  isaTransitivityRule,
  traverseIsAForQuery,
} from "@/rules";
import {
  createRelationResolutionEvidence,
  relationResolutionPolicy,
  type RelationResolutionEvidence,
  type RelationResolutionOptions,
  type RelationResolutionPolicy,
} from "./relationResolution";

const REASONER_ID = "graph-v1";
const NO_KNOWN_FACTS_EXPLANATION = "目前还没有已知的相关事实。";

/** Direct, already-known facts matching the query pattern (any relation). */
function directAnswers(query: ParsedQuery, known: KnowledgeQuery): readonly Inference[] {
  const matches = known.match({
    subject: query.subject,
    relation: query.relation,
    ...(query.object !== undefined ? { object: query.object } : {}),
  });

  return matches.map((record) => ({
    conclusion: { subject: record.subject, relation: record.relation, object: record.object, negated: record.negated },
    confidence: record.confidence,
    steps: [],
    path: [record.subject, record.object],
  }));
}

/**
 * Multi-hop 属于 inferences relevant to this query -- only ever consulted
 * when the query itself is about 属于; irrelevant/derived-for-other-subjects
 * inferences are filtered out here so callers only see what they asked
 * about.
 */
function derivedIsAAnswers(query: ParsedQuery, known: KnowledgeQuery): readonly Inference[] {
  if (query.relation !== CoreRelations.IsA) return [];

  return traverseIsAForQuery(known, {
    subject: query.subject,
    ...(query.object === undefined
      ? {}
      : { targetObject: query.object }),
  });
}

/** Narrate one answer, including its full derivation path when it has one. */
function describeAnswer(answer: Inference): string {
  const { subject, relation, object, negated } = answer.conclusion;
  const negation = negated ? "不" : "";
  if (answer.steps.length === 0) {
    return `${subject} ${negation}${relation} ${object}`;
  }
  return `${subject} ${negation}${relation} ${object}（推理路径：${answer.path.join(" → ")}）`;
}

function reasoningResult(
  query: ParsedQuery,
  answers: readonly Inference[],
): ReasoningResult {
  const explanation =
    answers.length > 0
      ? answers.map(describeAnswer).join("；")
      : NO_KNOWN_FACTS_EXPLANATION;

  return {
    query,
    answers,
    conflicts: [],
    explanation,
  };
}

function answerExact(
  query: ParsedQuery,
  known: KnowledgeQuery,
): ReasoningResult {
  const direct = directAnswers(query, known);
  if (query.object !== undefined && direct.length > 0) {
    return reasoningResult(query, direct);
  }
  const knownObjects = new Set(
    direct.map((answer) => answer.conclusion.object),
  );
  const derived = derivedIsAAnswers(query, known).filter(
    (answer) => !knownObjects.has(answer.conclusion.object),
  );

  return reasoningResult(query, [...direct, ...derived]);
}

function legacyClassificationObject(
  record: KnowledgeRecord,
): string | null {
  if (record.negated || !record.object.startsWith("一种")) {
    return null;
  }
  const object = record.object.slice("一种".length).trim();
  return object.length > 0 ? object : null;
}

function legacyClassificationAnswers(
  query: ParsedQuery,
  known: KnowledgeQuery,
): readonly Inference[] {
  const answers: Inference[] = [];
  for (const record of known.match({
    subject: query.subject,
    relation: CoreRelations.Is,
    negated: false,
  })) {
    const object = legacyClassificationObject(record);
    if (object !== null) {
      answers.push({
        conclusion: {
          subject: record.subject,
          relation: CoreRelations.IsA,
          object,
          negated: false,
        },
        confidence: record.confidence,
        steps: [],
        path: [record.subject, object],
      });
    }
  }
  return answers;
}

export interface RelationResolvedReasoningResult {
  readonly result: ReasoningResult;
  /**
   * Internal query-resolution evidence. Engine observation may inspect it,
   * but it is deliberately kept outside `ReasoningResult`, so Personality
   * never receives these implementation fields.
   */
  readonly relationResolution: RelationResolutionEvidence;
}

export function answerGraphQuery(
  query: ParsedQuery,
  known: KnowledgeQuery,
  options: RelationResolutionOptions = {},
  policy: RelationResolutionPolicy = relationResolutionPolicy,
): RelationResolvedReasoningResult {
  const exact = answerExact(query, known);
  if (exact.answers.length > 0) {
    return Object.freeze({
      result: exact,
      relationResolution: createRelationResolutionEvidence(
        "exact",
        query.relation,
        query.relation,
        policy,
      ),
    });
  }

  const fallback = policy.fallbackFor(query, options);
  if (fallback === null) {
    return Object.freeze({
      result: exact,
      relationResolution: createRelationResolutionEvidence(
        "exact",
        query.relation,
        query.relation,
        policy,
      ),
    });
  }

  const answers = fallback.legacyClassificationOnly
    ? legacyClassificationAnswers(query, known)
    : answerExact(
        {
          ...query,
          relation: fallback.matchedRelation,
        },
        known,
      ).answers;

  return Object.freeze({
    result: reasoningResult(query, answers),
    relationResolution: createRelationResolutionEvidence(
      "fallback",
      query.relation,
      fallback.matchedRelation,
      policy,
    ),
  });
}

export const graphReasoner: Reasoner = {
  id: REASONER_ID,

  answer(query: ParsedQuery, known: KnowledgeQuery): ReasoningResult {
    return answerGraphQuery(query, known).result;
  },

  materialize(known: KnowledgeQuery): readonly Inference[] {
    // Full forward-closure of currently-derivable (multi-hop, i.e. genuinely
    // inferred rather than directly-known) 属于 facts -- the only rule active
    // at this stage. More rules registered later (see `@/rules`) would be
    // included here too without this function changing.
    return isaTransitivityRule.apply(known);
  },
};
