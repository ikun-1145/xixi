/**
 * Shared mock builders for personality unit tests.
 *
 * Not re-exported from index.ts — this exists purely to avoid duplicating
 * fixture objects across frost.test.ts / plain.test.ts / boundary.test.ts.
 * Every builder accepts `overrides` so individual tests can tweak only the
 * field(s) relevant to what they're checking.
 */
import type {
  Inference,
  KnowledgeRecord,
  ParseFailure,
  ParsedQuery,
  ReasoningResult,
  ResponsePlan,
} from "@/types";

export function makeQuery(overrides: Partial<ParsedQuery> = {}): ParsedQuery {
  return {
    type: "query",
    subject: "猫",
    relation: "属于",
    kind: "object-of",
    raw: "猫属于什么",
    ...overrides,
  };
}

export function makeInference(overrides: Partial<Inference> = {}): Inference {
  return {
    conclusion: { subject: "猫", relation: "属于", object: "哺乳动物", negated: false },
    confidence: 1,
    steps: [],
    path: ["猫", "哺乳动物"],
    ...overrides,
  };
}

export function makeReasoningResult(overrides: Partial<ReasoningResult> = {}): ReasoningResult {
  return {
    query: makeQuery(),
    answers: [makeInference()],
    conflicts: [],
    explanation: "猫 属于 哺乳动物（直接已知事实）。",
    ...overrides,
  };
}

export function makeNoAnswerResult(overrides: Partial<ReasoningResult> = {}): ReasoningResult {
  return makeReasoningResult({
    answers: [],
    explanation: "没有找到与「猫 属于 ?」匹配的已知事实。",
    ...overrides,
  });
}

/**
 * A `ResponsePlan` fixture, independent of `makeReasoningResult` (Stage 7 —
 * Response Planner sits between Reasoner and Personality; tests targeting
 * Personality construct the plan directly, exactly like every other
 * pre-decided field this module hands Personality).
 */
export function makePlan(overrides: Partial<ResponsePlan> = {}): ResponsePlan {
  return {
    mode: "direct",
    showEvidence: false,
    isUncertain: false,
    confidence: 1,
    explanation: "猫 属于 哺乳动物（直接已知事实）。",
    ...overrides,
  };
}

/** A plan matching `makeNoAnswerResult()`'s shape. */
export function makeNoAnswerPlan(overrides: Partial<ResponsePlan> = {}): ResponsePlan {
  return makePlan({
    mode: "no-answer",
    confidence: 0,
    explanation: "没有找到与「猫 属于 ?」匹配的已知事实。",
    ...overrides,
  });
}

export function makeLearnedRecord(overrides: Partial<KnowledgeRecord> = {}): KnowledgeRecord {
  return {
    id: "rec-1",
    subject: "苹果",
    relation: "属于",
    object: "水果",
    negated: false,
    confidence: 1,
    source: "user",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

export function makeParseFailure(overrides: Partial<ParseFailure> = {}): ParseFailure {
  return {
    type: "unknown",
    raw: "哈哈哈哈哈",
    reason: '没有匹配的语法规则："哈哈哈哈哈"',
    ...overrides,
  };
}
