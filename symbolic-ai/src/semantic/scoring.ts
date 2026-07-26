import {
  createConfidence,
  type CandidateProducer,
  type Confidence,
} from "./types";

const confidence = createConfidence;

/**
 * Stage 8.3 scoring policy. Keeping every weight here makes candidate scores
 * reviewable without hunting through extraction and producer code.
 */
export const SEMANTIC_SCORING = Object.freeze({
  producerWeight: Object.freeze({
    "legacy-regex": confidence(0.9),
    lexicon: confidence(0.8),
    "relation-pattern": confidence(0.72),
    context: confidence(0.64),
  } satisfies Readonly<Record<CandidateProducer, Confidence>>),
  legacy: Object.freeze({
    unknown: confidence(0.08),
    statement: confidence(0.91),
    query: confidence(0.92),
    intentFloor: confidence(0.88),
  }),
  lexicon: Object.freeze({
    aliasWeightShare: confidence(0.82),
    coverageWeightShare: confidence(0.18),
    exactInputBonus: confidence(0.04),
    entityCompleteBonus: confidence(0.08),
    sideEffectPenalty: confidence(0.03),
  }),
  relation: Object.freeze({
    base: confidence(0.48),
    conceptWeightShare: confidence(0.2),
    subjectBonus: confidence(0.12),
    objectBonus: confidence(0.12),
    queryShapeBonus: confidence(0.12),
    statementShapeBonus: confidence(0.14),
    missingSlotPenalty: confidence(0.16),
    sideEffectPenalty: confidence(0.05),
    weakSingleCharacterPenalty: confidence(0.08),
  }),
  context: Object.freeze({
    resolvedQuery: confidence(0.86),
    unresolvedReference: confidence(0.48),
    inheritedSubject: confidence(0.14),
    inheritedRelation: confidence(0.12),
  }),
  feature: Object.freeze({
    directSelf: confidence(0.9),
    indirectSelf: confidence(0.7),
    explicitName: confidence(0.94),
    questionCue: confidence(0.75),
    negationCue: confidence(0.9),
    structuralTeaching: confidence(0.68),
    definitionQuery: confidence(0.84),
  }),
  producerTieBreak: Object.freeze({
    "legacy-regex": 0,
    lexicon: 1,
    "relation-pattern": 2,
    context: 3,
  } satisfies Readonly<Record<CandidateProducer, number>>),
});

export function clampConfidence(value: number): Confidence {
  return createConfidence(Math.min(1, Math.max(0, value)));
}

export function scoreFromParts(
  base: number,
  additions: readonly number[] = [],
  deductions: readonly number[] = [],
): Confidence {
  const added = additions.reduce((sum, value) => sum + value, 0);
  const deducted = deductions.reduce((sum, value) => sum + value, 0);
  return clampConfidence(base + added - deducted);
}

export function scoreLexiconAlias(
  baseWeight: Confidence,
  alias: string,
  matchKey: string,
  exactInput: boolean,
): Confidence {
  const coverage =
    matchKey.length === 0 ? 0 : Math.min(1, alias.length / matchKey.length);
  const base =
    baseWeight * SEMANTIC_SCORING.lexicon.aliasWeightShare +
    coverage * SEMANTIC_SCORING.lexicon.coverageWeightShare;

  return scoreFromParts(
    base,
    exactInput ? [SEMANTIC_SCORING.lexicon.exactInputBonus] : [],
  );
}
