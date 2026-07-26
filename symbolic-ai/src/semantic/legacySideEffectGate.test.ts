import { describe, expect, it } from "vitest";
import { createParser } from "@/parser";
import type { ParseResult } from "@/types";
import { analyzeSemanticInput } from "./candidates";
import { evaluateLegacySideEffectFallback } from "./legacySideEffectGate";
import { planUnderstanding } from "./understandingPlanner";

function admissionFor(
  input: string,
  legacyResult: ParseResult = createParser().parse(input),
) {
  const analysis = analyzeSemanticInput(input);
  const decision = planUnderstanding(analysis);
  return evaluateLegacySideEffectFallback(
    decision,
    legacyResult,
    analysis,
  );
}

describe("Legacy side-effect admission gate", () => {
  it.each([
    "我叫小明",
    "你可以叫我霜蓝",
    "我的名字是 Alice Chen",
    "猫属于动物",
    "鸟有翅膀",
    "霜蓝指的是我的角色名",
  ])("admits one Semantic-confirmed Legacy write for '%s'", (input) => {
    expect(admissionFor(input)).toEqual({
      kind: "allow-legacy-side-effect",
      reason: "semantic-side-effect-confirmed",
    });
  });

  it("lets ordinary passive Legacy results continue unchanged", () => {
    expect(admissionFor("谢谢你")).toEqual({
      kind: "allow-passive-legacy",
      reason: "not-a-side-effect",
    });
  });

  it.each([
    "猫会飞还是会游泳",
    "鸟有没有翅膀",
    "猫是不是动物",
    "不要记住我叫小明",
    "我叫小明，猫属于动物",
  ])("blocks a write-shaped Legacy result for unsafe input '%s'", (input) => {
    const forcedLegacy: ParseResult = input.includes("叫")
      ? {
          type: "intent",
          intent: "RememberName",
          entities: ["小明"],
          confidence: 0.95,
          raw: input,
        }
      : {
          type: "statement",
          subject: "猫",
          relation: "会",
          object: "飞",
          negated: false,
          raw: input,
        };

    expect(admissionFor(input, forcedLegacy).kind).not.toBe(
      "allow-legacy-side-effect",
    );
  });

  it("rejects a Legacy name that disagrees with Semantic extraction", () => {
    expect(
      admissionFor("我叫小明", {
        type: "intent",
        intent: "RememberName",
        entities: ["小红"],
        confidence: 0.95,
        raw: "我叫小明",
      }),
    ).toEqual({
      kind: "reject",
      reason: "side-effect-interpretation-mismatch",
    });
  });

  it("rejects a Legacy triple that disagrees with Semantic extraction", () => {
    expect(
      admissionFor("猫属于动物", {
        type: "statement",
        subject: "猫",
        relation: "属于",
        object: "植物",
        negated: false,
        raw: "猫属于动物",
      }),
    ).toEqual({
      kind: "reject",
      reason: "side-effect-interpretation-mismatch",
    });
  });
});
