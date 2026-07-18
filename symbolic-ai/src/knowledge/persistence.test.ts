import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStorageAdapter } from "@/storage";
import type { StorageAdapter } from "@/types";
import { CoreRelations } from "@/types";
import { InMemoryKnowledgeStore } from "./store";
import { loadKnowledgeStore, saveKnowledgeStore } from "./persistence";

describe("knowledge persistence", () => {
  let adapter: StorageAdapter;
  const KEY = "sunland_knowledge_test-user";

  beforeEach(() => {
    adapter = createMemoryStorageAdapter();
  });

  it("round-trips facts through save + load into a fresh store", () => {
    const store = new InMemoryKnowledgeStore();
    store.add({ subject: "猫", relation: CoreRelations.IsA, object: "哺乳动物", negated: false });
    store.add({ subject: "企鹅", relation: CoreRelations.Can, object: "飞", negated: true });
    saveKnowledgeStore(store, adapter, KEY);

    const restored = new InMemoryKnowledgeStore();
    loadKnowledgeStore(restored, adapter, KEY);

    expect(restored.all()).toHaveLength(2);
    expect(restored.has({ subject: "猫", relation: CoreRelations.IsA, object: "哺乳动物", negated: false })).toBe(true);
    expect(restored.has({ subject: "企鹅", relation: CoreRelations.Can, object: "飞", negated: true })).toBe(true);
  });

  it("is a no-op when the key has never been written", () => {
    const store = new InMemoryKnowledgeStore();
    loadKnowledgeStore(store, adapter, "does-not-exist");
    expect(store.all()).toEqual([]);
  });

  it("never throws on corrupted persisted data", () => {
    adapter.setItem(KEY, "{not valid json");
    const store = new InMemoryKnowledgeStore();
    expect(() => loadKnowledgeStore(store, adapter, KEY)).not.toThrow();
    expect(store.all()).toEqual([]);
  });

  it("ignores persisted data that isn't an array", () => {
    adapter.setItem(KEY, JSON.stringify({ oops: "not an array" }));
    const store = new InMemoryKnowledgeStore();
    loadKnowledgeStore(store, adapter, KEY);
    expect(store.all()).toEqual([]);
  });

  it("loading twice does not duplicate records (addMany id-skip semantics)", () => {
    const store = new InMemoryKnowledgeStore();
    store.add({ subject: "猫", relation: CoreRelations.Likes, object: "鱼", negated: false });
    saveKnowledgeStore(store, adapter, KEY);

    const restored = new InMemoryKnowledgeStore();
    loadKnowledgeStore(restored, adapter, KEY);
    loadKnowledgeStore(restored, adapter, KEY);
    expect(restored.all()).toHaveLength(1);
  });
});
