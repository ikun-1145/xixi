/**
 * These tests exist to enforce, as an automated check rather than just a
 * design promise, the core requirement:
 *
 *   "人格不得影响推理结果、事实正确性或知识表示"
 *   (Personality must not affect reasoning results, factual correctness, or
 *   knowledge representation.)
 *
 * We assert this by rendering the SAME underlying data through two personas
 * with very different voices (Frost vs. Plain) and checking that the STYLE
 * differs while every FACT is preserved verbatim in both.
 */
import { describe, expect, it } from "vitest";
import { FrostPersonality } from "./frost";
import { PlainPersonality } from "./plain";
import {
  makeLearnedRecord,
  makeNoAnswerPlan,
  makeNoAnswerResult,
  makePlan,
  makeReasoningResult,
} from "./testFixtures";

describe("Personality boundary guarantee", () => {
  it("renders different styles for the same reasoning result, but both preserve the explanation", () => {
    const result = makeReasoningResult();
    const plan = makePlan({ explanation: result.explanation });

    const frostReply = FrostPersonality.respond({ kind: "reasoning-result", result, plan });
    const plainReply = PlainPersonality.respond({ kind: "reasoning-result", result, plan });

    expect(frostReply).not.toBe(plainReply); // style genuinely differs
    expect(frostReply).toContain(plan.explanation); // fact preserved
    expect(plainReply).toContain(plan.explanation); // fact preserved
  });

  it("preserves the explanation even when there is no answer", () => {
    const result = makeNoAnswerResult();
    const plan = makeNoAnswerPlan({ explanation: result.explanation });

    const frostReply = FrostPersonality.respond({ kind: "reasoning-result", result, plan });
    const plainReply = PlainPersonality.respond({ kind: "reasoning-result", result, plan });

    expect(frostReply).toContain(plan.explanation);
    expect(plainReply).toContain(plan.explanation);
  });

  it("both personas honor the SAME Response Planner strategy decision (mode/showEvidence/isUncertain), never their own", () => {
    const result = makeReasoningResult();
    const explainedPlan = makePlan({
      mode: "explained",
      showEvidence: true,
      isUncertain: true,
      explanation: "猫 属于 生物（推理路径：猫 → 动物 → 生物）",
    });

    const frostReply = FrostPersonality.respond({ kind: "reasoning-result", result, plan: explainedPlan });
    const plainReply = PlainPersonality.respond({ kind: "reasoning-result", result, plan: explainedPlan });

    for (const reply of [frostReply, plainReply]) {
      expect(reply).toContain("推理路径：猫 → 动物 → 生物"); // Evidence surfaced, as decided
      expect(reply).toMatch(/不确定|把握|推测|确认/); // uncertainty reflected, as decided
    }
  });

  it("preserves subject/relation/object/negation identically across personas", () => {
    const record = makeLearnedRecord({ negated: true, subject: "企鹅", relation: "会", object: "飞" });

    const frostReply = FrostPersonality.respond({ kind: "learned", record });
    const plainReply = PlainPersonality.respond({ kind: "learned", record });

    for (const reply of [frostReply, plainReply]) {
      expect(reply).toContain("企鹅");
      expect(reply).toContain("飞");
      expect(reply).toContain("不会"); // negation preserved, not dropped or inverted
    }
  });

  it("preserves a remembered name identically across personas", () => {
    const frostReply = FrostPersonality.respond({ kind: "remembered", key: "name", value: "刘锡泽" });
    const plainReply = PlainPersonality.respond({ kind: "remembered", key: "name", value: "刘锡泽" });

    expect(frostReply).not.toBe(plainReply);
    expect(frostReply).toContain("刘锡泽");
    expect(plainReply).toContain("刘锡泽");
  });
});
