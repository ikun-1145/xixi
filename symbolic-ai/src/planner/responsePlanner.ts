/**
 * `defaultResponsePlanner` — Sunland AI's first Response Planner (Stage 7).
 *
 * Pipeline position: Reasoner -> **Response Planner** -> Personality. Reads
 * only a `ReasoningResult` (Answer + Confidence + Evidence, already fully
 * computed by a `Reasoner`) and decides the answer STRATEGY — never the
 * wording. See `types/planner.ts` for the full contract/rationale.
 *
 * v1 supports exactly three strategies, per the explicit initial scope:
 *   1. Normal answer — state the fact(s) plainly (`mode: "direct"`).
 *   2. Auto-explain — when the user's query explicitly asked "why"
 *      (`ParsedQuery.explain`, e.g. "猫为什么属于生物"), surface the
 *      derivation chain too (`mode: "explained"`, `showEvidence: true`).
 *   3. Natural uncertainty — when the best answer's confidence is below
 *      `UNCERTAINTY_THRESHOLD`, flag `isUncertain: true` so Personality can
 *      hedge, independently of which mode was chosen.
 * Not implemented yet (reserved for later, per the user's own "不需要一次
 * 实现复杂策略"): follow-up questions, answer simplification for long
 * results, multi-answer prioritization beyond simple concatenation.
 *
 * Deliberately does NOT reuse the Reasoner's own `ReasoningResult.explanation`
 * for the "direct"/"explained" cases (only for "no-answer", where the
 * Reasoner's neutral fallback text is exactly what's needed) — formatting
 * whether to include the derivation chain is this module's decision to own,
 * not something to inherit pre-baked from a specific Reasoner implementation.
 */
import type { Inference, ReasoningResult, ResponsePlan, ResponsePlanner } from "@/types";

/**
 * Below this, an answer is treated as uncertain enough to hedge. A simple,
 * tunable placeholder for v1 — not a claim about the "correct" cutoff.
 */
const UNCERTAINTY_THRESHOLD = 0.75;

function describeBare(answer: Inference): string {
  const { subject, relation, object, negated } = answer.conclusion;
  const negation = negated ? "不" : "";
  return `${subject} ${negation}${relation} ${object}`;
}

function describeWithEvidence(answer: Inference): string {
  const bare = describeBare(answer);
  if (answer.steps.length === 0) return bare; // directly-known fact, nothing to derive
  return `${bare}（推理路径：${answer.path.join(" → ")}）`;
}

/** The lowest confidence among the answers -- one weak link is enough to hedge. */
function representativeConfidence(answers: readonly Inference[]): number {
  return Math.min(...answers.map((answer) => answer.confidence));
}

export const defaultResponsePlanner: ResponsePlanner = {
  id: "default-v1",

  plan(result: ReasoningResult): ResponsePlan {
    const { answers, query } = result;

    if (answers.length === 0) {
      return {
        mode: "no-answer",
        showEvidence: false,
        isUncertain: false,
        confidence: 0,
        explanation: result.explanation,
      };
    }

    const wantsExplanation = query.explain === true;
    const confidence = representativeConfidence(answers);

    return {
      mode: wantsExplanation ? "explained" : "direct",
      showEvidence: wantsExplanation,
      isUncertain: confidence < UNCERTAINTY_THRESHOLD,
      confidence,
      explanation: (wantsExplanation ? answers.map(describeWithEvidence) : answers.map(describeBare)).join("；"),
    };
  },
};
