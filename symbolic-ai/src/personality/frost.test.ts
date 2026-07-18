import { describe, expect, it } from "vitest";
import { FrostPersonality } from "./frost";
import { FROST_EMOJI } from "./frostPhrases";
import {
  makeLearnedRecord,
  makeNoAnswerPlan,
  makeNoAnswerResult,
  makeParseFailure,
  makePlan,
  makeReasoningResult,
} from "./testFixtures";

function countPaletteEmoji(text: string): number {
  return [...text].filter((char) => (FROST_EMOJI as readonly string[]).includes(char)).length;
}

describe("FrostPersonality", () => {
  it("has stable identity metadata and is the default persona", () => {
    expect(FrostPersonality.id).toBe("frost");
    expect(FrostPersonality.displayName).toContain("Frost");
  });

  describe("reasoning-result — has an answer", () => {
    const result = makeReasoningResult();
    const plan = makePlan({ explanation: result.explanation });

    it("embeds the Response Planner's explanation verbatim (facts are never rewritten)", () => {
      const reply = FrostPersonality.respond({ kind: "reasoning-result", result, plan });
      expect(reply).toContain(plan.explanation);
    });

    it("uses at most one emoji from the approved palette", () => {
      const reply = FrostPersonality.respond({ kind: "reasoning-result", result, plan });
      expect(countPaletteEmoji(reply)).toBeLessThanOrEqual(1);
    });

    it("only ever uses emoji from the approved palette (✨🌸🐾💙)", () => {
      const reply = FrostPersonality.respond({ kind: "reasoning-result", result, plan });
      const emojiInReply = [...reply].filter((char) => /\p{Extended_Pictographic}/u.test(char));
      for (const char of emojiInReply) {
        expect(FROST_EMOJI as readonly string[]).toContain(char);
      }
    });

    it("is deterministic for the same input", () => {
      const a = FrostPersonality.respond({ kind: "reasoning-result", result, plan });
      const b = FrostPersonality.respond({ kind: "reasoning-result", result, plan });
      expect(a).toBe(b);
    });
  });

  describe("reasoning-result — no answer", () => {
    const result = makeNoAnswerResult();
    const plan = makeNoAnswerPlan({ explanation: result.explanation });

    it("still embeds the explanation verbatim", () => {
      const reply = FrostPersonality.respond({ kind: "reasoning-result", result, plan });
      expect(reply).toContain(plan.explanation);
    });

    it("gently invites the user to teach it, without baby-talk", () => {
      const reply = FrostPersonality.respond({ kind: "reasoning-result", result, plan });
      expect(reply).toMatch(/教|告诉我/);
      expect(reply).not.toMatch(/人家|呢～～|啦啦啦/);
    });
  });

  describe("reasoning-result — Response Planner strategy (Stage 7)", () => {
    it("shows no derivation chain when the Planner decided a 'direct' answer", () => {
      const result = makeReasoningResult();
      const plan = makePlan({ mode: "direct", showEvidence: false, explanation: "猫 属于 哺乳动物" });
      const reply = FrostPersonality.respond({ kind: "reasoning-result", result, plan });
      expect(reply).toContain("猫 属于 哺乳动物");
      expect(reply).not.toContain("推理路径");
    });

    it("surfaces the Evidence (derivation chain) when the Planner decided 'explained'", () => {
      const result = makeReasoningResult();
      const plan = makePlan({
        mode: "explained",
        showEvidence: true,
        explanation: "猫 属于 生物（推理路径：猫 → 动物 → 生物）",
      });
      const reply = FrostPersonality.respond({ kind: "reasoning-result", result, plan });
      expect(reply).toContain("推理路径：猫 → 动物 → 生物");
    });

    it("adds a natural hedge when the Planner flags the answer as uncertain", () => {
      const result = makeReasoningResult();
      const plan = makePlan({ isUncertain: true, confidence: 0.4 });
      const reply = FrostPersonality.respond({ kind: "reasoning-result", result, plan });
      expect(reply).toMatch(/不确定|把握|推测|确认/);
    });

    it("does not hedge when the Planner did not flag uncertainty", () => {
      const result = makeReasoningResult();
      const plan = makePlan({ isUncertain: false });
      const reply = FrostPersonality.respond({ kind: "reasoning-result", result, plan });
      expect(reply).not.toMatch(/不是很有把握|没有十足的信心|只是我的推测/);
    });

    it("never invents a fact/confidence/evidence decision itself -- everything comes from `plan`", () => {
      // Same `result` (same raw Reasoner output), two different Planner
      // decisions -> two different replies. Frost has no say in this.
      const result = makeReasoningResult();
      const direct = FrostPersonality.respond({
        kind: "reasoning-result",
        result,
        plan: makePlan({ mode: "direct", showEvidence: false, explanation: "猫 属于 哺乳动物" }),
      });
      const explained = FrostPersonality.respond({
        kind: "reasoning-result",
        result,
        plan: makePlan({
          mode: "explained",
          showEvidence: true,
          explanation: "猫 属于 哺乳动物（推理路径：猫 → 哺乳动物）",
        }),
      });
      expect(direct).not.toBe(explained);
    });
  });

  describe("learned", () => {
    it("embeds subject/relation/object verbatim", () => {
      const record = makeLearnedRecord();
      const reply = FrostPersonality.respond({ kind: "learned", record });
      expect(reply).toContain(record.subject);
      expect(reply).toContain(record.relation);
      expect(reply).toContain(record.object);
    });

    it("marks negation with '不' when the record is negated", () => {
      const record = makeLearnedRecord({ negated: true, subject: "企鹅", relation: "会", object: "飞" });
      const reply = FrostPersonality.respond({ kind: "learned", record });
      expect(reply).toContain("不会");
    });
  });

  describe("unknown-input", () => {
    const failure = makeParseFailure();

    it("surfaces the parser's reason for transparency", () => {
      const reply = FrostPersonality.respond({ kind: "unknown-input", failure });
      expect(reply).toContain(failure.reason);
    });

    it("suggests a supported sentence pattern", () => {
      const reply = FrostPersonality.respond({ kind: "unknown-input", failure });
      expect(reply).toMatch(/属于|例如|试试/);
    });
  });

  describe("greeting", () => {
    it("returns a non-empty, friendly line", () => {
      const reply = FrostPersonality.respond({ kind: "greeting" });
      expect(reply.length).toBeGreaterThan(0);
    });

    it("varies its phrasing depending on what the user actually typed", () => {
      const a = FrostPersonality.respond({ kind: "greeting", raw: "你好" });
      const b = FrostPersonality.respond({ kind: "greeting", raw: "嗨" });
      // Not asserting a specific pair differs (hash collisions are allowed),
      // just that this isn't ONE hardcoded sentence for every input: at
      // least one of several distinct raw inputs should pick a different line.
      const c = FrostPersonality.respond({ kind: "greeting", raw: "Hello" });
      const distinctCount = new Set([a, b, c].map((r) => r.replace(/\s*\S+$/, ""))).size;
      expect(distinctCount).toBeGreaterThan(1);
    });

    it("is still deterministic for the exact same raw input", () => {
      const first = FrostPersonality.respond({ kind: "greeting", raw: "你好" });
      const second = FrostPersonality.respond({ kind: "greeting", raw: "你好" });
      expect(first).toBe(second);
    });
  });

  describe("thanks", () => {
    it("returns a non-empty, friendly line", () => {
      const reply = FrostPersonality.respond({ kind: "thanks" });
      expect(reply.length).toBeGreaterThan(0);
    });
  });

  describe("farewell", () => {
    it("returns a non-empty, friendly line", () => {
      const reply = FrostPersonality.respond({ kind: "farewell" });
      expect(reply.length).toBeGreaterThan(0);
    });
  });

  describe("identity", () => {
    it("embeds the retrieved fact verbatim for the 'identity' aspect", () => {
      const facts = [
        makeLearnedRecord({ subject: "Sunland AI", relation: "是", object: "一个符号推理AI系统" }),
      ];
      const reply = FrostPersonality.respond({
        kind: "identity",
        aspect: "identity",
        subject: "Sunland AI",
        facts,
      });
      expect(reply).toContain("Sunland AI");
      expect(reply).toContain("一个符号推理AI系统");
    });

    it("lists every capability fact for the 'capability' aspect", () => {
      const facts = [
        makeLearnedRecord({ subject: "Sunland AI", relation: "会", object: "记住知识" }),
        makeLearnedRecord({ subject: "Sunland AI", relation: "会", object: "做推理" }),
      ];
      const reply = FrostPersonality.respond({
        kind: "identity",
        aspect: "capability",
        subject: "Sunland AI",
        facts,
      });
      expect(reply).toContain("记住知识");
      expect(reply).toContain("做推理");
    });

    it("embeds the creator fact for the 'creator' aspect", () => {
      const facts = [makeLearnedRecord({ subject: "Sunland AI", relation: "开发者", object: "一名独立开发者" })];
      const reply = FrostPersonality.respond({
        kind: "identity",
        aspect: "creator",
        subject: "Sunland AI",
        facts,
      });
      expect(reply).toContain("一名独立开发者");
    });

    it("degrades gracefully (non-throwing, non-empty) when nothing is known", () => {
      const reply = FrostPersonality.respond({
        kind: "identity",
        aspect: "identity",
        subject: "未知实体",
        facts: [],
      });
      expect(typeof reply).toBe("string");
      expect(reply.length).toBeGreaterThan(0);
    });

    it("is deterministic for the same input", () => {
      const facts = [makeLearnedRecord({ subject: "霜蓝", relation: "是", object: "默认人格" })];
      const a = FrostPersonality.respond({ kind: "identity", aspect: "identity", subject: "霜蓝", facts, raw: "霜蓝是谁" });
      const b = FrostPersonality.respond({ kind: "identity", aspect: "identity", subject: "霜蓝", facts, raw: "霜蓝是谁" });
      expect(a).toBe(b);
    });
  });

  describe("remembered", () => {
    it("embeds the remembered name verbatim, warmly, with no technical vocabulary", () => {
      const reply = FrostPersonality.respond({ kind: "remembered", key: "name", value: "刘锡泽" });
      expect(reply).toContain("刘锡泽");
      expect(reply).not.toMatch(/数据库|字段|MemoryManager|存储/);
    });

    it("falls back to a generic warm frame for a non-name key", () => {
      const reply = FrostPersonality.respond({ kind: "remembered", key: "favoriteColor", value: "蓝色" });
      expect(reply).toContain("蓝色");
    });

    it("is deterministic for the same input", () => {
      const a = FrostPersonality.respond({ kind: "remembered", key: "name", value: "刘锡泽", raw: "我叫刘锡泽" });
      const b = FrostPersonality.respond({ kind: "remembered", key: "name", value: "刘锡泽", raw: "我叫刘锡泽" });
      expect(a).toBe(b);
    });
  });

  describe("recalled", () => {
    it("embeds the recalled name verbatim when known", () => {
      const reply = FrostPersonality.respond({ kind: "recalled", key: "name", value: "刘锡泽" });
      expect(reply).toContain("刘锡泽");
    });

    it("uses the exact required fallback line when the name is not yet known", () => {
      // The exact phrasing required by spec is one of a small set of natural
      // variations (see `NAME_RECALL_NOT_FOUND_LINES`); which one is picked
      // is deterministic by seed, not necessarily the first for every seed.
      // Passing the ACTUAL raw phrasing the user asked with (as the engine
      // does) reproduces the spec's exact required line.
      const reply = FrostPersonality.respond({ kind: "recalled", key: "name", value: null, raw: "我叫什么" });
      expect(reply).toContain("目前你还没有告诉我你的名字。");
    });

    it("degrades gracefully (non-throwing, non-empty) for a non-name key with no value", () => {
      const reply = FrostPersonality.respond({ kind: "recalled", key: "favoriteColor", value: null });
      expect(typeof reply).toBe("string");
      expect(reply.length).toBeGreaterThan(0);
    });

    it("never surfaces technical vocabulary", () => {
      const reply = FrostPersonality.respond({ kind: "recalled", key: "name", value: null });
      expect(reply).not.toMatch(/数据库|字段|MemoryManager|存储/);
    });
  });

  describe("error", () => {
    it("stays plain and professional, embedding the message verbatim", () => {
      const reply = FrostPersonality.respond({ kind: "error", message: "数据库连接失败" });
      expect(reply).toBe("抱歉，出了点问题：数据库连接失败");
    });

    it("never decorates errors with emoji (clarity over charm)", () => {
      const reply = FrostPersonality.respond({ kind: "error", message: "数据库连接失败" });
      expect(countPaletteEmoji(reply)).toBe(0);
    });
  });
});
