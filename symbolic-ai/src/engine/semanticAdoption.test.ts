import { describe, expect, it, vi } from "vitest";
import { createUnderstandingPolicy } from "@/semantic";
import { createSunlandEngine } from "./sunlandEngine";

const INTERNAL_TERMS =
  /parser|intent|candidate|confidence|syntax|rule|reasoncodes|diagnostics|语法规则|推理失败/iu;

describe("SunlandEngine Semantic Understanding Stage 8.5A", () => {
  it("keeps semanticMode=off behavior on the legacy path and never runs Semantic", () => {
    const analyze = vi.fn(() => {
      throw new Error("must not run");
    });
    const engine = createSunlandEngine({
      personalityId: "plain",
      semanticMode: "off",
      semanticRuntime: { analyze },
    });

    expect(engine.respond("你会吗")).toContain("没理解清楚");
    expect(analyze).not.toHaveBeenCalled();
    expect(engine.semanticMode).toBe("off");
    expect(engine.getLastSemanticShadow()).toBeNull();
  });

  it("keeps shadow output identical to off while retaining a safe comparison only in debug mode", () => {
    const off = createSunlandEngine({
      personalityId: "plain",
      semanticMode: "off",
    });
    const shadow = createSunlandEngine({
      personalityId: "plain",
      semanticMode: "shadow",
      semanticDebug: true,
    });

    expect(shadow.respond("你会吗")).toBe(off.respond("你会吗"));
    expect(shadow.getLastSemanticShadow()).toMatchObject({
      mode: "shadow",
      legacyType: "unknown",
      decisionType: "clarify",
      semanticAdopted: false,
      fellBackToLegacy: true,
      semanticError: false,
    });
  });

  it("defaults the Core engine to passive mode without retaining diagnostics", () => {
    const engine = createSunlandEngine();

    expect(engine.semanticMode).toBe("passive");
    engine.respond("你好");
    expect(engine.getLastSemanticShadow()).toBeNull();
  });

  it("passively adopts Greeting", () => {
    const engine = createSunlandEngine({
      semanticMode: "passive",
      semanticDebug: true,
    });

    const reply = engine.respond("你好");
    expect(reply.length).toBeGreaterThan(0);
    expect(engine.getLastSemanticShadow()).toMatchObject({
      adapterKind: "adopt",
      selectedCandidateType: "intent",
      semanticAdopted: true,
      fellBackToLegacy: false,
    });
    expect(engine.getLastSemanticShadow()?.selectedCandidateId).toContain(
      "Greeting",
    );
  });

  it("passively adopts Identity without touching user Knowledge", () => {
    const engine = createSunlandEngine({
      semanticMode: "passive",
      semanticDebug: true,
    });

    expect(engine.respond("你叫啥呀")).toContain("Sunland AI");
    expect(engine.knowledgeStore.all()).toEqual([]);
    expect(engine.getLastSemanticShadow()?.selectedCandidateId).toContain(
      "Identity",
    );
  });

  it("passively adopts RecallName as a read-only operation", () => {
    const engine = createSunlandEngine({
      semanticMode: "passive",
      semanticDebug: true,
    });
    engine.respond("我叫小明");
    const before = engine.memory.list();

    expect(engine.respond("你记得我的名字吗")).toContain("小明");
    expect(engine.memory.list()).toEqual(before);
    expect(engine.getLastSemanticShadow()).toMatchObject({
      adapterKind: "adopt",
      semanticAdopted: true,
    });
    expect(engine.getLastSemanticShadow()?.selectedCandidateId).toContain(
      "RecallName",
    );
  });

  it("passively adopts a complete semantic Query through the existing Reasoner", () => {
    const engine = createSunlandEngine({
      personalityId: "plain",
      semanticMode: "passive",
      semanticDebug: true,
    });
    engine.knowledgeStore.add(
      {
        subject: "鸟",
        relation: "有",
        object: "翅膀",
        negated: false,
      },
      { source: "user" },
    );

    expect(engine.respond("鸟有什么")).toContain("翅膀");
    expect(engine.getLastSemanticShadow()).toMatchObject({
      legacyType: "unknown",
      selectedCandidateType: "query",
      adapterKind: "adopt",
      semanticAdopted: true,
    });
  });

  it("turns '你会吗' into a real clarification without writing Knowledge", () => {
    const engine = createSunlandEngine({
      semanticMode: "passive",
      semanticDebug: true,
    });

    const reply = engine.respond("你会吗");
    expect(reply).toContain("会做什么");
    expect(engine.knowledgeStore.all()).toEqual([]);
    expect(engine.getLastSemanticShadow()).toMatchObject({
      legacyType: "unknown",
      decisionType: "clarify",
      adapterKind: "clarification",
      semanticAdopted: true,
    });
  });

  it("turns '猫是' into a missing-object clarification", () => {
    const engine = createSunlandEngine({
      personalityId: "plain",
      semanticMode: "passive",
      semanticDebug: true,
    });

    expect(engine.respond("猫是")).toContain("缺少要说明的内容");
    expect(engine.knowledgeStore.all()).toEqual([]);
    expect(engine.getLastSemanticShadow()).toMatchObject({
      decisionType: "clarify",
      adapterKind: "clarification",
    });
  });

  it("keeps compound queries structured as clarification instead of silently choosing one", () => {
    const engine = createSunlandEngine({
      semanticMode: "passive",
      semanticDebug: true,
    });

    const reply = engine.respond("你叫什么和你会什么");
    expect(reply).toMatch(/名字.*能力|能力.*名字/);
    expect(engine.getLastSemanticShadow()).toMatchObject({
      decisionType: "clarify",
      adapterKind: "clarification",
    });
  });

  it("falls back when a passive semantic result conflicts with a valid legacy result", () => {
    const engine = createSunlandEngine({
      personalityId: "plain",
      semanticMode: "passive",
      semanticDebug: true,
      parser: {
        parse(input) {
          return {
            type: "intent",
            intent: "Thanks",
            entities: [],
            confidence: 1,
            raw: input,
          };
        },
      },
    });

    expect(engine.respond("你好")).toBe("不客气。");
    expect(engine.getLastSemanticShadow()).toMatchObject({
      decisionType: "accept",
      adapterKind: "fallback-legacy",
      equivalentToLegacy: false,
      semanticAdopted: false,
    });
  });

  it("honors a policy that withholds passive adoption", () => {
    const engine = createSunlandEngine({
      personalityId: "plain",
      semanticMode: "passive",
      semanticDebug: true,
      understandingPolicy: createUnderstandingPolicy({
        passiveIntentAcceptThreshold: 1,
      }),
    });

    expect(engine.respond("你好")).toBe("你好。");
    expect(engine.getLastSemanticShadow()).toMatchObject({
      decisionType: "no-understanding",
      adapterKind: "fallback-legacy",
      semanticAdopted: false,
    });
  });

  it("returns the existing natural fallback for completely unknown input", () => {
    const engine = createSunlandEngine({
      personalityId: "plain",
      semanticMode: "passive",
      semanticDebug: true,
    });

    const reply = engine.respond("完全未知的表达 🐾");
    expect(reply).toBe(
      "这个问题我暂时还没理解清楚。你可以换一种说法，或者再告诉我一点相关信息。",
    );
    expect(reply).not.toMatch(INTERNAL_TERMS);
    expect(engine.getLastSemanticShadow()).toMatchObject({
      decisionType: "no-understanding",
      adapterKind: "no-understanding",
      semanticAdopted: true,
    });
  });

  it("keeps RememberName on the legacy write path", () => {
    const engine = createSunlandEngine({
      semanticMode: "passive",
      semanticDebug: true,
    });

    expect(engine.respond("我叫小明")).toContain("小明");
    expect(engine.memory.recall("name")?.value).toBe("小明");
    expect(engine.knowledgeStore.all()).toEqual([]);
    expect(engine.getLastSemanticShadow()).toMatchObject({
      adapterKind: "fallback-legacy",
      semanticAdopted: false,
      fellBackToLegacy: true,
    });
  });

  it.each([
    ["我叫小明", "小明"],
    ["你可以叫我霜蓝", "霜蓝"],
    ["我的名字是 Alice Chen", "Alice Chen"],
    ["你好，我叫小明", "小明"],
  ])(
    "admits one explicit lossless Legacy name write for '%s'",
    (input, expectedName) => {
      const engine = createSunlandEngine({
        semanticMode: "passive",
        semanticDebug: true,
      });

      engine.respond(input);
      expect(engine.memory.recall("name")?.value).toBe(
        expectedName,
      );
      expect(engine.memory.list()).toHaveLength(1);
      expect(engine.getLastSemanticShadow()).toMatchObject({
        adapterKind: "fallback-legacy",
        fellBackToLegacy: true,
      });
    },
  );

  it.each([
    "名字",
    "名字小明",
    "我不是小明",
    "不要记住我叫小明",
    "我叫小明，猫属于动物",
  ])("blocks unsafe name mutation for '%s'", (input) => {
    const engine = createSunlandEngine({
      semanticMode: "passive",
      semanticDebug: true,
    });

    const reply = engine.respond(input);
    expect(engine.memory.list()).toEqual([]);
    expect(engine.knowledgeStore.all()).toEqual([]);
    expect(reply).not.toMatch(INTERNAL_TERMS);
  });

  it.each([
    "你记得我叫什么吗",
    "你还记得我的名字吗",
    "还记得我是谁吗",
  ])("adopts explicit RecallName '%s' as read-only", (input) => {
    const engine = createSunlandEngine({
      semanticMode: "passive",
      semanticDebug: true,
    });
    engine.respond("我叫小明");
    const before = engine.memory.list();

    expect(engine.respond(input)).toContain("小明");
    expect(engine.memory.list()).toEqual(before);
    expect(engine.getLastSemanticShadow()).toMatchObject({
      adapterKind: "adopt",
      selectedCandidateType: "intent",
      semanticAdopted: true,
    });
  });

  it("keeps legacy teaching Statements on the legacy write path", () => {
    const engine = createSunlandEngine({
      semanticMode: "passive",
      semanticDebug: true,
    });

    engine.respond("猫属于动物");
    expect(
      engine.knowledgeStore.has({
        subject: "猫",
        relation: "属于",
        object: "动物",
        negated: false,
      }),
    ).toBe(true);
    expect(engine.getLastSemanticShadow()).toMatchObject({
      selectedCandidateType: "statement",
      adapterKind: "fallback-legacy",
      semanticAdopted: false,
    });
  });

  it.each([
    ["鸟有翅膀", "鸟", "有", "翅膀"],
    [
      "霜蓝指的是我的角色名",
      "霜蓝",
      "意思是",
      "我的角色名",
    ],
  ])(
    "admits one complete canonical Legacy teaching triple for '%s'",
    (input, subject, relation, object) => {
      const engine = createSunlandEngine({
        semanticMode: "passive",
        semanticDebug: true,
      });

      engine.respond(input);
      expect(engine.knowledgeStore.all()).toHaveLength(1);
      expect(
        engine.knowledgeStore.has({
          subject,
          relation,
          object,
          negated: false,
        }),
      ).toBe(true);
      expect(engine.getLastSemanticShadow()).toMatchObject({
        adapterKind: "fallback-legacy",
        fellBackToLegacy: true,
      });
    },
  );

  it.each([
    "猫是不是动物",
    "猫会飞还是会游泳",
    "鸟有没有翅膀",
    "猫是",
    "教你一个事实",
    `${"这是一段很长但合理的输入，".repeat(80)}请告诉我你是否理解。`,
  ])("blocks unsafe teaching mutation for '%s'", (input) => {
    const engine = createSunlandEngine({
      semanticMode: "passive",
      semanticDebug: true,
    });

    const reply = engine.respond(input);
    expect(engine.knowledgeStore.all()).toEqual([]);
    expect(engine.memory.list()).toEqual([]);
    expect(reply).not.toMatch(INTERNAL_TERMS);
  });

  it("keeps newly supported positive teaching on the repaired Legacy path", () => {
    const engine = createSunlandEngine({
      semanticMode: "passive",
      semanticDebug: true,
    });

    engine.respond("鸟有翅膀");
    expect(
      engine.knowledgeStore.has({
        subject: "鸟",
        relation: "有",
        object: "翅膀",
        negated: false,
      }),
    ).toBe(true);
    expect(engine.getLastSemanticShadow()).toMatchObject({
      selectedCandidateType: "statement",
      adapterKind: "fallback-legacy",
      semanticAdopted: false,
    });
  });

  it("does not let passive fallback persist a negated Knowledge statement", () => {
    const engine = createSunlandEngine({
      semanticMode: "passive",
      semanticDebug: true,
    });

    const reply = engine.respond("猫不是狗");
    expect(engine.knowledgeStore.all()).toEqual([]);
    expect(reply).not.toMatch(INTERNAL_TERMS);
    expect(engine.getLastSemanticShadow()).toMatchObject({
      decisionType: "reject-side-effect",
      adapterKind: "no-understanding",
      semanticAdopted: true,
    });
  });

  it.each(["analyze", "plan"] as const)(
    "falls back safely when Semantic %s throws",
    (failurePoint) => {
      const off = createSunlandEngine({
        personalityId: "plain",
        semanticMode: "off",
      });
      const engine = createSunlandEngine({
        personalityId: "plain",
        semanticMode: "passive",
        semanticDebug: true,
        semanticRuntime:
          failurePoint === "analyze"
            ? {
                analyze() {
                  throw new Error("semantic analyzer failed");
                },
              }
            : {
                plan() {
                  throw new Error("understanding planner failed");
                },
              },
      });

      expect(engine.respond("你好")).toBe(off.respond("你好"));
      expect(engine.getLastSemanticShadow()).toMatchObject({
        decisionType: "error",
        adapterKind: "error",
        semanticError: true,
        fellBackToLegacy: true,
      });
    },
  );

  it("fails closed when Semantic validation is unavailable for a Legacy write", () => {
    const engine = createSunlandEngine({
      semanticMode: "passive",
      semanticDebug: true,
      semanticRuntime: {
        analyze() {
          throw new Error("semantic analyzer failed");
        },
      },
    });

    expect(engine.respond("我叫小明")).not.toMatch(INTERNAL_TERMS);
    expect(engine.memory.list()).toEqual([]);
    expect(engine.knowledgeStore.all()).toEqual([]);
    expect(engine.getLastSemanticShadow()).toMatchObject({
      decisionType: "error",
      adapterKind: "error",
      semanticError: true,
    });
  });

  it("never exposes diagnostics or planner metadata in clarification output", () => {
    const engine = createSunlandEngine({
      semanticMode: "passive",
      semanticDebug: true,
    });

    expect(engine.respond("你会吗")).not.toMatch(INTERNAL_TERMS);
    expect(engine.respond("猫是")).not.toMatch(INTERNAL_TERMS);
  });

  it("redacts user names and teaching entities from Shadow diagnostics", () => {
    const engine = createSunlandEngine({
      semanticMode: "passive",
      semanticDebug: true,
    });

    engine.respond("我叫Alice Chen");
    const nameShadow = JSON.stringify(engine.getLastSemanticShadow());
    expect(nameShadow).not.toContain("Alice");
    expect(nameShadow).not.toContain("Chen");

    engine.respond("星尾狐属于灵兽");
    const teachingShadow = JSON.stringify(engine.getLastSemanticShadow());
    expect(teachingShadow).not.toContain("星尾狐");
    expect(teachingShadow).not.toContain("灵兽");
  });
});
