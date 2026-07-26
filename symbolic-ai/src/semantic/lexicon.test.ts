import { describe, expect, it } from "vitest";
import {
  findLexiconAliasConflicts,
  findLexiconConceptById,
  findLexiconConceptsByAlias,
  findLexiconConceptsByCanonical,
  SEMANTIC_LEXICON,
} from "./lexicon";
import { isConfidence } from "./types";

describe("semantic lexicon", () => {
  it("finds aliases without silently reducing matches to one result", () => {
    expect(findLexiconConceptsByAlias("  THANK YOU  ").map(({ id }) => id)).toEqual([
      "thanks",
    ]);
    expect(findLexiconConceptsByAlias("我叫").map(({ id }) => id)).toEqual([
      "remember-name",
    ]);
  });

  it("finds concepts by canonical text and id", () => {
    expect(
      findLexiconConceptsByCanonical("你好").map(({ id }) => id),
    ).toEqual(["greeting"]);
    expect(findLexiconConceptById("identity-self")?.canonical).toBe("你是谁");
  });

  it("returns safe empty results for unknown or empty lookups", () => {
    expect(findLexiconConceptsByAlias("not-in-lexicon")).toEqual([]);
    expect(findLexiconConceptsByAlias("   ")).toEqual([]);
    expect(findLexiconConceptsByCanonical("not-in-lexicon")).toEqual([]);
    expect(findLexiconConceptById("not-in-lexicon")).toBeNull();
  });

  it("exposes deeply frozen lexicon data", () => {
    const entry = findLexiconConceptById("greeting");

    expect(Object.isFrozen(SEMANTIC_LEXICON)).toBe(true);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry?.aliases)).toBe(true);
    expect(Object.isFrozen(entry?.constraints)).toBe(true);
    expect(Object.isFrozen(entry?.constraints.allowedCandidateKinds)).toBe(true);

    expect(() => {
      (
        SEMANTIC_LEXICON as unknown as SemanticLexiconMutationTarget
      ).push(entry!);
    }).toThrow(TypeError);
  });

  it("marks only concepts allowed to participate in side effects", () => {
    expect(findLexiconConceptById("remember-name")?.sideEffectSafe).toBe(true);
    expect(findLexiconConceptById("teaching")?.sideEffectSafe).toBe(true);
    expect(findLexiconConceptById("is-a")?.sideEffectSafe).toBe(true);
    expect(findLexiconConceptById("greeting")?.sideEffectSafe).toBe(false);
    expect(findLexiconConceptById("recall-name")?.sideEffectSafe).toBe(false);
  });

  it("contains no duplicate normalized aliases in the initial data", () => {
    expect(findLexiconAliasConflicts()).toEqual([]);
  });

  it("stores validated weights", () => {
    expect(SEMANTIC_LEXICON.every((entry) => isConfidence(entry.baseWeight))).toBe(
      true,
    );
  });
});

type SemanticLexiconMutationTarget = {
  push(value: (typeof SEMANTIC_LEXICON)[number]): number;
};
