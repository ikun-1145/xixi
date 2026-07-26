import {
  SEMANTIC_LEXICON,
  type SemanticLexiconEntry,
} from "./lexicon";
import { mapNormalizedRangeToRaw } from "./normalize";
import {
  scoreLexiconAlias,
  SEMANTIC_SCORING,
} from "./scoring";
import {
  createConfidence,
  type MatchedFeature,
  type MatchedFeatureKind,
  type NormalizedSemanticInput,
  type RawTextRange,
  type SemanticConcept,
  type SemanticEntity,
  type SemanticExtraction,
  type SemanticRelationMention,
} from "./types";

interface LexiconOccurrence {
  readonly entry: SemanticLexiconEntry;
  readonly alias: string;
  readonly start: number;
  readonly end: number;
  readonly rawRange: RawTextRange;
  readonly feature: MatchedFeature;
  readonly concept: SemanticConcept;
}

interface CueDefinition {
  readonly value: string;
  readonly kind: MatchedFeatureKind;
  readonly key: string;
}

const QUESTION_CUES: readonly CueDefinition[] = Object.freeze(
  [
    "为什么",
    "有没有",
    "是不是",
    "会不会",
    "还是",
    "什么",
    "啥",
    "谁",
    "哪里",
    "哪",
    "怎么",
    "吗",
    "?",
  ].map(
    (value) =>
      Object.freeze({
        value,
        kind: "question-cue" as const,
        key: `question:${value}`,
      }),
  ),
);

const NEGATION_CUES: readonly CueDefinition[] = Object.freeze(
  ["不是", "不会", "不能", "没有", "不", "没", "别"].map((value) =>
    Object.freeze({
      value,
      kind: "negation-cue" as const,
      key: `negation:${value}`,
    }),
  ),
);

const SELF_REFERENCES = Object.freeze([
  Object.freeze({
    value: "sunland ai",
    canonical: "Sunland AI · Beta",
    confidence: SEMANTIC_SCORING.feature.directSelf,
  }),
  Object.freeze({
    value: "你",
    canonical: "Sunland AI · Beta",
    confidence: SEMANTIC_SCORING.feature.directSelf,
  }),
  Object.freeze({
    value: "霜蓝",
    canonical: "霜蓝",
    confidence: SEMANTIC_SCORING.feature.indirectSelf,
  }),
]);

const RELATION_CONCEPT_IDS = new Set(["is-a", "can", "has", "means"]);
const NAME_REJECT_VALUES = new Set(["什么", "什么名字", "谁", "吗"]);
const ASCII_WORD_CHARACTER = /[a-z0-9]/iu;
const ENTITY_EDGE_CHARACTER = /[\s,.;:!?'"()[\]~]/u;

function freezeRange(start: number, end: number): RawTextRange {
  return Object.freeze({ start, end });
}

function makeFeature(
  kind: MatchedFeatureKind,
  key: string,
  value: string,
  rawRange: RawTextRange,
  weight: ReturnType<typeof createConfidence>,
): MatchedFeature {
  return Object.freeze({
    kind,
    key,
    value,
    rawRange: Object.freeze({ ...rawRange }),
    weight,
  });
}

function isAsciiBoundary(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) {
    return true;
  }
  return !ASCII_WORD_CHARACTER.test(text[index]!);
}

function aliasHasValidBoundaries(
  text: string,
  alias: string,
  start: number,
  end: number,
): boolean {
  const first = alias[0];
  const last = alias[alias.length - 1];
  const beforeIsValid =
    first === undefined ||
    !ASCII_WORD_CHARACTER.test(first) ||
    isAsciiBoundary(text, start - 1);
  const afterIsValid =
    last === undefined ||
    !ASCII_WORD_CHARACTER.test(last) ||
    isAsciiBoundary(text, end);

  return beforeIsValid && afterIsValid;
}

function rangesOverlap(
  left: Pick<LexiconOccurrence, "start" | "end">,
  right: Pick<LexiconOccurrence, "start" | "end">,
): boolean {
  return left.start < right.end && right.start < left.end;
}

