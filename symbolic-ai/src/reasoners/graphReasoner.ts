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
  ParsedQuery,
  Reasoner,
  ReasoningResult,
} from "@/types";
import { CoreRelations } from "@/types";
import { isaTransitivityRule } from "@/rules";

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

  return isaTransitivityRule
    .apply(known)
    .filter(
      (inference) =>
        inference.conclusion.subject === query.subject &&
        (query.object === undefined || inference.conclusion.object === query.object),
    );
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

export const graphReasoner: Reasoner = {
  id: REASONER_ID,

  answer(query: ParsedQuery, known: KnowledgeQuery): ReasoningResult {
    const direct = directAnswers(query, known);
    const knownObjects = new Set(direct.map((answer) => answer.conclusion.object));
    const derived = derivedIsAAnswers(query, known).filter((answer) => !knownObjects.has(answer.conclusion.object));

    const answers = [...direct, ...derived];
    const explanation =
      answers.length > 0 ? answers.map(describeAnswer).join("；") : NO_KNOWN_FACTS_EXPLANATION;

    return { query, answers, conflicts: [], explanation };
  },

  materialize(known: KnowledgeQuery): readonly Inference[] {
    // Full forward-closure of currently-derivable (multi-hop, i.e. genuinely
    // inferred rather than directly-known) 属于 facts -- the only rule active
    // at this stage. More rules registered later (see `@/rules`) would be
    // included here too without this function changing.
    return isaTransitivityRule.apply(known);
  },
};
