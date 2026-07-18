import { describe, expect, it } from "vitest";
import { InMemoryKnowledgeStore } from "@/knowledge";
import { CoreRelations, type ParsedQuery } from "@/types";
import { graphReasoner } from "./graphReasoner";

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
