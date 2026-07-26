import { describe, expect, it } from "vitest";
import { extractSemanticFeatures } from "./extract";
import { normalizeSemanticInput } from "./normalize";

describe("extractSemanticFeatures", () => {
  it("maps an English name with spaces and emoji back to raw input", () => {
    const raw = "  我叫  Alice Chen 🐾！";
    const extraction = extractSemanticFeatures(
      normalizeSemanticInput(raw),
    );
    const name = extraction.personNames[0];
    const expected = "Alice Chen 🐾";

    expect(name).toMatchObject({
      kind: "person-name",
      value: expected,
      rawText: expected,
      start: raw.indexOf(expected),
      end: raw.indexOf(expected) + expected.length,
      source: "explicit",
    });
    expect(raw.slice(name!.start, name!.end)).toBe(expected);
  });

  it("extracts concepts, question cues, self references and definition cues", () => {
    const extraction = extractSemanticFeatures(
      normalizeSemanticInput("Sunland AI 是什么？"),
    );

    expect(extraction.concepts.map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        "identity-self",
        "query-definition",
        "is-a",
      ]),
    );
    expect(extraction.questionCues.length).toBeGreaterThan(0);
    expect(extraction.definitionQueryCues).toHaveLength(1);
    expect(extraction.selfReferences[0]).toMatchObject({
      kind: "self",
      value: "Sunland AI · Beta",
      rawText: "Sunland AI",
    });
  });

  it("extracts relation and teaching evidence without querying stores", () => {
    const raw = "鸟有翅膀";
    const extraction = extractSemanticFeatures(
      normalizeSemanticInput(raw),
    );
    const relation = extraction.relations.find(
      ({ conceptId }) => conceptId === "has",
    );

    expect(relation).toMatchObject({
      canonical: "有",
      alias: "有",
      entity: {
        kind: "relation",
        rawText: "有",
        start: raw.indexOf("有"),
        end: raw.indexOf("有") + 1,
      },
    });
    expect(extraction.teachingCues.length).toBeGreaterThan(0);
  });

  it("extracts negation independently from intent decisions", () => {
    const extraction = extractSemanticFeatures(
      normalizeSemanticInput("猫不是狗"),
    );

    expect(extraction.negationCues.map(({ value }) => value)).toContain(
      "不是",
    );
    expect(extraction.personNames).toEqual([]);
  });

  it("handles mixed text and emoji without corrupting entity ranges", () => {
    const raw = "🐾 你可以叫我 Frost Fox";
    const extraction = extractSemanticFeatures(
      normalizeSemanticInput(raw),
    );
    const name = extraction.personNames[0];

    expect(name?.value).toBe("Frost Fox");
    expect(raw.slice(name!.start, name!.end)).toBe("Frost Fox");
    expect(extraction.concepts.map(({ id }) => id)).toContain(
      "remember-name",
    );
  });
});