function findLexiconOccurrences(
  input: NormalizedSemanticInput,
): readonly LexiconOccurrence[] {
  const matches: LexiconOccurrence[] = [];

  for (const entry of SEMANTIC_LEXICON) {
    const entryMatches: LexiconOccurrence[] = [];
    const aliases = [...entry.aliases].sort(
      (left, right) =>
        right.length - left.length || left.localeCompare(right),
    );

    for (const originalAlias of aliases) {
      const alias = originalAlias
        .trim()
        .replace(/\s+/gu, " ")
        .toLocaleLowerCase("und");
      let searchFrom = 0;

      while (alias.length > 0) {
        const start = input.matchKey.indexOf(alias, searchFrom);
        if (start < 0) {
          break;
        }
        const end = start + alias.length;
        searchFrom = start + 1;

        if (!aliasHasValidBoundaries(input.matchKey, alias, start, end)) {
          continue;
        }

        const rawRange = mapNormalizedRangeToRaw(
          input,
          "matchKey",
          start,
          end,
        );
        const weight = scoreLexiconAlias(
          entry.baseWeight,
          alias,
          input.matchKey,
          input.matchKey === alias,
        );
        const feature = makeFeature(
          "lexicon-alias",
          entry.id,
          originalAlias,
          rawRange,
          weight,
        );
        const concept: SemanticConcept = Object.freeze({
          id: entry.id,
          canonical: entry.canonical,
          matchedAlias: originalAlias,
          confidence: weight,
          evidence: Object.freeze([feature]),
        });

        entryMatches.push(
          Object.freeze({
            entry,
            alias: originalAlias,
            start,
            end,
            rawRange,
            feature,
            concept,
          }),
        );
      }
    }

    entryMatches.sort(
      (left, right) =>
        left.start - right.start ||
        right.end - right.start - (left.end - left.start) ||
        left.alias.localeCompare(right.alias),
    );

    const selected: LexiconOccurrence[] = [];
    for (const match of entryMatches) {
      if (!selected.some((existing) => rangesOverlap(existing, match))) {
        selected.push(match);
      }
    }
    matches.push(...selected);
  }

  return Object.freeze(
    matches.sort(
      (left, right) =>
        left.start - right.start ||
        left.end - right.end ||
        left.entry.id.localeCompare(right.entry.id),
    ),
  );
}

function collectCues(
  input: NormalizedSemanticInput,
  definitions: readonly CueDefinition[],
  weight: ReturnType<typeof createConfidence>,
): readonly MatchedFeature[] {
  const matches: Array<{
    readonly start: number;
    readonly end: number;
    readonly feature: MatchedFeature;
  }> = [];
  const ordered = [...definitions].sort(
    (left, right) => right.value.length - left.value.length,
  );

  for (const definition of ordered) {
    let searchFrom = 0;
    while (definition.value.length > 0) {
      const start = input.matchKey.indexOf(definition.value, searchFrom);
      if (start < 0) {
        break;
      }
      const end = start + definition.value.length;
      searchFrom = start + 1;

      if (
        matches.some(
          (match) => start < match.end && match.start < end,
        )
      ) {
        continue;
      }

      const rawRange = mapNormalizedRangeToRaw(
        input,
        "matchKey",
        start,
        end,
      );
      matches.push(
        Object.freeze({
          start,
          end,
          feature: makeFeature(
            definition.kind,
            definition.key,
            definition.value,
            rawRange,
            weight,
          ),
        }),
      );
    }
  }

  return Object.freeze(
    matches
      .sort(
        (left, right) =>
          left.start - right.start || left.end - right.end,
      )
      .map((match) => match.feature),
  );
}

function trimEntityRange(
  text: string,
  start: number,
  end: number,
): RawTextRange {
  let trimmedStart = start;
  let trimmedEnd = end;

  while (
    trimmedStart < trimmedEnd &&
    ENTITY_EDGE_CHARACTER.test(text[trimmedStart]!)
  ) {
    trimmedStart += 1;
  }
  while (
    trimmedEnd > trimmedStart &&
    ENTITY_EDGE_CHARACTER.test(text[trimmedEnd - 1]!)
  ) {
    trimmedEnd -= 1;
  }

  return freezeRange(trimmedStart, trimmedEnd);
}

function createEntityFromMatchKey(
  input: NormalizedSemanticInput,
  kind: SemanticEntity["kind"],
  value: string,
  start: number,
  end: number,
  confidence: ReturnType<typeof createConfidence>,
): SemanticEntity {
  const rawRange = mapNormalizedRangeToRaw(
    input,
    "matchKey",
    start,
    end,
  );
  return Object.freeze({
    kind,
    value,
    rawText: input.raw.slice(rawRange.start, rawRange.end),
    start: rawRange.start,
    end: rawRange.end,
    source: "explicit",
    confidence,
  });
}

function extractSelfReferences(
  input: NormalizedSemanticInput,
): readonly SemanticEntity[] {
  const entities: SemanticEntity[] = [];

  for (const reference of SELF_REFERENCES) {
    let searchFrom = 0;
    while (reference.value.length > 0) {
      const start = input.matchKey.indexOf(reference.value, searchFrom);
      if (start < 0) {
        break;
      }
      const end = start + reference.value.length;
      searchFrom = end;

      if (
        !aliasHasValidBoundaries(
          input.matchKey,
          reference.value,
          start,
          end,
        )
      ) {
        continue;
      }

      entities.push(
        createEntityFromMatchKey(
          input,
          "self",
          reference.canonical,
          start,
          end,
          reference.confidence,
        ),
      );
    }
  }

  return Object.freeze(entities);
}

