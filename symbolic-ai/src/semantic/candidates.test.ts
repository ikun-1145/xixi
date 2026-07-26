import type { ParseResult } from "@/types";
import { describe, expect, it } from "vitest";
import {
  analyzeSemanticInput,
  deduplicateSemanticCandidates,
} from "./candidates";
import { createConfidence, type SemanticCandidate } from "./types";

function intentCandidates(raw: string, intent: string) {
  return analyzeSemanticInput(raw).candidates.filter(
    (candidate) =>
      candidate.result?.type === "intent" &&
      candidate.result.intent === intent,
  );
}

function relationCandidates(raw: string) {
  return analyzeSemanticInput(raw).candidates.filter(
    ({ producer }) => producer === "relation-pattern",
  );
}

describe("semantic candidate generation", () => {
  it.each([
    ["你好", "Greeting"],
    ["哈喽呀", "Greeting"],
    ["hello Sunland AI", "Greeting"],
    ["谢谢你", "Thanks"],
    ["多谢啦", "Thanks"],
    ["再见", "Farewell"],
    ["先走啦", "Farewell"],
  ])("recognizes conversational input %s", (raw, intent) => {
    expect(intentCandidates(raw, intent).length).toBeGreaterThan(0);
  });

  it.each([
    "你是谁",
    "你叫什么",
    "Sunland AI 是什么",
    "你叫啥呀",
  ])("generates an Identity candidate for %s", (raw) => {
    const candidates = intentCandidates(raw, "Identity");

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.some(({ producer }) => producer === "lexicon")).toBe(
      true,
    );
  });

  it.each([
    ["我叫小明", "小明"],
    ["你可以叫我霜蓝", "霜蓝"],
    ["我的名字是 Alice Chen", "Alice Chen"],
  ])("requires an explicit name for RememberName: %s", (raw, name) => {
    const candidates = intentCandidates(raw, "RememberName");
    const lexicon = candidates.find(
      ({ producer }) => producer === "lexicon",
    );

    expect(lexicon?.result).toMatchObject({
      type: "intent",
      intent: "RememberName",
      entities: [name],
    });
    expect(lexicon?.sideEffect).toBe("memory-write");
    expect(lexicon?.entities[0]).toMatchObject({
      kind: "person-name",
      value: name,
    });
  });

  it.each([
    "我叫什么",
    "你记得我的名字吗",
    "还记得我是谁吗",
  ])("generates RecallName without a write side effect: %s", (raw) => {
    const candidates = intentCandidates(raw, "RecallName");

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every(({ sideEffect }) => sideEffect === "none")).toBe(
      true,
    );
  });

  it.each([
    ["猫是一种动物", "statement", "属于", "猫", "动物"],
    ["猫会爬树", "statement", "会", "猫", "爬树"],
    ["鸟有翅膀", "statement", "有", "鸟", "翅膀"],
    ["“霜蓝”指的是我的角色名", "statement", "意思是", "霜蓝", "我的角色名"],
    ["猫是什么", "query", "属于", "猫", undefined],
    ["猫会什么", "query", "会", "猫", undefined],
    ["猫有什么", "query", "有", "猫", undefined],
    ["霜蓝是什么意思", "query", "意思是", "霜蓝", undefined],
  ])(
    "generates a canonical relation candidate for %s",
    (raw, type, relation, subject, object) => {
      const candidate = relationCandidates(raw).find(
        ({ result }) =>
          (result?.type === "statement" || result?.type === "query") &&
          result.type === type &&
          result.subject === subject &&
          result.relation === relation,
      );

      expect(candidate).toBeDefined();
      expect(candidate?.result).toMatchObject({
        type,
        subject,
        relation,
        ...(object === undefined ? {} : { object }),
      });
      expect(candidate?.evidence.length).toBeGreaterThan(0);
      expect(candidate?.missingSlots).toEqual([]);
    },
  );

  it("prefers the longest overlapping relation alias", () => {
    const candidates = relationCandidates("“霜蓝”指的是我的角色名");

    expect(
      candidates.some(
        ({ result }) =>
          result?.type === "statement" &&
          result.relation === "意思是",
      ),
    ).toBe(true);
    expect(
      candidates.some(
        ({ result }) =>
          result?.type === "statement" &&
          result.relation === "属于",
      ),
    ).toBe(false);
  });

  it("retains a partial weak relation candidate with missing slots", () => {
    const candidate = relationCandidates("你会吗").find(({ concepts }) =>
      concepts.some(({ id }) => id === "can"),
    );

    expect(candidate).toBeDefined();
    expect(candidate?.result).toBeNull();
    expect(candidate?.missingSlots).toContain("object");
    expect(candidate?.confidence).toBeLessThan(0.7);
    expect(candidate?.sideEffect).toBe("none");
  });

  it("retains explicit teaching with a missing relation as a safe partial candidate", () => {
    const candidate = relationCandidates("教你一个事实").find(
      ({ result, concepts }) =>
        result === null &&
        concepts.some(({ id }) => id === "teaching"),
    );

    expect(candidate?.missingSlots).toEqual([
      "subject",
      "relation",
      "object",
    ]);
    expect(candidate?.sideEffect).toBe("none");
  });

  it("does not turn a weak name keyword into a write candidate", () => {
    const candidates = analyzeSemanticInput("名字").candidates;

    expect(
      candidates.some(
        (candidate) =>
          candidate.sideEffect === "memory-write" ||
          (candidate.result?.type === "intent" &&
            candidate.result.intent === "RememberName"),
      ),
    ).toBe(false);
  });

  it.each(["我不是小明", "猫不是狗"])(
    "does not turn negation into a positive write: %s",
    (raw) => {
      const candidates = analyzeSemanticInput(raw).candidates;
      const statements = candidates
        .map(({ result }) => result)
        .filter(
          (
            result,
          ): result is Extract<ParseResult, { type: "statement" }> =>
            result?.type === "statement",
        );

      expect(intentCandidates(raw, "RememberName")).toEqual([]);
      expect(statements.length).toBeGreaterThan(0);
      expect(statements.every(({ negated }) => negated)).toBe(true);
    },
  );

  it("allows Greeting and RememberName candidates in one utterance", () => {
    const analysis = analyzeSemanticInput("你好，我叫小明");

    expect(
      analysis.candidates.some(
        ({ result }) =>
          result?.type === "intent" && result.intent === "Greeting",
      ),
    ).toBe(true);
    expect(
      analysis.candidates.some(
        ({ result }) =>
          result?.type === "intent" &&
          result.intent === "RememberName" &&
          result.entities[0] === "小明",
      ),
    ).toBe(true);
  });

  it("keeps multiple interpretations for a compound question", () => {
    const analysis = analyzeSemanticInput("你叫什么和你会什么");

    expect(
      analysis.candidates.some(
        ({ result }) =>
          result?.type === "intent" && result.intent === "Identity",
      ),
    ).toBe(true);
    expect(
      analysis.candidates.some(
        ({ result }) =>
          result?.type === "query" && result.relation === "会",
      ),
    ).toBe(true);
  });

  it("marks each independent producer explicitly", () => {
    const producers = new Set(
      analyzeSemanticInput("你好").candidates.map(
        ({ producer }) => producer,
      ),
    );

    expect(producers).toContain("legacy-regex");
    expect(producers).toContain("lexicon");
  });

  it("deduplicates equal interpretations within one producer and merges evidence", () => {
    const lexiconGreetings = intentCandidates(
      "你好你好",
      "Greeting",
    ).filter(({ producer }) => producer === "lexicon");

    expect(lexiconGreetings).toHaveLength(1);
    expect(lexiconGreetings[0]!.evidence.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps cross-producer corroboration instead of hiding its source", () => {
    const analysis = analyzeSemanticInput("你好");
    const greetings = analysis.candidates.filter(
      ({ result }) =>
        result?.type === "intent" && result.intent === "Greeting",
    );

    expect(new Set(greetings.map(({ producer }) => producer)).size).toBe(2);
  });

  it("sorts candidates deterministically using explicit tie breakers", () => {
    const first = analyzeSemanticInput("你好，我叫小明").candidates.map(
      ({ id }) => id,
    );
    const second = analyzeSemanticInput("你好，我叫小明").candidates.map(
      ({ id }) => id,
    );

    expect(first).toEqual(second);
  });

  it("does not place user-facing fallback copy in diagnostics", () => {
    const diagnostics = analyzeSemanticInput("完全未知的表达 🐾").diagnostics;
    const messages = diagnostics.map(({ message }) => message).join(" ");

    expect(messages).not.toMatch(
      /暂时还没理解|换一种说法|告诉我一点相关信息|还没有输入内容/u,
    );
  });
});

describe("candidate deduplication", () => {
  it("merges evidence for explicitly duplicated candidates", () => {
    const base = createTestCandidate("feature:a");
    const duplicate = createTestCandidate("feature:b");
    const merged = deduplicateSemanticCandidates([base, duplicate]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.evidence.map(({ key }) => key)).toEqual([
      "feature:a",
      "feature:b",
    ]);
  });
});

function createTestCandidate(evidenceKey: string): SemanticCandidate {
  const confidence = createConfidence(0.8);
  return Object.freeze({
    id: "lexicon:intent:Greeting:",
    producer: "lexicon",
    producerWeight: confidence,
    result: Object.freeze({
      type: "intent",
      intent: "Greeting",
      entities: Object.freeze([]),
      confidence,
      raw: "你好",
    }),
    concepts: Object.freeze([]),
    entities: Object.freeze([]),
    confidence,
    evidence: Object.freeze([
      Object.freeze({
        kind: "structural",
        key: evidenceKey,
        weight: confidence,
      }),
    ]),
    missingSlots: Object.freeze([]),
    sideEffect: "none",
  });
}
