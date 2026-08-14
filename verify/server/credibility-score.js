import { countIndependentSources } from "./source-evaluator.js";

const GRADE_WEIGHT = Object.freeze({ A: 4, B: 3, C: 2, D: 1 });

function evidenceQuality(items) {
  return (items || []).reduce((sum, item) => (
    sum + (GRADE_WEIGHT[item?.sourceEvaluation?.grade] || 0)
  ), 0);
}

export function scoreLabel(score) {
  if (score >= 80) return "较高可信度";
  if (score >= 60) return "偏可信";
  if (score >= 40) return "证据不足";
  if (score >= 20) return "偏不可信";
  return "较低可信度";
}

export function calculateCredibilityScore(judgment) {
  const confidence = Math.min(1, Math.max(0, Number(judgment?.confidence) || 0));
  let score;
  switch (judgment?.verdict) {
    case "true": score = 75 + confidence * 12; break;
    case "likely_true": score = 60 + confidence * 12; break;
    case "likely_false": score = 40 - confidence * 12; break;
    case "false": score = 25 - confidence * 12; break;
    default: score = 50;
  }

  const supporting = judgment?.supporting_evidence || [];
  const contradicting = judgment?.contradicting_evidence || [];
  score += Math.min(8, evidenceQuality(supporting) * 0.8);
  score -= Math.min(8, evidenceQuality(contradicting) * 0.8);
  score += Math.min(4, Math.max(0, countIndependentSources(supporting) - 1) * 1.5);
  score -= Math.min(4, Math.max(0, countIndependentSources(contradicting) - 1) * 1.5);
  if (judgment?.originalSourceFound) {
    score += ["true", "likely_true"].includes(judgment.verdict) ? 4
      : ["false", "likely_false"].includes(judgment.verdict) ? -4 : 0;
  }
  if (judgment?.independence === "syndicated") {
    if (["likely_true", "true"].includes(judgment.verdict)) score -= 3;
    if (["likely_false", "false"].includes(judgment.verdict)) score += 3;
  }
  const positiveVerdict = ["likely_true", "true"].includes(judgment?.verdict);
  const negativeVerdict = ["likely_false", "false"].includes(judgment?.verdict);
  if (judgment?.timeliness === "stale") score += positiveVerdict ? -3 : negativeVerdict ? 3 : 0;
  if (judgment?.timeliness === "current") score += positiveVerdict ? 2 : negativeVerdict ? -2 : 0;

  // 进入最高/最低区间需要强来源或多个独立来源，不能只依赖 LLM 自报 confidence。
  const decisiveEvidence = positiveVerdict ? supporting : negativeVerdict ? contradicting : [];
  const decisiveGrades = decisiveEvidence.map(item => item?.sourceEvaluation?.grade);
  const hasGradeA = decisiveGrades.includes("A");
  const hasStrongSource = decisiveGrades.some(grade => grade === "A" || grade === "B");
  const independentDecisiveSources = countIndependentSources(decisiveEvidence);
  const hasStrongIndependentChain = hasStrongSource && independentDecisiveSources >= 2;
  if (positiveVerdict && !hasGradeA && !hasStrongIndependentChain) {
    score = Math.min(score, hasStrongSource ? 79 : 69);
  }
  if (negativeVerdict && !hasGradeA && !hasStrongIndependentChain) {
    score = Math.max(score, hasStrongSource ? 21 : 31);
  }

  const rounded = Math.round(Math.min(95, Math.max(5, score)));
  return { score: rounded, label: scoreLabel(rounded) };
}

export function calculateOverallScore(claims) {
  if (!Array.isArray(claims) || claims.length === 0) return null;
  const totalWeight = claims.reduce((sum, claim) => sum + (0.5 + (claim.confidence || 0)), 0);
  const weighted = claims.reduce((sum, claim) => (
    sum + claim.credibilityScore * (0.5 + (claim.confidence || 0))
  ), 0);
  return Math.round(weighted / totalWeight);
}
