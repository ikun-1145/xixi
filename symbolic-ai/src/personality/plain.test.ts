import { describe, expect, it } from "vitest";
import { PlainPersonality } from "./plain";
import { FROST_EMOJI } from "./frostPhrases";
import { makeLearnedRecord, makeParseFailure, makePlan, makeReasoningResult } from "./testFixtures";

describe("PlainPersonality (baseline, no styling)", () => {
  it("returns the Response Planner's explanation with zero decoration", () => {
    const result = makeReasoningResult();
    const plan = makePlan({ explanation: result.explanation });
    const reply = PlainPersonality.respond({ kind: "reasoning-result", result, plan });
    expect(reply).toBe(plan.explanation);
  });

  it("marks uncertainty with a plain, undecorated suffix (no natural-language hedge)", () => {
    const result = makeReasoningResult();
    const plan = makePlan({ isUncertain: true, explanation: "猫 属于 哺乳动物" });
    const reply = PlainPersonality.respond({ kind: "reasoning-result", result, plan });
    expect(reply).toBe("猫 属于 哺乳动物（不确定）");
  });

  it("never emits any palette emoji", () => {
    const record = makeLearnedRecord();
    const reply = PlainPersonality.respond({ kind: "learned", record });
    expect([...reply].some((char) => (FROST_EMOJI as readonly string[]).includes(char))).toBe(false);
  });

  it("surfaces raw input and reason for unknown input", () => {
    const failure = makeParseFailure();
    const reply = PlainPersonality.respond({ kind: "unknown-input", failure });
    expect(reply).toContain(failure.raw);
    expect(reply).toContain(failure.reason);
  });

  it("returns a fixed, undecorated greeting", () => {
    expect(PlainPersonality.respond({ kind: "greeting" })).toBe("你好。");
  });

  it("returns a fixed, undecorated thanks reply", () => {
    expect(PlainPersonality.respond({ kind: "thanks" })).toBe("不客气。");
  });

  it("returns a fixed, undecorated farewell", () => {
    expect(PlainPersonality.respond({ kind: "farewell" })).toBe("再见。");
  });

  it("renders an identity fact plainly, verbatim", () => {
    const record = makeLearnedRecord({ subject: "Sunland AI", relation: "是", object: "一个符号推理AI系统" });
    const reply = PlainPersonality.respond({
      kind: "identity",
      aspect: "identity",
      subject: "Sunland AI",
      facts: [record],
    });
    expect(reply).toBe("Sunland AI 是 一个符号推理AI系统");
  });

  it("degrades gracefully when no identity facts are known", () => {
    const reply = PlainPersonality.respond({
      kind: "identity",
      aspect: "creator",
      subject: "Sunland AI",
      facts: [],
    });
    expect(typeof reply).toBe("string");
    expect(reply.length).toBeGreaterThan(0);
  });

  it("renders a remembered fact plainly, verbatim", () => {
    const reply = PlainPersonality.respond({ kind: "remembered", key: "name", value: "刘锡泽" });
    expect(reply).toBe("已记住：name = 刘锡泽");
  });

  it("renders a recalled fact plainly, verbatim, when known", () => {
    const reply = PlainPersonality.respond({ kind: "recalled", key: "name", value: "刘锡泽" });
    expect(reply).toBe("name = 刘锡泽");
  });

  it("renders an undecorated fallback for a recalled fact that is unknown", () => {
    const reply = PlainPersonality.respond({ kind: "recalled", key: "name", value: null });
    expect(reply).toBe("未知：name");
  });
});