function extractPersonNames(
  input: NormalizedSemanticInput,
  occurrences: readonly LexiconOccurrence[],
): readonly SemanticEntity[] {
  const names: SemanticEntity[] = [];

  for (const occurrence of occurrences) {
    if (occurrence.entry.id !== "remember-name") {
      continue;
    }

    let start = occurrence.end;
    let end = input.matchKey.length;
    while (
      start < end &&
      ENTITY_EDGE_CHARACTER.test(input.matchKey[start]!)
    ) {
      start += 1;
    }

    const sentenceEnd = input.matchKey.slice(start).search(/[,;!?]/u);
    if (sentenceEnd >= 0) {
      end = start + sentenceEnd;
    }

    const trimmed = trimEntityRange(input.matchKey, start, end);
    if (trimmed.start >= trimmed.end) {
      continue;
    }

    const rawRange = mapNormalizedRangeToRaw(
      input,
      "matchKey",
      trimmed.start,
      trimmed.end,
    );
    const value = input.raw
      .slice(rawRange.start, rawRange.end)
      .trim()
      .replace(/\s+/gu, " ");
    const normalizedValue = value.toLocaleLowerCase("und");
    if (
      value.length === 0 ||
      NAME_REJECT_VALUES.has(normalizedValue) ||
      /^(?:不|没|别)/u.test(normalizedValue)
    ) {
      continue;
    }

    names.push(
      createEntityFromMatchKey(
        input,
        "person-name",
        value,
        trimmed.start,
        trimmed.end,
        SEMANTIC_SCORING.feature.explicitName,
      ),
    );
  }

  return Object.freeze(
    names.filter(
      (name, index) =>
        names.findIndex(
          (candidate) =>
            candidate.start === name.start &&
            candidate.end === name.end &&
            candidate.value === name.value,
        ) === index,
    ),
  );
}

function extractRelationMentions(
  input: NormalizedSemanticInput,
  occurrences: readonly LexiconOccurrence[],
): readonly SemanticRelationMention[] {
  const relationOccurrences = occurrences
    .filter((occurrence) =>
      RELATION_CONCEPT_IDS.has(occurrence.entry.id),
    )
    .sort(
      (left, right) =>
        left.start - right.start ||
        right.end - right.start - (left.end - left.start) ||
        left.entry.id.localeCompare(right.entry.id),
    );
  const selected: LexiconOccurrence[] = [];

  for (const occurrence of relationOccurrences) {
    if (!selected.some((existing) => rangesOverlap(existing, occurrence))) {
      selected.push(occurrence);
    }
  }

  return Object.freeze(
    selected
      .map((occurrence) => {
        const entity = createEntityFromMatchKey(
          input,
          "relation",
          occurrence.entry.canonical,
          occurrence.start,
          occurrence.end,
          occurrence.concept.confidence,
        );
        return Object.freeze({
          conceptId: occurrence.entry.id,
          canonical: occurrence.entry.canonical,
          alias: occurrence.alias,
          matchKeyRange: freezeRange(occurrence.start, occurrence.end),
          entity,
          confidence: occurrence.concept.confidence,
          evidence: Object.freeze([occurrence.feature]),
        });
      }),
  );
}

function structuralTeachingCues(
  relations: readonly SemanticRelationMention[],
  questionCues: readonly MatchedFeature[],
): readonly MatchedFeature[] {
  if (questionCues.length > 0) {
    return Object.freeze([]);
  }

  return Object.freeze(
    relations.map((relation) =>
      makeFeature(
        "teaching-cue",
        `teaching:${relation.conceptId}`,
        relation.alias,
        freezeRange(relation.entity.start, relation.entity.end),
        SEMANTIC_SCORING.feature.structuralTeaching,
      ),
    ),
  );
}

export function extractSemanticFeatures(
  input: NormalizedSemanticInput,
): SemanticExtraction {
  const occurrences = findLexiconOccurrences(input);
  const concepts = Object.freeze(
    occurrences.map((occurrence) => occurrence.concept),
  );
  const questionCues = collectCues(
    input,
    QUESTION_CUES,
    SEMANTIC_SCORING.feature.questionCue,
  );
  const negationCues = collectCues(
    input,
    NEGATION_CUES,
    SEMANTIC_SCORING.feature.negationCue,
  );
  const selfReferences = extractSelfReferences(input);
  const personNames = extractPersonNames(input, occurrences);
  const relations = extractRelationMentions(input, occurrences);
  const explicitTeachingCues = occurrences
    .filter((occurrence) => occurrence.entry.id === "teaching")
    .map((occurrence) =>
      makeFeature(
        "teaching-cue",
        "teaching:explicit",
        occurrence.alias,
        occurrence.rawRange,
        occurrence.concept.confidence,
      ),
    );
  const teachingCues = Object.freeze([
    ...explicitTeachingCues,
    ...structuralTeachingCues(relations, questionCues),
  ]);
  const definitionQueryCues = Object.freeze(
    occurrences
      .filter((occurrence) => occurrence.entry.id === "query-definition")
      .map((occurrence) =>
        makeFeature(
          "definition-query",
          "query:definition",
          occurrence.alias,
          occurrence.rawRange,
          SEMANTIC_SCORING.feature.definitionQuery,
        ),
      ),
  );
  const entities = Object.freeze([
    ...selfReferences,
    ...personNames,
    ...relations.map((relation) => relation.entity),
  ]);

  return Object.freeze({
    input,
    concepts,
    entities,
    questionCues,
    negationCues,
    selfReferences,
    personNames,
    relations,
    teachingCues,
    definitionQueryCues,
  });
}
