import { describe, expect, it } from "vitest";
import {
  applySemanticContextUpdate,
  createEmptySemanticContext,
  createSunlandEngine,
} from "./sdk";

const INTERNAL_TERMS =
  /parser|intent|candidate|confidence|reasoncodes|diagnostics|relation-alignment|policyid|语法规则/iu;

describe("Sunland Core public SDK contract", () => {
  it("Greeting: returns a user-facing reply through the public engine", () => {
    const engine = createSunlandEngine();

    const reply = engine.respond("你好");

    expect(reply.trim().length).toBeGreaterThan(0);
    expect(reply).not.toMatch(INTERNAL_TERMS);
  });

  it("Identity: answers from Core identity without mutating user knowledge", () => {
    const engine = createSunlandEngine();

    const reply = engine.respond("你是谁");

    expect(reply).toContain("Sunland AI");
    expect(engine.knowledgeStore.all()).toEqual([]);
  });

  it("Memory: remembers and recalls a user-provided name", () => {
    const engine = createSunlandEngine({ personalityId: "plain" });

    engine.respond("我叫小蓝");
    const reply = engine.respond("我叫什么");

    expect(reply).toContain("小蓝");
    expect(engine.memory.recall("name")?.value).toBe("小蓝");
    expect(engine.knowledgeStore.all()).toEqual([]);
  });

  it("Knowledge teaching: stores and answers an explicit triple", () => {
    const engine = createSunlandEngine({ personalityId: "plain" });

    engine.respond("猫属于动物");

    expect(
      engine.knowledgeStore.has({
        subject: "猫",
        relation: "属于",
        object: "动物",
        negated: false,
      }),
    ).toBe(true);
    expect(engine.respond("猫属于什么")).toContain("动物");
  });

  it("Relation fallback: uses a compatible known relation without writing", () => {
    const engine = createSunlandEngine({ personalityId: "plain" });
    engine.respond("猫属于动物");
    const before = engine.knowledgeStore.all();

    const reply = engine.respond("猫是什么");

    expect(reply).toContain("动物");
    expect(reply).not.toMatch(INTERNAL_TERMS);
    expect(engine.knowledgeStore.all()).toEqual(before);
  });

  it("Context follow-up: resolves a pronoun from caller-owned context", () => {
    const engine = createSunlandEngine({
      personalityId: "plain",
      semanticContextMode: "enabled",
    });
    engine.respond("猫会爬树");
    let context = createEmptySemanticContext();

    const first = engine.process("猫是什么", {
      semanticContext: context,
      turnId: "contract-turn-1",
    });
    context = applySemanticContextUpdate(
      context,
      first.semanticContextUpdate,
    );
    const followUp = engine.process("它会什么", {
      semanticContext: context,
      turnId: "contract-turn-2",
    });

    expect(followUp.response).toContain("爬树");
    expect(followUp.response).not.toMatch(INTERNAL_TERMS);
  });

  it("Safety boundary: unsafe side-effect inputs cannot mutate Core state", () => {
    const engine = createSunlandEngine({ personalityId: "plain" });

    const nameReply = engine.respond("不要记住我叫小明");
    const teachingReply = engine.respond("猫会飞还是会游泳");

    expect(engine.memory.list()).toEqual([]);
    expect(engine.knowledgeStore.all()).toEqual([]);
    expect(nameReply.trim().length).toBeGreaterThan(0);
    expect(teachingReply.trim().length).toBeGreaterThan(0);
    expect(nameReply).not.toMatch(INTERNAL_TERMS);
    expect(teachingReply).not.toMatch(INTERNAL_TERMS);
  });
});
