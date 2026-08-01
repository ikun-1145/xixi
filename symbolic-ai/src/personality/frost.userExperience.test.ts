import { describe, expect, it } from "vitest";
import { createSunlandEngine } from "@/sdk";
import { FrostPersonality } from "./frost";

const INTERNAL_TERMS =
  /parser|semantic|reasoner|candidate|confidence|reasoncodes|diagnostics|语法规则|知识图谱/iu;
const FROST_ACCENT = /[🐾✨]/gu;
const ANY_EMOJI = /\p{Extended_Pictographic}/u;
const FORBIDDEN_PERSONA_LANGUAGE =
  /嗷|喵|主人|人家|永远|永久|都会记得|模型训练|微调/u;

function countFrostAccents(reply: string): number {
  return reply.match(FROST_ACCENT)?.length ?? 0;
}

describe("Frost user-facing response experience", () => {
  it("introduces Sunland naturally and offers concrete ways to start", () => {
    const engine = createSunlandEngine();

    const reply = engine.respond("你好");

    expect(reply).toContain("霜蓝");
    expect(reply).toContain("Sunland AI");
    expect(reply).toMatch(/聊|问/);
    expect(reply).toMatch(/教|信息|知识/);
    expect(reply).not.toMatch(INTERNAL_TERMS);
    expect(reply).not.toMatch(/通用大模型|真人/);
  });

  it("answers identity and capability questions without implementation jargon", () => {
    const engine = createSunlandEngine();

    const identity = engine.respond("你是谁");
    const capability = engine.respond("你能做什么");

    expect(identity).toContain("霜蓝");
    expect(identity).toContain("Sunland AI");
    expect(identity.indexOf("霜蓝")).toBeLessThan(identity.indexOf("Sunland AI"));
    expect(identity).toMatch(/学习|信息|知识/);
    expect(capability).toMatch(/记住|回答|推理/);
    expect(identity).not.toMatch(INTERNAL_TERMS);
    expect(capability).not.toMatch(INTERNAL_TERMS);
    expect(capability).not.toContain("教给它");
    expect(identity).not.toMatch(/Parser|Semantic|Reasoner/);
  });

  it("turns unknown input into a calm invitation to add context", () => {
    const engine = createSunlandEngine();

    const reply = engine.respond("完全未知的表达 🐾");

    expect(reply).toMatch(/背景|相关信息|换.*说法/);
    expect(reply).not.toMatch(/没理解清楚|程序|失败|错误/);
    expect(reply).not.toMatch(INTERNAL_TERMS);
  });

  it("keeps a no-answer query constructive instead of presenting a failure", () => {
    const engine = createSunlandEngine();

    const reply = engine.respond("星尘兽会什么");

    expect(reply).toMatch(/补充|告诉我|换一种方式/);
    expect(reply).not.toMatch(/抱歉|失败|错误|没理解清楚/);
    expect(reply).not.toMatch(INTERNAL_TERMS);
  });

  it("confirms teaching as user knowledge without implying model training", () => {
    const engine = createSunlandEngine();

    const reply = engine.respond("猫属于动物");

    expect(reply).toContain("猫 属于 动物");
    expect(reply).toContain("你的知识库");
    expect(reply).toMatch(/以后|之后|下次/);
    expect(reply).not.toMatch(/训练|微调|数据库|已学习：/);
    expect(
      engine.knowledgeStore.has({
        subject: "猫",
        relation: "属于",
        object: "动物",
        negated: false,
      }),
    ).toBe(true);
  });

  it("uses deterministic accents on no more than one third of 64 daily turns", () => {
    const replies = Array.from({ length: 64 }, (_, index) => {
      const socialTurns = ["greeting", "thanks", "farewell"] as const;
      const kind = socialTurns[index % socialTurns.length]!;
      return FrostPersonality.respond({ kind, raw: `日常互动-${index}` });
    });
    const repeated = FrostPersonality.respond({
      kind: "greeting",
      raw: "日常互动-0",
    });
    const accentCount = replies.reduce(
      (total, reply) => total + countFrostAccents(reply),
      0,
    );

    expect(repeated).toBe(replies[0]);
    expect(accentCount).toBeGreaterThan(0);
    expect(accentCount).toBeLessThanOrEqual(Math.floor(64 / 3));
    for (const reply of replies) {
      expect(countFrostAccents(reply)).toBeLessThanOrEqual(1);
      expect(reply.match(/[啦呢]/gu)?.length ?? 0).toBeLessThanOrEqual(1);
    }
  });

  it("keeps factual, teaching, unknown, identity, capability and error replies emoji-free", () => {
    const engine = createSunlandEngine();
    const teaching = engine.respond("HTTP属于协议");
    const factual = engine.respond("HTTP属于什么");
    const explained = engine.respond("HTTP为什么属于协议");
    const unknown = engine.respond("一段完全未知的表达");
    const identity = engine.respond("你是谁");
    const capability = engine.respond("你能做什么");
    const error = FrostPersonality.respond({
      kind: "error",
      message: "仅供测试的内部错误",
    });
    const clarification = FrostPersonality.respond({
      kind: "clarification",
      plan: {
        clarificationKind: "missing-object",
        focus: "object",
        candidateLabels: ["query"],
        reasonCategory: "missing-information",
        relation: "会",
      },
    });

    for (const reply of [
      teaching,
      factual,
      explained,
      unknown,
      identity,
      capability,
      error,
      clarification,
    ]) {
      expect(reply).not.toMatch(ANY_EMOJI);
    }
  });

  it("uses correction-safe teaching wording and preserves the complete fact", () => {
    const engine = createSunlandEngine();
    engine.respond("星尘兽属于幻想生物");

    const reply = engine.respond("星尘兽属于原创兽设");

    expect(reply).toContain("星尘兽 属于 原创兽设");
    expect(reply).toContain("知识库");
    expect(reply).not.toMatch(/已覆盖|已替换|覆盖旧知识|训练|微调|永久|永远/u);
  });

  it("keeps name memory truthful, scoped and verbatim", () => {
    const engine = createSunlandEngine();
    const remembered = engine.respond("我叫阿澈");
    const recalled = engine.respond("我叫什么");

    expect(remembered).toContain("阿澈");
    expect(remembered).toMatch(/账号|聊天|记忆/);
    expect(recalled).toContain("阿澈");
    expect([remembered, recalled].join("\n")).not.toMatch(
      /永远|永久|都会记得|认得你/u,
    );
  });

  it("keeps representative replies free of exaggerated or false persona claims", () => {
    const engine = createSunlandEngine();
    const replies = [
      engine.respond("你好"),
      engine.respond("谢谢"),
      engine.respond("再见"),
      engine.respond("你是谁"),
      engine.respond("你能做什么"),
      engine.respond("云尾兽属于原创兽设"),
      engine.respond("云尾兽属于什么"),
      engine.respond("没有对应知识的问题"),
      engine.respond("我叫阿澈"),
      engine.respond("我叫什么"),
      FrostPersonality.respond({ kind: "error", message: "测试错误" }),
    ];

    for (const reply of replies) {
      expect(reply).not.toMatch(FORBIDDEN_PERSONA_LANGUAGE);
    }
  });

  it("answers directly by default and shows evidence only when asked why", () => {
    const engine = createSunlandEngine();
    engine.respond("猫属于动物");
    engine.respond("动物属于生物");

    const direct = engine.respond("猫属于什么");
    const explained = engine.respond("猫为什么属于生物");

    expect(direct).toContain("生物");
    expect(direct).not.toContain("推理路径");
    expect(direct).not.toMatch(/让我查一下|这个问题我有答案|推理出来的结论/);
    expect(explained).toContain("推理路径：猫 → 动物 → 生物");
  });
});
