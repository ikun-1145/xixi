import { describe, expect, it } from "vitest";
import { createMemoryStorageAdapter } from "@/storage";
import { createSunlandEngine } from "./sunlandEngine";

describe("createSunlandEngine", () => {
  it("starts with an empty brain by default (no demo seed data leaking to real users)", () => {
    const engine = createSunlandEngine();
    expect(engine.knowledgeStore.all()).toEqual([]);
  });

  it("opts into demo seed data only when explicitly requested", () => {
    const engine = createSunlandEngine({ seedDemoData: true });
    expect(engine.knowledgeStore.all().length).toBeGreaterThan(0);
    expect(engine.knowledgeStore.has({ subject: "企鹅", relation: "属于", object: "鸟", negated: false })).toBe(true);
  });

  it("learns a statement and reflects it back via the persona", () => {
    const engine = createSunlandEngine();
    const reply = engine.respond("猫属于哺乳动物");
    expect(reply).toContain("猫");
    expect(reply).toContain("哺乳动物");
    expect(engine.knowledgeStore.has({ subject: "猫", relation: "属于", object: "哺乳动物", negated: false })).toBe(
      true,
    );
  });

  it("answers a query about a directly-known fact", () => {
    const engine = createSunlandEngine();
    engine.respond("鸟会飞");
    const reply = engine.respond("鸟会什么");
    expect(reply).toContain("飞");
  });

  it("gives a graceful (non-throwing) answer when nothing is known yet", () => {
    const engine = createSunlandEngine();
    const reply = engine.respond("恐龙会什么");
    expect(typeof reply).toBe("string");
    expect(reply.length).toBeGreaterThan(0);
  });

  it("handles unparseable input via the persona's unknown-input voice", () => {
    const engine = createSunlandEngine();
    const reply = engine.respond("哈哈哈哈哈");
    expect(typeof reply).toBe("string");
    expect(reply.length).toBeGreaterThan(0);
  });

  it("persists learned facts across engine instances via a shared StorageAdapter+key (the 'shared brain' requirement)", () => {
    const adapter = createMemoryStorageAdapter();
    const key = "sunland_knowledge_user-1";

    const first = createSunlandEngine({ storage: { adapter, key } });
    first.respond("苏格拉底是人");

    // A second, independent engine instance (e.g. a new conversation) reads
    // the SAME shared brain back -- conversations are independent, knowledge
    // is not.
    const second = createSunlandEngine({ storage: { adapter, key } });
    expect(second.knowledgeStore.has({ subject: "苏格拉底", relation: "是", object: "人", negated: false })).toBe(
      true,
    );
  });

  it("different storage keys never see each other's facts (per-user isolation)", () => {
    const adapter = createMemoryStorageAdapter();
    const userA = createSunlandEngine({ storage: { adapter, key: "sunland_knowledge_user-a" } });
    userA.respond("猫喜欢鱼");

    const userB = createSunlandEngine({ storage: { adapter, key: "sunland_knowledge_user-b" } });
    expect(userB.knowledgeStore.all()).toEqual([]);
  });

  it("supports a custom personality id", () => {
    const engine = createSunlandEngine({ personalityId: "plain" });
    const reply = engine.respond("猫属于哺乳动物");
    expect(reply).toBe("已记录：猫 属于 哺乳动物");
  });

  describe("conversational intents (Stage 4 — Basic Understanding)", () => {
    it("greets back instead of saying 'no matching grammar rule' (the original bug)", () => {
      const engine = createSunlandEngine();
      const reply = engine.respond("你好");
      expect(reply).not.toContain("没有匹配的语法规则");
      expect(reply.length).toBeGreaterThan(0);
    });

    it("recognizes multiple phrasings of the same Greeting intent", () => {
      const engine = createSunlandEngine();
      for (const phrase of ["你好", "嗨", "Hi", "Hello"]) {
        const reply = engine.respond(phrase);
        expect(reply).not.toContain("没有匹配的语法规则");
      }
    });

    it("responds to Thanks without touching the knowledge graph", () => {
      const engine = createSunlandEngine();
      const reply = engine.respond("谢谢");
      expect(reply.length).toBeGreaterThan(0);
      expect(engine.knowledgeStore.all()).toEqual([]);
    });

    it("responds to Farewell without touching the knowledge graph", () => {
      const engine = createSunlandEngine();
      const reply = engine.respond("再见");
      expect(reply.length).toBeGreaterThan(0);
      expect(engine.knowledgeStore.all()).toEqual([]);
    });

    it("intents never leak into or interfere with normal statement/query handling", () => {
      const engine = createSunlandEngine();
      engine.respond("你好");
      const reply = engine.respond("猫属于哺乳动物");
      expect(engine.knowledgeStore.has({ subject: "猫", relation: "属于", object: "哺乳动物", negated: false })).toBe(
        true,
      );
      expect(reply).toContain("猫");
    });
  });

  describe("Identity intent (Knowledge + Personality, no hardcoded answers)", () => {
    it("answers 'who are you' style questions about Sunland AI itself", () => {
      const engine = createSunlandEngine();
      for (const phrase of ["你是谁", "你叫什么", "Sunland AI是什么"]) {
        const reply = engine.respond(phrase);
        expect(reply).toContain("Sunland AI");
        expect(reply).not.toContain("没有匹配的语法规则");
      }
    });

    it("answers 'who is 霜蓝' with a fact specific to the personality, not the system", () => {
      const engine = createSunlandEngine();
      const reply = engine.respond("霜蓝是谁");
      expect(reply).toContain("霜蓝");
    });

    it("answers capability questions by listing real capability facts", () => {
      const engine = createSunlandEngine();
      const reply = engine.respond("你能做什么");
      expect(reply).toMatch(/记住|推理/);
    });

    it("answers creator questions", () => {
      const engine = createSunlandEngine();
      const reply = engine.respond("是谁开发了你");
      expect(reply.length).toBeGreaterThan(0);
      expect(reply).not.toContain("没有匹配的语法规则");
    });

    it("never touches the user's own (persisted) knowledge store", () => {
      const engine = createSunlandEngine();
      engine.respond("你是谁");
      engine.respond("你能做什么");
      engine.respond("是谁开发了你");
      expect(engine.knowledgeStore.all()).toEqual([]);
    });

    it("does not interfere with a real statement/query mentioning '你'-adjacent subjects", () => {
      const engine = createSunlandEngine();
      const reply = engine.respond("猫属于哺乳动物");
      expect(engine.knowledgeStore.has({ subject: "猫", relation: "属于", object: "哺乳动物", negated: false })).toBe(
        true,
      );
      expect(reply).toContain("猫");
    });

    it("works identically under the Plain personality (facts stay the same, only styling differs)", () => {
      const engine = createSunlandEngine({ personalityId: "plain" });
      const reply = engine.respond("你是谁");
      expect(reply).toContain("Sunland AI");
      expect(reply).toContain("是");
    });
  });

  describe("Memory Foundation (Stage 5 — remembering/recalling the user's name)", () => {
    it("has no memory of the user by default", () => {
      const engine = createSunlandEngine();
      expect(engine.memory.list()).toEqual([]);
    });

    it("remembers a name given via '我叫...' and reflects it back", () => {
      const engine = createSunlandEngine();
      const reply = engine.respond("我叫刘锡泽");
      expect(reply).toContain("刘锡泽");
      expect(engine.memory.recall("name")?.value).toBe("刘锡泽");
    });

    it("remembers a name given via '我的名字是...'", () => {
      const engine = createSunlandEngine();
      engine.respond("我的名字是刘锡泽");
      expect(engine.memory.recall("name")?.value).toBe("刘锡泽");
    });

    it("remembers a name given via '叫我...'", () => {
      const engine = createSunlandEngine();
      engine.respond("叫我锡泽");
      expect(engine.memory.recall("name")?.value).toBe("锡泽");
    });

    it("recalls a remembered name for '我叫什么'-style questions", () => {
      const engine = createSunlandEngine();
      engine.respond("我叫刘锡泽");
      const reply = engine.respond("我叫什么");
      expect(reply).toContain("刘锡泽");
    });

    it.each(["我叫什么", "你知道我的名字吗", "你记得我的名字吗"])(
      "recognizes '%s' as a name query",
      (phrase) => {
        const engine = createSunlandEngine();
        engine.respond("我叫刘锡泽");
        const reply = engine.respond(phrase);
        expect(reply).toContain("刘锡泽");
      },
    );

    it("gives the required graceful fallback when asked before ever being told a name", () => {
      const engine = createSunlandEngine();
      const reply = engine.respond("我叫什么");
      expect(reply).toContain("目前你还没有告诉我你的名字。");
    });

    it("overwrites a previously remembered name with a new one", () => {
      const engine = createSunlandEngine();
      engine.respond("我叫刘锡泽");
      engine.respond("我叫小锡");
      expect(engine.memory.recall("name")?.value).toBe("小锡");
      expect(engine.respond("我叫什么")).toContain("小锡");
    });

    it("gives the graceful fallback again after the name is forgotten", () => {
      const engine = createSunlandEngine();
      engine.respond("我叫刘锡泽");
      engine.memory.forget("name");
      const reply = engine.respond("我叫什么");
      expect(reply).toContain("目前你还没有告诉我你的名字。");
    });

    it("does not touch the knowledge store when remembering/recalling a name", () => {
      const engine = createSunlandEngine();
      engine.respond("我叫刘锡泽");
      engine.respond("我叫什么");
      expect(engine.knowledgeStore.all()).toEqual([]);
    });

    it("persists a remembered name across engine instances via a shared StorageAdapter+key", () => {
      const adapter = createMemoryStorageAdapter();
      const key = "sunland_knowledge_user-mem-1";

      const first = createSunlandEngine({ storage: { adapter, key } });
      first.respond("我叫刘锡泽");

      const second = createSunlandEngine({ storage: { adapter, key } });
      expect(second.memory.recall("name")?.value).toBe("刘锡泽");
    });

    it("different storage keys never see each other's remembered names (per-user isolation)", () => {
      const adapter = createMemoryStorageAdapter();
      const userA = createSunlandEngine({ storage: { adapter, key: "sunland_knowledge_user-mem-a" } });
      userA.respond("我叫刘锡泽");

      const userB = createSunlandEngine({ storage: { adapter, key: "sunland_knowledge_user-mem-b" } });
      expect(userB.memory.list()).toEqual([]);
    });

    it("works identically under the Plain personality (facts stay the same, only styling differs)", () => {
      const engine = createSunlandEngine({ personalityId: "plain" });
      const reply = engine.respond("我叫刘锡泽");
      expect(reply).toContain("刘锡泽");
    });

    it("does not regress existing Identity/Greeting/statement/query handling", () => {
      const engine = createSunlandEngine();
      expect(engine.respond("你好")).not.toContain("没有匹配的语法规则");
      expect(engine.respond("你是谁")).toContain("Sunland AI");
      engine.respond("猫属于哺乳动物");
      expect(engine.knowledgeStore.has({ subject: "猫", relation: "属于", object: "哺乳动物", negated: false })).toBe(
        true,
      );
      expect(engine.respond("猫属于什么")).toContain("哺乳动物");
    });
  });

  describe("Knowledge Graph v1 (Stage 6 — isA path reasoning)", () => {
    it("answers a directly-known verify question ('is 猫 属于 动物') with 是", () => {
      const engine = createSunlandEngine();
      engine.respond("猫属于动物");
      const reply = engine.respond("猫属不属于动物");
      expect(reply).toContain("动物");
    });

    it("answers a multi-hop verify question by walking the graph (猫→动物→生物)", () => {
      const engine = createSunlandEngine();
      engine.respond("猫属于动物");
      engine.respond("动物属于生物");

      const reply = engine.respond("猫属不属于生物");
      expect(reply).toContain("生物");
      // The Evidence / derivation chain should be surfaced, not just a bare
      // yes/no -- Personality only frames it, it doesn't invent the path.
      expect(reply).toContain("猫");
    });

    it("returns the actual node path as Evidence for a derived answer", () => {
      const engine = createSunlandEngine();
      engine.respond("猫属于动物");
      engine.respond("动物属于生物");

      const reply = engine.respond("猫属于什么");
      expect(reply).toContain("动物");
      expect(reply).toContain("生物");
    });

    it("chains through 3+ hops (猫→哺乳动物→动物→生物)", () => {
      const engine = createSunlandEngine();
      engine.respond("猫属于哺乳动物");
      engine.respond("哺乳动物属于动物");
      engine.respond("动物属于生物");

      const reply = engine.respond("猫属不属于生物");
      expect(reply).toContain("生物");
    });

    it("gives a graceful (non-throwing) answer when the chain doesn't reach the asked object", () => {
      const engine = createSunlandEngine();
      engine.respond("猫属于动物");
      engine.respond("动物属于生物");

      const reply = engine.respond("猫属不属于植物");
      expect(typeof reply).toBe("string");
      expect(reply.length).toBeGreaterThan(0);
    });

    it("does not apply isA reasoning to other relations (会/喜欢/在 stay direct-fact-only)", () => {
      const engine = createSunlandEngine();
      engine.respond("鸟会飞");
      const reply = engine.respond("鸟会什么");
      expect(reply).toContain("飞");
    });

    it("works identically under the Plain personality (facts/path stay the same, only styling differs)", () => {
      const engine = createSunlandEngine({ personalityId: "plain" });
      engine.respond("猫属于动物");
      engine.respond("动物属于生物");

      const reply = engine.respond("猫属于什么");
      expect(reply).toContain("生物");
    });

    it("persists taught facts (and therefore derivable paths) across engine instances", () => {
      const adapter = createMemoryStorageAdapter();
      const key = "sunland_knowledge_user-graph-1";

      const first = createSunlandEngine({ storage: { adapter, key } });
      first.respond("猫属于动物");
      first.respond("动物属于生物");

      const second = createSunlandEngine({ storage: { adapter, key } });
      const reply = second.respond("猫属于什么");
      expect(reply).toContain("生物");
    });
  });

  describe("Response Planner (Stage 7 — answer strategy between Reasoner and Personality)", () => {
    it("gives a plain answer (no derivation chain) for an ordinary multi-hop question", () => {
      const engine = createSunlandEngine();
      engine.respond("猫属于动物");
      engine.respond("动物属于生物");

      const reply = engine.respond("猫属于什么");
      expect(reply).toContain("生物");
      expect(reply).not.toContain("推理路径");
    });

    it("auto-explains (surfaces the derivation chain) when explicitly asked '为什么'", () => {
      const engine = createSunlandEngine();
      engine.respond("猫属于动物");
      engine.respond("动物属于生物");

      const reply = engine.respond("猫为什么属于生物");
      expect(reply).toContain("生物");
      expect(reply).toContain("推理路径");
      expect(reply).toContain("猫 → 动物 → 生物");
    });

    it("does not surface a derivation chain for a 'why' question about a direct (non-derived) fact", () => {
      const engine = createSunlandEngine();
      engine.respond("猫属于动物");

      const reply = engine.respond("猫为什么属于动物");
      expect(reply).toContain("动物");
      expect(reply).not.toContain("推理路径");
    });

    it("gives a graceful (non-throwing) answer for a 'why' question with no known path", () => {
      const engine = createSunlandEngine();
      const reply = engine.respond("猫为什么属于生物");
      expect(typeof reply).toBe("string");
      expect(reply.length).toBeGreaterThan(0);
    });

    it("naturally expresses uncertainty for a low-confidence answer", () => {
      const engine = createSunlandEngine();
      engine.respond("猫属于动物");
      // Directly seed a low-confidence fact (natural-language statements are
      // always confidence 1 today) to exercise the Planner's hedging path
      // end-to-end, exactly like other tests exercise seeded/demo data.
      engine.knowledgeStore.add(
        { subject: "企鹅", relation: "属于", object: "鸟", negated: false },
        { confidence: 0.3, source: "seed" },
      );

      const reply = engine.respond("企鹅属于什么");
      expect(reply).toContain("鸟");
      expect(reply).toMatch(/不确定|把握|推测|确认/);
    });

    it("does not hedge for a full-confidence answer", () => {
      const engine = createSunlandEngine();
      engine.respond("猫属于动物");
      const reply = engine.respond("猫属于什么");
      expect(reply).not.toMatch(/不是很有把握|没有十足的信心|只是我的推测/);
    });

    it("works identically under the Plain personality (facts/evidence/uncertainty stay the same, only styling differs)", () => {
      const engine = createSunlandEngine({ personalityId: "plain" });
      engine.respond("猫属于动物");
      engine.respond("动物属于生物");

      const reply = engine.respond("猫为什么属于生物");
      expect(reply).toContain("推理路径：猫 → 动物 → 生物");
    });

    it("does not regress ordinary Greeting/Identity/Memory/statement handling", () => {
      const engine = createSunlandEngine();
      expect(engine.respond("你好")).not.toContain("没有匹配的语法规则");
      expect(engine.respond("你是谁")).toContain("Sunland AI");
      engine.respond("我叫刘锡泽");
      expect(engine.respond("我叫什么")).toContain("刘锡泽");
      engine.respond("猫属于哺乳动物");
      expect(engine.respond("猫属于什么")).toContain("哺乳动物");
    });
  });
});
