import { createParser } from "@/parser";
import type { ParseResult } from "@/types";
import { SEMANTIC_SCORING, clampConfidence } from "../scoring";
import {
  createConfidence,
  type SemanticCandidate,
  type SemanticConcept,
  type SemanticExtraction,
} from "../types";

const INTENT_CONCEPTS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    Greeting: Object.freeze(["greeting"]),
    Thanks: Object.freeze(["thanks"]),
    Farewell: Object.freeze(["goodbye"]),
    Identity: Object.freeze(["identity-name", "identity-self"]),
    RememberName: Object.freeze(["remember-name"]),
    RecallName: Object.freeze(["recall-name"]),
  });

function resultKey(result: ParseResult): string {
  switch (result.type) {
    case "intent":
      return `intent:${result.intent}:${result.entities.join("|")}`;
    case "statement":
      return `statement:${result.subject}:${result.relation}:${result.object}:${result.negated}`;
    case "query":
      return `query:${result.kind}:${result.subject}:${result.relation}:${result.object ?? ""}`;
    case "unknown":
      return "unknown";
  }
}

function selectConcepts(
  result: ParseResult,
  extraction: SemanticExtraction,
): readonly SemanticConcept[] {
  if (result.type === "intent") {
    const ids = INTENT_CONCEPTS[result.intent] ?? [];
    return Object.freeze(
      extraction.concepts.filter((concept) => ids.includes(concept.id)),
    );
  }

  if (result.type === "statement" || result.type === "query") {
    return Object.freeze(
      extraction.concepts.filter((concept) =>
        extraction.relations.some(
          (relation) =>
            relation.conceptId === concept.id &&
            relation.canonical === result.relation,
        ),
      ),
    );
  }

  return Object.freeze([]);
}

function resultConfidence(result: ParseResult) {
  switch (result.type) {
    case "intent":
      return createConfidence(
        Math.max(
          SEMANTIC_SCORING.legacy.intentFloor,
          clampConfidence(result.confidence),
        ),
      );
    case "statement":
      return SEMANTIC_SCORING.legacy.statement;
    case "query":
      return SEMANTIC_SCORING.legacy.query;
    case "unknown":
      return SEMANTIC_SCORING.legacy.unknown;
  }
}

export function produceLegacyRegexCandidate(
  extraction: SemanticExtraction,
): SemanticCandidate {
  const result = createParser().parse(extraction.input.raw);
  const confidence = resultConfidence(result);
  const rawRange = Object.freeze({
    start: 0,
    end: extraction.input.raw.length,
  });
  const evidence = Object.freeze([
    Object.freeze({
      kind: "legacy-regex" as const,
      key: `legacy:${result.type}`,
      value: result.type,
      rawRange,
      weight: confidence,
    }),
  ]);

  return Object.freeze({
    id: `legacy-regex:${resultKey(result)}`,
    producer: "legacy-regex",
    producerWeight: SEMANTIC_SCORING.producerWeight["legacy-regex"],
    result,
    concepts: selectConcepts(result, extraction),
    entities: extraction.entities,
    confidence,
    evidence,
    missingSlots:
      result.type === "unknown"
        ? Object.freeze(["interpretation"])
        : Object.freeze([]),
    sideEffect:
      result.type === "statement" ? "knowledge-write" : "none",
  });
}
