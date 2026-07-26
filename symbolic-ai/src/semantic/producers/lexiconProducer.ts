import type { IntentName, ParsedIntent } from "@/types";
import {
  scoreFromParts,
  SEMANTIC_SCORING,
} from "../scoring";
import type {
  CandidateSideEffect,
  MatchedFeature,
  SemanticCandidate,
  SemanticConcept,
  SemanticEntity,
  SemanticExtraction,
} from "../types";

const CONCEPT_INTENTS: Readonly<
  Record<
    string,
    {
      readonly intent: IntentName;
      readonly sideEffect: CandidateSideEffect;
    }
  >
> = Object.freeze({
  greeting: Object.freeze({ intent: "Greeting", sideEffect: "none" }),
  thanks: Object.freeze({ intent: "Thanks", sideEffect: "none" }),
  goodbye: Object.freeze({ intent: "Farewell", sideEffect: "none" }),
  "identity-name": Object.freeze({
    intent: "Identity",
    sideEffect: "none",
  }),
  "identity-self": Object.freeze({
    intent: "Identity",
    sideEffect: "none",
  }),
  "remember-name": Object.freeze({
    intent: "RememberName",
    sideEffect: "memory-write",
  }),
  "recall-name": Object.freeze({
    intent: "RecallName",
    sideEffect: "none",
  }),
});

function firstEvidence(concept: SemanticConcept): MatchedFeature | null {
  return concept.evidence[0] ?? null;
}

function findNameForConcept(
  concept: SemanticConcept,
  extraction: SemanticExtraction,
): SemanticEntity | null {
  const conceptEnd = firstEvidence(concept)?.rawRange?.end ?? 0;
  return (
    [...extraction.personNames]
      .filter((entity) => entity.start >= conceptEnd)
      .sort(
        (left, right) =>
          left.start - right.start || left.end - right.end,
      )[0] ?? null
  );
}

function hasNegationBetween(
  concept: SemanticConcept,
  entity: SemanticEntity,
  extraction: SemanticExtraction,
): boolean {
  const conceptStart = firstEvidence(concept)?.rawRange?.start ?? 0;
  return extraction.negationCues.some((cue) => {
    const range = cue.rawRange;
    return (
      range !== undefined &&
      range.start >= conceptStart &&
      range.end <= entity.end
    );
  });
}

function identityEntities(
  extraction: SemanticExtraction,
): readonly string[] {
  const subject =
    extraction.selfReferences[0]?.value ?? "Sunland AI · Beta";
  return Object.freeze([subject, "identity"]);
}

function createIntentResult(
  intent: IntentName,
  entities: readonly string[],
  confidence: number,
  raw: string,
): ParsedIntent {
  return Object.freeze({
    type: "intent",
    intent,
    entities: Object.freeze([...entities]),
    confidence,
    raw,
  });
}

function createCandidate(
  concept: SemanticConcept,
  extraction: SemanticExtraction,
): SemanticCandidate | null {
  const configuration = CONCEPT_INTENTS[concept.id];
  if (configuration === undefined) {
    return null;
  }

  let entities: readonly SemanticEntity[] = Object.freeze([]);
  let resultEntities: readonly string[] = Object.freeze([]);

  if (configuration.intent === "Identity") {
    entities = extraction.selfReferences;
    resultEntities = identityEntities(extraction);
  }

  if (configuration.intent === "RememberName") {
    const name = findNameForConcept(concept, extraction);
    if (
      name === null ||
      hasNegationBetween(concept, name, extraction)
    ) {
      return null;
    }
    entities = Object.freeze([name]);
    resultEntities = Object.freeze([name.value]);
  }

  const additions =
    entities.length > 0
      ? [SEMANTIC_SCORING.lexicon.entityCompleteBonus]
      : [];
  const deductions =
    configuration.sideEffect === "none"
      ? []
      : [SEMANTIC_SCORING.lexicon.sideEffectPenalty];
  const confidence = scoreFromParts(
    concept.confidence,
    additions,
    deductions,
  );
  const result = createIntentResult(
    configuration.intent,
    resultEntities,
    confidence,
    extraction.input.raw,
  );
  const evidence = Object.freeze([
    ...concept.evidence,
    ...entities.map((entity) =>
      Object.freeze({
        kind: "entity-pattern" as const,
        key: `entity:${entity.kind}`,
        value: entity.value,
        rawRange: Object.freeze({
          start: entity.start,
          end: entity.end,
        }),
        weight: entity.confidence,
      }),
    ),
  ]);

  return Object.freeze({
    id: `lexicon:intent:${configuration.intent}:${resultEntities.join("|")}`,
    producer: "lexicon",
    producerWeight: SEMANTIC_SCORING.producerWeight.lexicon,
    result,
    concepts: Object.freeze([concept]),
    entities,
    confidence,
    evidence,
    missingSlots: Object.freeze([]),
    sideEffect: configuration.sideEffect,
  });
}

export function produceLexiconCandidates(
  extraction: SemanticExtraction,
): readonly SemanticCandidate[] {
  const hasExplicitRecallName = extraction.concepts.some(
    ({ id }) => id === "recall-name",
  );
  return Object.freeze(
    extraction.concepts
      .filter(
        ({ id }) =>
          !(hasExplicitRecallName && id === "remember-name"),
      )
      .map((concept) => createCandidate(concept, extraction))
      .filter(
        (candidate): candidate is SemanticCandidate => candidate !== null,
      ),
  );
}
