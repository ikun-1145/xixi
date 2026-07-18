import { describe, expect, it } from "vitest";
import type { GrammarPattern, IntentMatcher, ParsedIntent, ParsedQuery, ParsedStatement } from "@/types";
import { RegexParser } from "./parser";
import { createParser } from "./index";

describe("RegexParser (default grammar)", () => {
  const parser = createParser();

  describe("statements", () => {
    it.each<[string, Partial<ParsedStatement>]>([
      ["猫属于哺乳动物", { subject: "猫", relation: "属于", object: "哺乳动物", negated: false }],
      ["企鹅属于鸟", { subject: "企鹅", relation: "属于", object: "鸟", negated: false }],
      ["鸟会飞", { subject: "鸟", relation: "会", object: "飞", negated: false }],
      ["麻雀属于鸟", { subject: "麻雀", relation: "属于", object: "鸟", negated: false }],
      ["企鹅不会飞", { subject: "企鹅", relation: "会", object: "飞", negated: true }],
      ["猫喜欢鱼", { subject: "猫", relation: "喜欢", object: "鱼", negated: false }],
      ["苏格拉底是人", { subject: "苏格拉底", relation: "是", object: "人", negated: false }],
      ["猫在屋顶", { subject: "猫", relation: "在", object: "屋顶", negated: false }],
    ])("parses '%s'", (input, expected) => {
      const result = parser.parse(input);
      expect(result.type).toBe("statement");
      expect(result).toMatchObject(expected);
      expect(result.raw).toBe(input); // original input preserved verbatim
    });

    it("accepts spaced input identically to unspaced input", () => {
      const spaced = parser.parse("猫 属于 哺乳动物");
      const unspaced = parser.parse("猫属于哺乳动物");
      expect(spaced).toMatchObject({ subject: "猫", relation: "属于", object: "哺乳动物" });
      // raw differs (preserves user's exact text) but structured fields match.
      expect(spaced.raw).toBe("猫 属于 哺乳动物");
      expect({ ...spaced, raw: "" }).toEqual({ ...unspaced, raw: "" });
    });
  });

  describe("object-of queries", () => {
    it.each<[string, Partial<ParsedQuery>]>([
      ["猫属于什么？", { subject: "猫", relation: "属于", kind: "object-of" }],
      ["猫是什么", { subject: "猫", relation: "是", kind: "object-of" }],
      ["鸟会什么", { subject: "鸟", relation: "会", kind: "object-of" }],
    ])("parses '%s'", (input, expected) => {
      const result = parser.parse(input);
      expect(result.type).toBe("query");
      expect(result).toMatchObject(expected);
      expect((result as ParsedQuery).object).toBeUndefined();
    });
  });

  describe("verify queries", () => {
    it.each<[string, Partial<ParsedQuery>]>([
      ["企鹅是不是鸟", { subject: "企鹅", relation: "是", object: "鸟", kind: "verify" }],
      ["麻雀会不会飞", { subject: "麻雀", relation: "会", object: "飞", kind: "verify" }],
      ["企鹅属不属于鸟", { subject: "企鹅", relation: "属于", object: "鸟", kind: "verify" }],
    ])("parses '%s'", (input, expected) => {
      const result = parser.parse(input);
      expect(result.type).toBe("query");
      expect(result).toMatchObject(expected);
    });
  });

  describe("locate queries", () => {
    it("parses '猫在哪里'", () => {
      const result = parser.parse("猫在哪里");
      expect(result).toMatchObject({
        type: "query",
        subject: "猫",
        relation: "在",
        kind: "locate",
      });
    });
  });

  describe("why queries (Stage 7 — Response Planner's `explain` cue)", () => {
    it("parses '猫为什么属于生物' as a verify query with explain: true", () => {
      const result = parser.parse("猫为什么属于生物");
      expect(result).toMatchObject({
        type: "query",
        subject: "猫",
        relation: "属于",
        object: "生物",
        kind: "verify",
        explain: true,
      });
    });

    it("does not set explain on ordinary verify/object-of queries", () => {
      const verify = parser.parse("猫属不属于生物") as ParsedQuery;
      const objectOf = parser.parse("猫属于什么") as ParsedQuery;
      expect(verify.explain).toBeUndefined();
      expect(objectOf.explain).toBeUndefined();
    });
  });

  describe("ambiguity resolution (query patterns must win over statement patterns)", () => {
    it("does not mistake '猫属于什么' for a statement about '什么'", () => {
      const result = parser.parse("猫属于什么");
      expect(result.type).toBe("query");
    });

    it("does not mistake '企鹅是不是鸟' for a negated '是' statement", () => {
      const result = parser.parse("企鹅是不是鸟");
      expect(result.type).toBe("query");
      expect((result as ParsedQuery).kind).toBe("verify");
    });

    it("does not mistake '猫为什么属于生物' for a statement about '猫为什么'", () => {
      const result = parser.parse("猫为什么属于生物");
      expect(result.type).toBe("query");
      expect((result as ParsedQuery).subject).toBe("猫");
    });
  });

  describe("intents (Stage 4 — Basic Understanding)", () => {
    it.each<[string, ParsedIntent["intent"]]>([
      ["你好", "Greeting"],
      ["您好", "Greeting"],
      ["哈喽", "Greeting"],
      ["嗨", "Greeting"],
      ["Hi", "Greeting"],
      ["Hello", "Greeting"],
      ["你好呀", "Greeting"], // casual filler-tolerant variant
      ["谢谢", "Thanks"],
      ["感谢", "Thanks"],
      ["thank you", "Thanks"], // multi-word phrase survives whitespace stripping
      ["再见", "Farewell"],
      ["拜拜", "Farewell"],
      ["bye", "Farewell"],
    ])("recognizes '%s' as intent %s, not six separate grammar rules", (input, intent) => {
      const result = parser.parse(input);
      expect(result.type).toBe("intent");
      expect((result as ParsedIntent).intent).toBe(intent);
      expect((result as ParsedIntent).entities).toEqual([]);
      expect((result as ParsedIntent).confidence).toBeGreaterThan(0);
      expect(result.raw).toBe(input);
    });

    it.each<[string, string, string]>([
      ["你是谁", "Sunland AI", "identity"],
      ["Sunland AI是什么", "Sunland AI", "identity"],
      ["霜蓝是谁", "霜蓝", "identity"],
      ["你能做什么", "Sunland AI", "capability"],
      ["是谁开发了你", "Sunland AI", "creator"],
    ])("recognizes '%s' as Identity intent with entities [%s, %s]", (input, subject, aspect) => {
      const result = parser.parse(input);
      expect(result.type).toBe("intent");
      expect((result as ParsedIntent).intent).toBe("Identity");
      expect((result as ParsedIntent).entities).toEqual([subject, aspect]);
    });

    it.each<[string, string]>([
      ["我叫刘锡泽", "刘锡泽"],
      ["我的名字是刘锡泽", "刘锡泽"],
      ["叫我锡泽", "锡泽"],
    ])("recognizes '%s' as RememberName intent with name entity [%s]", (input, name) => {
      const result = parser.parse(input);
      expect(result.type).toBe("intent");
      expect((result as ParsedIntent).intent).toBe("RememberName");
      expect((result as ParsedIntent).entities).toEqual([name]);
    });

    it.each<string>(["我叫什么", "我叫什么名字", "你知道我的名字吗", "你记得我的名字吗"])(
      "recognizes '%s' as RecallName intent with no entities",
      (input) => {
        const result = parser.parse(input);
        expect(result.type).toBe("intent");
        expect((result as ParsedIntent).intent).toBe("RecallName");
        expect((result as ParsedIntent).entities).toEqual([]);
      },
    );

    it("does not let intents shadow the existing statement/query grammar", () => {
      // Sanity check that adding intent-matching first doesn't regress the
      // pre-existing knowledge-teaching parse paths.
      expect(parser.parse("猫属于哺乳动物").type).toBe("statement");
      expect(parser.parse("猫属于什么").type).toBe("query");
    });

    it("still falls through to 'unknown' for genuinely unrecognized input", () => {
      const result = parser.parse("哈哈哈哈哈");
      expect(result.type).toBe("unknown");
    });

    it("supports a caller-supplied intent-matcher list, independent of patterns", () => {
      const alwaysGreeting: IntentMatcher = {
        intent: "Greeting",
        match: () => ({ entities: [], confidence: 1 }),
      };
      const customParser = new RegexParser([], [alwaysGreeting]);
      const result = customParser.parse("任意输入");
      expect(result).toMatchObject({ type: "intent", intent: "Greeting", confidence: 1 });
    });
  });

  describe("unmatched input", () => {
    it("returns a ParseFailure with a reason for gibberish", () => {
      const result = parser.parse("哈哈哈哈哈");
      expect(result).toEqual({
        type: "unknown",
        raw: "哈哈哈哈哈",
        reason: expect.stringContaining("哈哈哈哈哈"),
      });
    });

    it("returns a ParseFailure for empty input", () => {
      const result = parser.parse("   ");
      expect(result).toEqual({
        type: "unknown",
        raw: "   ",
        reason: "输入为空",
      });
    });
  });

  describe("extensibility: custom pattern injection", () => {
    it("accepts a caller-supplied pattern list without touching the core class", () => {
      const alwaysMatch: GrammarPattern = {
        name: "test:always",
        match: (normalizedInput) => ({
          type: "statement",
          subject: "x",
          relation: "测试",
          object: normalizedInput,
          negated: false,
          raw: normalizedInput,
        }),
      };
      const customParser = new RegexParser([alwaysMatch]);
      const result = customParser.parse("任意输入");
      expect(result).toMatchObject({ subject: "x", relation: "测试", object: "任意输入" });
    });
  });
});
