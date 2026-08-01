import { describe, expect, it } from "vitest";
import { InMemoryKnowledgeStore } from "@/knowledge";
import {
  CoreRelations,
  type KnowledgeQuery,
  type ParsedQuery,
} from "@/types";
import {
  answerGraphQuery,
  graphReasoner,
} from "./graphReasoner";

function addIsA(store: InMemoryKnowledgeStore, subject: string, object: string): void {
  store.add({ subject, relation: CoreRelations.IsA, object, negated: false });
}

function makeQuery(overrides: Partial<ParsedQuery> = {}): ParsedQuery {
  return { type: "query", subject: "猫", relation: CoreRelations.IsA, kind: "verify", raw: "", ...overrides };
}

describe("graphReasoner", () => {
  it("answers a verify query about a directly-known isA fact", () => {
    const store = new InMemoryKnowledgeStore();
    addIsA(store, "猫", "动物");

    const result = graphReasoner.answer(makeQuery({ subject: "猫", object: "动物" }), store);
    expect(result.answers).toHaveLength(1);
    expect(result.answers[0]?.conclusion).toEqual({ subject: "猫", relation: "属于", object: "动物", negated: false });
    expect(result.answers[0]?.steps).toEqual([]);
  });

  it("answers a verify query via multi-hop transitive path reasoning (猫→动物→生物)", () => {
    const store = new InMemoryKnowledgeStore();
    addIsA(store, "猫", "动物");
    addIsA(store, "动物", "生物");

    const result = graphReasoner.answer(makeQuery({ subject: "猫", object: "生物" }), store);
    expect(result.answers).toHaveLength(1);
    const [answer] = result.answers;
    expect(answer?.conclusion).toEqual({ subject: "猫", relation: "属于", object: "生物", negated: false });
    expect(answer?.path).toEqual(["猫", "动物", "生物"]);
    expect(answer?.steps.length).toBeGreaterThan(0);
  });

  it("includes the derivation path (Evidence) in the explanation for a derived answer", () => {
    const store = new InMemoryKnowledgeStore();
    addIsA(store, "猫", "动物");
    addIsA(store, "动物", "生物");

    const result = graphReasoner.answer(makeQuery({ subject: "猫", object: "生物" }), store);
    expect(result.explanation).toContain("猫");
    expect(result.explanation).toContain("生物");
    expect(result.explanation).toContain("猫 → 动物 → 生物");
  });

  it("gives a graceful 'no known facts' explanation when nothing matches", () => {
    const store = new InMemoryKnowledgeStore();
    const result = graphReasoner.answer(makeQuery({ subject: "恐龙", object: "生物" }), store);
    expect(result.answers).toEqual([]);
    expect(result.explanation).toBe("目前还没有已知的相关事实。");
  });

  it("object-of query returns both direct and transitively-derived answers", () => {
    const store = new InMemoryKnowledgeStore();
    addIsA(store, "猫", "动物");
    addIsA(store, "动物", "生物");

    const result = graphReasoner.answer(
      { type: "query", subject: "猫", relation: CoreRelations.IsA, kind: "object-of", raw: "" },
      store,
    );
    const objects = result.answers.map((a) => a.conclusion.object).sort();
    expect(objects).toEqual(["动物", "生物"].sort());
  });

  it("never double-reports an object that is both directly known and reachable via a different path", () => {
    const store = new InMemoryKnowledgeStore();
    addIsA(store, "猫", "动物");
    addIsA(store, "动物", "哺乳动物");
    addIsA(store, "猫", "哺乳动物"); // also directly known

    const result = graphReasoner.answer(
      makeQuery({ subject: "猫", object: "哺乳动物", kind: "verify" }),
      store,
    );
    expect(result.answers).toHaveLength(1);
    expect(result.answers[0]?.steps).toEqual([]); // reported as the direct fact, not a duplicate derived one
  });

  it("does not apply isA transitivity to other relations (direct-fact-only, as before)", () => {
    const store = new InMemoryKnowledgeStore();
    store.add({ subject: "鸟", relation: CoreRelations.Can, object: "飞", negated: false });

    const result = graphReasoner.answer(
      { type: "query", subject: "鸟", relation: CoreRelations.Can, kind: "object-of", raw: "" },
      store,
    );
    expect(result.answers).toHaveLength(1);
    expect(result.answers[0]?.conclusion.object).toBe("飞");
  });

  it("preserves negation for direct facts", () => {
    const store = new InMemoryKnowledgeStore();
    store.add({ subject: "企鹅", relation: CoreRelations.Can, object: "飞", negated: true });

    const result = graphReasoner.answer(
      makeQuery({ subject: "企鹅", relation: CoreRelations.Can, object: "飞", kind: "verify" }),
      store,
    );
    expect(result.answers[0]?.conclusion.negated).toBe(true);
  });

  describe("query-specific isA traversal", () => {
    it("keeps all object-of answers and Evidence across a 100-edge chain", () => {
      const store = new InMemoryKnowledgeStore();
      for (let index = 0; index < 100; index += 1) {
        addIsA(store, `节点${index}`, `节点${index + 1}`);
      }

      const result = graphReasoner.answer(
        makeQuery({
          subject: "节点0",
          kind: "object-of",
        }),
        store,
      );

      expect(result.answers).toHaveLength(100);
      const terminal = result.answers.find(
        ({ conclusion }) => conclusion.object === "节点100",
      );
      expect(terminal?.path).toHaveLength(101);
      expect(terminal?.path[0]).toBe("节点0");
      expect(terminal?.path.at(-1)).toBe("节点100");
      expect(terminal?.steps).toHaveLength(99);
    });

    it("preserves confidence, Evidence path and reasoning steps on a 100-edge verify query", () => {
      const store = new InMemoryKnowledgeStore();
      for (let index = 0; index < 100; index += 1) {
        store.add(
          {
            subject: `节点${index}`,
            relation: CoreRelations.IsA,
            object: `节点${index + 1}`,
            negated: false,
          },
          { confidence: 0.99 },
        );
      }

      const result = graphReasoner.answer(
        makeQuery({
          subject: "节点0",
          object: "节点100",
        }),
        store,
      );

      expect(result.answers).toHaveLength(1);
      expect(result.answers[0]?.confidence).toBeCloseTo(
        0.99 ** 100,
      );
      expect(result.answers[0]?.path).toHaveLength(101);
      expect(result.answers[0]?.steps).toHaveLength(99);
      expect(result.explanation).toContain(
        "节点0 → 节点1",
      );
      expect(result.explanation).toContain("节点100");
    });

    it("stops verify traversal when the target is first reached", () => {
      const store = new InMemoryKnowledgeStore();
      for (let index = 0; index < 100; index += 1) {
        addIsA(store, `节点${index}`, `节点${index + 1}`);
      }
      const expandedSubjects: string[] = [];
      const observedStore: KnowledgeQuery = {
        all: () => store.all(),
        has: (triple) => store.has(triple),
        match: (pattern) => {
          if (
            pattern.subject !== undefined &&
            pattern.relation === CoreRelations.IsA &&
            pattern.object === undefined &&
            pattern.negated === false
          ) {
            expandedSubjects.push(pattern.subject);
          }
          return store.match(pattern);
        },
      };

      const result = graphReasoner.answer(
        makeQuery({
          subject: "节点0",
          object: "节点50",
        }),
        observedStore,
      );

      expect(result.answers).toHaveLength(1);
      expect(expandedSubjects).toContain("节点49");
      expect(expandedSubjects).not.toContain("节点50");
      expect(expandedSubjects).not.toContain("节点99");
    });

    it("does not expand unrelated isA subgraphs for object-of queries", () => {
      const store = new InMemoryKnowledgeStore();
      addIsA(store, "猫", "动物");
      addIsA(store, "动物", "生物");
      for (let index = 0; index < 100; index += 1) {
        addIsA(
          store,
          `无关节点${index}`,
          `无关节点${index + 1}`,
        );
      }
      const expandedSubjects: string[] = [];
      const observedStore: KnowledgeQuery = {
        all: () => store.all(),
        has: (triple) => store.has(triple),
        match: (pattern) => {
          if (
            pattern.subject !== undefined &&
            pattern.relation === CoreRelations.IsA &&
            pattern.object === undefined &&
            pattern.negated === false
          ) {
            expandedSubjects.push(pattern.subject);
          }
          return store.match(pattern);
        },
      };

      const result = graphReasoner.answer(
        makeQuery({
          subject: "猫",
          kind: "object-of",
        }),
        observedStore,
      );

      expect(
        result.answers.map(({ conclusion }) => conclusion.object),
      ).toEqual(["动物", "生物"]);
      expect(expandedSubjects).toEqual(["猫", "动物", "生物"]);
      expect(
        expandedSubjects.some((subject) =>
          subject.startsWith("无关节点"),
        ),
      ).toBe(false);
    });

    it("keeps per-query cycle detection without losing reachable answers", () => {
      const store = new InMemoryKnowledgeStore();
      addIsA(store, "A", "B");
      addIsA(store, "B", "C");
      addIsA(store, "C", "A");

      const result = graphReasoner.answer(
        makeQuery({
          subject: "A",
          kind: "object-of",
        }),
        store,
      );

      expect(
        result.answers.map(({ conclusion }) => conclusion.object),
      ).toEqual(["B", "C"]);
    });
  });

  describe("Relation Alignment v1", () => {
    it("uses 属于 only after an exact 是 query returns no answers", () => {
      const store = new InMemoryKnowledgeStore();
      addIsA(store, "猫", "动物");

      const before = store.all();
      const resolved = answerGraphQuery(
        {
          type: "query",
          subject: "猫",
          relation: CoreRelations.Is,
          kind: "object-of",
          raw: "猫是什么",
        },
        store,
      );

      expect(resolved.result.answers[0]?.conclusion).toEqual({
        subject: "猫",
        relation: "属于",
        object: "动物",
        negated: false,
      });
      expect(resolved.relationResolution).toEqual({
        mode: "fallback",
        queriedRelation: "是",
        matchedRelation: "属于",
        policyId: "relation-alignment-v1",
      });
      expect(store.all()).toEqual(before);
    });

    it("uses only legacy `是 一种...` records for 属于 -> 是", () => {
      const store = new InMemoryKnowledgeStore();
      store.add({
        subject: "猫",
        relation: CoreRelations.Is,
        object: "一种动物",
        negated: false,
      });
      store.add({
        subject: "猫",
        relation: CoreRelations.Is,
        object: "毛茸茸的伙伴",
        negated: false,
      });

      const resolved = answerGraphQuery(
        {
          type: "query",
          subject: "猫",
          relation: CoreRelations.IsA,
          kind: "object-of",
          raw: "猫属于什么",
        },
        store,
      );

      expect(
        resolved.result.answers.map(
          ({ conclusion }) => conclusion.object,
        ),
      ).toEqual(["动物"]);
      expect(resolved.relationResolution).toEqual({
        mode: "fallback",
        queriedRelation: "属于",
        matchedRelation: "是",
        policyId: "relation-alignment-v1",
      });
    });

    it("keeps exact answers authoritative and skips fallback", () => {
      const store = new InMemoryKnowledgeStore();
      addIsA(store, "猫", "动物");
      store.add({
        subject: "猫",
        relation: CoreRelations.Is,
        object: "一种生物",
        negated: false,
      });

      const resolved = answerGraphQuery(
        {
          type: "query",
          subject: "猫",
          relation: CoreRelations.IsA,
          kind: "object-of",
          raw: "猫属于什么",
        },
        store,
      );

      expect(
        resolved.result.answers.map(
          ({ conclusion }) => conclusion.object,
        ),
      ).toEqual(["动物"]);
      expect(resolved.relationResolution).toEqual({
        mode: "exact",
        queriedRelation: "属于",
        matchedRelation: "属于",
        policyId: "relation-alignment-v1",
      });
    });

    it("never falls back for verify, negated or context-resolved queries", () => {
      const store = new InMemoryKnowledgeStore();
      addIsA(store, "猫", "动物");
      const verify: ParsedQuery = {
        type: "query",
        subject: "猫",
        relation: CoreRelations.Is,
        object: "动物",
        kind: "verify",
        raw: "猫是不是动物",
      };
      const objectOf: ParsedQuery = {
        type: "query",
        subject: "猫",
        relation: CoreRelations.Is,
        kind: "object-of",
        raw: "猫是什么",
      };

      expect(
        answerGraphQuery(verify, store).result.answers,
      ).toEqual([]);
      expect(
        answerGraphQuery(objectOf, store, {
          negatedInput: true,
        }).result.answers,
      ).toEqual([]);
      expect(
        answerGraphQuery(objectOf, store, {
          contextResolved: true,
        }).result.answers,
      ).toEqual([]);
    });
  });

  describe("materialize", () => {
    it("returns the full forward-closure of derivable (multi-hop) isA facts", () => {
      const store = new InMemoryKnowledgeStore();
      addIsA(store, "猫", "动物");
      addIsA(store, "动物", "生物");

      const inferences = graphReasoner.materialize(store);
      expect(inferences).toHaveLength(1);
      expect(inferences[0]?.conclusion).toEqual({ subject: "猫", relation: "属于", object: "生物", negated: false });
    });

    it("returns an empty array when nothing is derivable", () => {
      const store = new InMemoryKnowledgeStore();
      addIsA(store, "猫", "动物");
      expect(graphReasoner.materialize(store)).toEqual([]);
    });
  });
});
