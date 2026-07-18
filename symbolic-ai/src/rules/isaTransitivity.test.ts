import { describe, expect, it } from "vitest";
import { InMemoryKnowledgeStore } from "@/knowledge";
import { CoreRelations } from "@/types";
import { isaTransitivityRule } from "./isaTransitivity";

function addIsA(store: InMemoryKnowledgeStore, subject: string, object: string): void {
  store.add({ subject, relation: CoreRelations.IsA, object, negated: false });
}

describe("isaTransitivityRule", () => {
  it("derives a 2-hop inference (A属于B, B属于C ⇒ A属于C)", () => {
    const store = new InMemoryKnowledgeStore();
    addIsA(store, "猫", "动物");
    addIsA(store, "动物", "生物");

    const inferences = isaTransitivityRule.apply(store);
    expect(inferences).toHaveLength(1);
    expect(inferences[0]?.conclusion).toEqual({ subject: "猫", relation: "属于", object: "生物", negated: false });
    expect(inferences[0]?.path).toEqual(["猫", "动物", "生物"]);
  });

  it("does not emit an inference for a single direct edge (not a derivation)", () => {
    const store = new InMemoryKnowledgeStore();
    addIsA(store, "猫", "动物");

    expect(isaTransitivityRule.apply(store)).toEqual([]);
  });

  it("chains through 3+ hops", () => {
    const store = new InMemoryKnowledgeStore();
    addIsA(store, "猫", "哺乳动物");
    addIsA(store, "哺乳动物", "动物");
    addIsA(store, "动物", "生物");

    const inferences = isaTransitivityRule.apply(store);
    const paths = inferences.map((i) => i.path.join("→"));
    expect(paths).toContain("猫→哺乳动物→动物");
    expect(paths).toContain("猫→哺乳动物→动物→生物");
    expect(paths).toContain("哺乳动物→动物→生物");
  });

  it("produces a human-readable, chained step description", () => {
    const store = new InMemoryKnowledgeStore();
    addIsA(store, "猫", "动物");
    addIsA(store, "动物", "生物");

    const [inference] = isaTransitivityRule.apply(store);
    expect(inference?.steps).toHaveLength(1);
    expect(inference?.steps[0]?.description).toBe("猫 属于 动物，动物 属于 生物 ⇒ 猫 属于 生物");
  });

  it("does not chain through a negated edge", () => {
    const store = new InMemoryKnowledgeStore();
    addIsA(store, "猫", "动物");
    store.add({ subject: "动物", relation: CoreRelations.IsA, object: "生物", negated: true });

    expect(isaTransitivityRule.apply(store)).toEqual([]);
  });

  it("does not chain through a different relation, even alongside a real isA edge", () => {
    const store = new InMemoryKnowledgeStore();
    addIsA(store, "猫", "动物");
    store.add({ subject: "动物", relation: CoreRelations.Can, object: "跑", negated: false });

    // Only a genuine 属于 edge from 动物 would let this chain past 1 hop --
    // "会跑" must never be treated as if it were an isA edge.
    expect(isaTransitivityRule.apply(store)).toEqual([]);
  });

  it("tolerates a cycle without hanging or throwing", () => {
    const store = new InMemoryKnowledgeStore();
    addIsA(store, "A", "B");
    addIsA(store, "B", "A");

    expect(() => isaTransitivityRule.apply(store)).not.toThrow();
  });

  it("returns an empty array when the store has no isA facts", () => {
    const store = new InMemoryKnowledgeStore();
    expect(isaTransitivityRule.apply(store)).toEqual([]);
  });

  it("multiplies confidence across the chain", () => {
    const store = new InMemoryKnowledgeStore();
    store.add({ subject: "猫", relation: CoreRelations.IsA, object: "动物", negated: false }, { confidence: 0.9 });
    store.add({ subject: "动物", relation: CoreRelations.IsA, object: "生物", negated: false }, { confidence: 0.8 });

    const [inference] = isaTransitivityRule.apply(store);
    expect(inference?.confidence).toBeCloseTo(0.72);
  });
});
