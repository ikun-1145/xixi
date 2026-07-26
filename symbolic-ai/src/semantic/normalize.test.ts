import { describe, expect, it } from "vitest";
import {
  mapNormalizedRangeToRaw,
  normalizeSemanticInput,
} from "./normalize";

describe("normalizeSemanticInput", () => {
  it("normalizes common Chinese punctuation without altering the raw input", () => {
    const input = normalizeSemanticInput("你好，世界！");

    expect(input.raw).toBe("你好，世界！");
    expect(input.surface).toBe("你好,世界!");
    expect(input.matchKey).toBe("你好,世界!");
  });

  it("preserves spaces in English proper names", () => {
    const input = normalizeSemanticInput("My name is Mary Jane");

    expect(input.surface).toBe("My name is Mary Jane");
    expect(input.matchKey).toBe("my name is mary jane");
  });

  it("handles mixed Chinese and English text", () => {
    const input = normalizeSemanticInput("Sunland AI 是我的朋友。");

    expect(input.surface).toBe("Sunland AI 是我的朋友.");
    expect(input.matchKey).toBe("sunland ai 是我的朋友.");
  });

  it("collapses only continuous whitespace and trims edge whitespace", () => {
    const input = normalizeSemanticInput(" \t New   York \n 属于  USA  ");

    expect(input.surface).toBe("New York 属于 USA");
    expect(input.matchKey).toBe("new york 属于 usa");
    expect(input.transformations.map((item) => item.kind)).toContain(
      "whitespace-collapsed",
    );
    expect(input.transformations.map((item) => item.kind)).toContain(
      "whitespace-trimmed",
    );
  });

  it("keeps half-width punctuation and normalizes full-width equivalents", () => {
    const input = normalizeSemanticInput("（A：B）；C,D?");

    expect(input.surface).toBe("(A:B);C,D?");
    expect(
      input.transformations.filter(
        (item) => item.kind === "punctuation-normalized",
      ),
    ).toHaveLength(4);
  });

  it("keeps emoji safe and maps both surrogate code units to raw", () => {
    const input = normalizeSemanticInput("嗨 🐾！");
    const emojiStart = input.surface.indexOf("🐾");
    const rawRange = mapNormalizedRangeToRaw(
      input,
      "surface",
      emojiStart,
      emojiStart + "🐾".length,
    );

    expect(input.surface).toBe("嗨 🐾!");
    expect(input.surfaceToRaw).toHaveLength(input.surface.length);
    expect(rawRange).toEqual({ start: 2, end: 4 });
    expect(input.raw.slice(rawRange.start, rawRange.end)).toBe("🐾");
  });

  it.each(["", "  \t\n  "])("handles empty-like input safely", (raw) => {
    const input = normalizeSemanticInput(raw);

    expect(input.surface).toBe("");
    expect(input.matchKey).toBe("");
    expect(input.surfaceToRaw).toEqual([]);
    expect(input.matchKeyToRaw).toEqual([]);
  });

  it("does not damage names or teaching content", () => {
    const name = normalizeSemanticInput("我叫 Mary Jane");
    const teaching = normalizeSemanticInput("New York 属于 USA");

    expect(name.surface).toBe("我叫 Mary Jane");
    expect(teaching.surface).toBe("New York 属于 USA");
  });

  it("maps collapsed surface spans and lowercase match keys back to raw", () => {
    const input = normalizeSemanticInput("  OpenAI   Lab  ");
    const surfaceSpace = input.surface.indexOf(" ");
    const surfaceRange = mapNormalizedRangeToRaw(
      input,
      "surface",
      surfaceSpace,
      surfaceSpace + 1,
    );
    const matchKeyLab = input.matchKey.indexOf("lab");
    const matchKeyRange = mapNormalizedRangeToRaw(
      input,
      "matchKey",
      matchKeyLab,
      matchKeyLab + 3,
    );

    expect(input.surface).toBe("OpenAI Lab");
    expect(input.matchKey).toBe("openai lab");
    expect(input.raw.slice(surfaceRange.start, surfaceRange.end)).toBe("   ");
    expect(input.raw.slice(matchKeyRange.start, matchKeyRange.end)).toBe("Lab");
    expect(input.matchKeyToRaw).toHaveLength(input.matchKey.length);
  });

  it("records the transformations that actually occurred", () => {
    const input = normalizeSemanticInput("  HELLO，world  ");

    expect(input.transformations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "surface",
          kind: "whitespace-trimmed",
        }),
        expect.objectContaining({
          stage: "surface",
          kind: "punctuation-normalized",
          sourceText: "，",
          targetText: ",",
        }),
        expect.objectContaining({
          stage: "match-key",
          kind: "case-folded",
        }),
      ]),
    );
  });

  it("only removes edge fillers when they are delimiter-separated", () => {
    const separated = normalizeSemanticInput("嗯，你好，啊");
    const embedded = normalizeSemanticInput("我叫阿呀");

    expect(separated.surface).toBe("嗯,你好,啊");
    expect(separated.matchKey).toBe("你好");
    expect(embedded.matchKey).toBe("我叫阿呀");
  });
});
