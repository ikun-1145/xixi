import { describe, expect, it } from "vitest";
import { createSunlandEngine } from "@/sdk";

const INTERNAL_TERMS =
  /parser|semantic|reasoner|candidate|confidence|reasoncodes|diagnostics|语法规则|知识图谱/iu;

describe("Frost user-facing response experience", () => {
  it("introduces Sunland naturally and offers concrete ways to start", () => {
    const engine = createSunlandEngine();

    const reply = engine.respond("你好");

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

    expect(identity).toContain("Sunland AI");
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
