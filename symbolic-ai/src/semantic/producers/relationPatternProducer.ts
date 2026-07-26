import type { ParsedQuery, ParsedStatement } from "@/types";
import { mapNormalizedRangeToRaw } from "../normalize";
import {
  scoreFromParts,
  SEMANTIC_SCORING,
} from "../scoring";
import type {
  CandidateSideEffect,
  MatchedFeature,
  RawTextRange,
  SemanticCandidate,
  SemanticConcept,
  SemanticEntity,
  SemanticExtraction,
  SemanticRelationMention,
} from "../types";

const CLAUSE_PUNCTUATION = /[,;!?]/u;
const ENTITY_EDGE = /[\s,.;:!?'"()[\]~]/u;
const QUERY_OBJECTS = new Set(["什么", "啥", "谁", "哪", "哪里"]);
const QUERY_ENDINGS = /[吗呢]$/u;
const NEGATION_ENDING = /(?:不是|不会|不能|没有|不|没)$/u;

interface Segment {
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

function findClauseStart(
  text: string,
  relationStart: number,
): number {
  let start = 0;
  for (let index = relationStart - 1; index >= 0; index -= 1) {
    if (CLAUSE_PUNCTUATION.test(text[index]!)) {
      start = index + 1;
      break;
    }
  }

  const prefix = text.slice(start, relationStart);
  const conjunction = prefix.lastIndexOf("和");
  if (
    conjunction >= 0 &&
    /(?:什么|啥|谁|吗|呢|\?)/u.test(prefix.slice(0, conjunction))
  ) {
    return start + conjunction + 1;
  }

  return start;
}

function findClauseEnd(text: string, relationEnd: number): number {
  for (let index = relationEnd; index < text.length; index += 1) {
    if (CLAUSE_PUNCTUATION.test(text[index]!)) {
      return index;
    }
  }
  return text.length;
}

function trimSegment(
  text: string,
  start: number,
  end: number,
): Segment | null {
  let trimmedStart = start;
  let trimmedEnd = end;

  while (
    trimmedStart < trimmedEnd &&
    ENTITY_EDGE.test(text[trimmedStart]!)
  ) {
    trimmedStart += 1;
  }
  while (
    trimmedEnd > trimmedStart &&
    ENTITY_EDGE.test(text[trimmedEnd - 1]!)
  ) {
    trimmedEnd -= 1;
  }

  if (trimmedStart >= trimmedEnd) {
    return null;
  }

  return Object.freeze({
    start: trimmedStart,
    end: trimmedEnd,
    value: text.slice(trimmedStart, trimmedEnd),
  });
}

function removeNegation(
  text: string,
  segment: Segment | null,
): {
  readonly segment: Segment | null;
  readonly negated: boolean;
} {
  if (segment === null) {
    return Object.freeze({ segment: null, negated: false });
  }

  const matched = NEGATION_ENDING.exec(segment.value);
  if (matched === null) {
    return Object.freeze({ segment, negated: false });
  }

  return Object.freeze({
    segment: trimSegment(
      text,
      segment.start,
      segment.end - matched[0].length,
    ),
    negated: true,
  });
}

function normalizeObjectSegment(
  text: string,
  segment: Segment | null,
): Segment | null {
  if (segment === null) {
    return null;
  }

  const ending = QUERY_ENDINGS.exec(segment.value);
  if (ending === null) {
    return segment;
  }

  return trimSegment(
    text,
    segment.start,
    segment.end - ending[0].length,
  );
}

function rawRangeForSegment(
  extraction: SemanticExtraction,
  segment: Segment,
): RawTextRange {
  return mapNormalizedRangeToRaw(
    extraction.input,
    "matchKey",
    segment.start,
    segment.end,
  );
}

function displayValue(
  extraction: SemanticExtraction,
  segment: Segment,
): string {
  const rawRange = rawRangeForSegment(extraction, segment);
  return extraction.input.raw
    .slice(rawRange.start, rawRange.end)
    .trim()
    .replace(/\s+/gu, " ")
    .replace(/^["“”'‘’]+|["“”'‘’]+$/gu, "");
}

function createEntity(
  extraction: SemanticExtraction,
  kind: "subject" | "object",
  segment: Segment,
  confidence: SemanticRelationMention["confidence"],
): SemanticEntity {
  const rawRange = rawRangeForSegment(extraction, segment);
  return Object.freeze({
    kind,
    value: displayValue(extraction, segment),
    rawText: extraction.input.raw.slice(rawRange.start, rawRange.end),
    start: rawRange.start,
    end: rawRange.end,
    source: "explicit",
    confidence,
  });
}

function relationConcept(
  extraction: SemanticExtraction,
  relation: SemanticRelationMention,
): SemanticConcept {
  return (
    extraction.concepts.find(
      (concept) =>
        concept.id === relation.conceptId &&
        concept.evidence.some(
          (evidence) =>
            evidence.rawRange?.start === relation.entity.start &&
            evidence.rawRange.end === relation.entity.end,
        ),
    ) ??
    Object.freeze({
      id: relation.conceptId,
      canonical: relation.canonical,
      matchedAlias: relation.alias,
      confidence: relation.confidence,
      evidence: relation.evidence,
    })
  );
}

function isRelationInsideMemoryCue(
  extraction: SemanticExtraction,
  relation: SemanticRelationMention,
): boolean {
  return extraction.concepts
    .filter(
      (concept) =>
        concept.id === "remember-name" ||
        concept.id === "recall-name",
    )
    .some((concept) =>
      concept.evidence.some((evidence) => {
        const range = evidence.rawRange;
        return (
          range !== undefined &&
          relation.entity.start >= range.start &&
          relation.entity.end <= range.end
        );
      }),
    );
}

function isQuestionShape(
  extraction: SemanticExtraction,
  clauseStart: number,
  clauseEnd: number,
  object: Segment | null,
): boolean {
  if (
    object !== null &&
    QUERY_OBJECTS.has(object.value.replace(QUERY_ENDINGS, ""))
  ) {
    return true;
  }

  const clauseRange =
    clauseStart < clauseEnd
      ? mapNormalizedRangeToRaw(
          extraction.input,
          "matchKey",
          clauseStart,
          clauseEnd,
        )
      : null;

  return extraction.questionCues.some((cue) => {
    const range = cue.rawRange;
    return (
      range !== undefined &&
      clauseRange !== null &&
      range.start >= clauseRange.start &&
      range.end <= clauseRange.end
    );
  });
}

function makeResult(
  extraction: SemanticExtraction,
  relation: SemanticRelationMention,
  subject: SemanticEntity | null,
  object: SemanticEntity | null,
  queryKind: "object-of" | "verify" | null,
  negated: boolean,
): ParsedQuery | ParsedStatement | null {
  if (subject === null) {
    return null;
  }

  if (queryKind === "object-of") {
    return Object.freeze({
      type: "query",
      subject: subject.value,
      relation: relation.canonical,
      kind: "object-of",
      raw: extraction.input.raw,
    });
  }

  if (queryKind === "verify") {
    if (object === null) {
      return null;
    }
    return Object.freeze({
      type: "query",
      subject: subject.value,
      relation: relation.canonical,
      object: object.value,
      kind: "verify",
      raw: extraction.input.raw,
    });
  }

  if (object === null) {
    return null;
  }

  return Object.freeze({
    type: "statement",
    subject: subject.value,
    relation: relation.canonical,
    object: object.value,
    negated,
    raw: extraction.input.raw,
  });
}

function candidateForRelation(
  extraction: SemanticExtraction,
  relation: SemanticRelationMention,
): SemanticCandidate | null {
  if (isRelationInsideMemoryCue(extraction, relation)) {
    return null;
  }

  const text = extraction.input.matchKey;
  const clauseStart = findClauseStart(text, relation.matchKeyRange.start);
  const clauseEnd = findClauseEnd(text, relation.matchKeyRange.end);
  const rawSubject = trimSegment(
    text,
    clauseStart,
    relation.matchKeyRange.start,
  );
  const subjectWithNegation = removeNegation(text, rawSubject);
  const rawObject = trimSegment(
    text,
    relation.matchKeyRange.end,
    clauseEnd,
  );
  const normalizedObject = normalizeObjectSegment(text, rawObject);
  const question = isQuestionShape(
    extraction,
    clauseStart,
    clauseEnd,
    normalizedObject,
  );
  const openQuery =
    relation.alias === "是什么意思" ||
    (normalizedObject !== null &&
      QUERY_OBJECTS.has(normalizedObject.value));
  const queryKind = openQuery
    ? "object-of"
    : question
      ? "verify"
      : null;
  const queryObject = openQuery ? null : normalizedObject;
  const subject =
    subjectWithNegation.segment === null
      ? null
      : createEntity(
          extraction,
          "subject",
          subjectWithNegation.segment,
          relation.confidence,
        );
  const object =
    queryObject === null
      ? null
      : createEntity(
          extraction,
          "object",
          queryObject,
          relation.confidence,
        );
  const result = makeResult(
    extraction,
    relation,
    subject,
    object,
    queryKind,
    subjectWithNegation.negated,
  );
  const missingSlots: string[] = [];
  if (subject === null) {
    missingSlots.push("subject");
  }
  if (
    (queryKind === null || queryKind === "verify") &&
    object === null
  ) {
    missingSlots.push("object");
  }
  const sideEffect: CandidateSideEffect =
    result?.type === "statement" ? "knowledge-write" : "none";
  const additions = [
    relation.confidence * SEMANTIC_SCORING.relation.conceptWeightShare,
    ...(subject === null
      ? []
      : [SEMANTIC_SCORING.relation.subjectBonus]),
    ...(object === null
      ? []
      : [SEMANTIC_SCORING.relation.objectBonus]),
    queryKind !== null
      ? SEMANTIC_SCORING.relation.queryShapeBonus
      : SEMANTIC_SCORING.relation.statementShapeBonus,
  ];
  const deductions = [
    ...missingSlots.map(
      () => SEMANTIC_SCORING.relation.missingSlotPenalty,
    ),
    ...(sideEffect === "none"
      ? []
      : [SEMANTIC_SCORING.relation.sideEffectPenalty]),
    ...(relation.alias.length === 1
      ? [SEMANTIC_SCORING.relation.weakSingleCharacterPenalty]
      : []),
  ];
  const confidence = scoreFromParts(
    SEMANTIC_SCORING.relation.base,
    additions,
    deductions,
  );
  const entities = Object.freeze(
    [subject, relation.entity, object].filter(
      (entity): entity is SemanticEntity => entity !== null,
    ),
  );
  const evidence: readonly MatchedFeature[] = Object.freeze([
    ...relation.evidence,
    ...entities
      .filter((entity) => entity.kind !== "relation")
      .map((entity) =>
        Object.freeze({
          kind: "relation-pattern" as const,
          key: `slot:${entity.kind}`,
          value: entity.value,
          rawRange: Object.freeze({
            start: entity.start,
            end: entity.end,
          }),
          weight: entity.confidence,
        }),
      ),
    ...(queryKind !== null
      ? extraction.questionCues
      : extraction.teachingCues),
    ...(subjectWithNegation.negated ? extraction.negationCues : []),
  ]);
  const interpretation =
    result === null
      ? `partial:${relation.canonical}:${relation.entity.start}`
      : result.type === "query"
        ? `query:${result.subject}:${result.relation}`
        : `statement:${result.subject}:${result.relation}:${result.object}:${result.negated}`;

  return Object.freeze({
    id: `relation-pattern:${interpretation}`,
    producer: "relation-pattern",
    producerWeight:
      SEMANTIC_SCORING.producerWeight["relation-pattern"],
    result,
    concepts: Object.freeze([relationConcept(extraction, relation)]),
    entities,
    confidence,
    evidence,
    missingSlots: Object.freeze(missingSlots),
    sideEffect,
  });
}

function partialTeachingCandidate(
  extraction: SemanticExtraction,
): SemanticCandidate | null {
  const explicitCues = extraction.teachingCues.filter(
    ({ key }) => key === "teaching:explicit",
  );
  if (explicitCues.length === 0 || extraction.relations.length > 0) {
    return null;
  }

  const teachingConcepts = extraction.concepts.filter(
    ({ id }) => id === "teaching",
  );
  const missingSlots = Object.freeze([
    "subject",
    "relation",
    "object",
  ]);
  const confidence = scoreFromParts(
    SEMANTIC_SCORING.relation.base,
    [],
    missingSlots.map(
      () => SEMANTIC_SCORING.relation.missingSlotPenalty,
    ),
  );
  const firstRange = explicitCues[0]?.rawRange;

  return Object.freeze({
    id: `relation-pattern:partial-teaching:${firstRange?.start ?? 0}`,
    producer: "relation-pattern",
    producerWeight:
      SEMANTIC_SCORING.producerWeight["relation-pattern"],
    result: null,
    concepts: Object.freeze(teachingConcepts),
    entities: Object.freeze([]),
    confidence,
    evidence: Object.freeze(explicitCues),
    missingSlots,
    sideEffect: "none",
  });
}

export function produceRelationPatternCandidates(
  extraction: SemanticExtraction,
): readonly SemanticCandidate[] {
  const partialTeaching = partialTeachingCandidate(extraction);
  return Object.freeze(
    [
      ...extraction.relations.map((relation) =>
        candidateForRelation(extraction, relation),
      ),
      partialTeaching,
    ].filter(
      (candidate): candidate is SemanticCandidate => candidate !== null,
    ),
  );
}
