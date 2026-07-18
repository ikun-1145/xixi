import { describe, expect, it } from "vitest";
import { CoreRelations } from "@/types";
import { InMemoryKnowledgeStore } from "./store";
import { seedKnowledgeStore, seedTriples } from "./seed";

describe("seedKnowledgeStore", () => {
  it("populates an empty store with every seed triple, tagged as source: seed", () => {
    const store = new InMemoryKnowledgeStore();
    seedKnowledgeStore(store);

    expect(store.all()).toHaveLength(seedTriples.length);
    expect(store.all().every((record) => record.source === "seed")).toBe(true);
    for (const triple of seedTriples) {
      expect(store.has(triple)).toBe(true);
    }
  });

  it("is safe to call twice (idempotent, no duplicates)", () => {
    const store = new InMemoryKnowledgeStore();
    seedKnowledgeStore(store);
    seedKnowledgeStore(store);
    expect(store.all()).toHaveLength(seedTriples.length);
  });

  it("includes the classic 企鹅/鸟/飞 exception so a future conflict resolver has real work to do", () => {
    const store = new InMemoryKnowledgeStore();
    seedKnowledgeStore(store);

    expect(store.match({ subject: "鸟", relation: CoreRelations.Can, object: "飞", negated: false })).toHaveLength(1);
    expect(store.match({ subject: "企鹅", relation: CoreRelations.IsA, object: "鸟" })).toHaveLength(1);
    expect(store.match({ subject: "企鹅", relation: CoreRelations.Can, object: "飞", negated: true })).toHaveLength(1);
  });

  it("includes a two-hop inheritance chain for the future transitivity rule", () => {
    const store = new InMemoryKnowledgeStore();
    seedKnowledgeStore(store);

    expect(store.match({ subject: "猫", relation: CoreRelations.IsA, object: "哺乳动物" })).toHaveLength(1);
    expect(store.match({ subject: "哺乳动物", relation: CoreRelations.IsA, object: "动物" })).toHaveLength(1);
  });
});
