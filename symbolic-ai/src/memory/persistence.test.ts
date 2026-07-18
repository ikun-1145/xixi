import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStorageAdapter } from "@/storage";
import type { StorageAdapter } from "@/types";
import { MemoryKeys } from "@/types";
import { InMemoryMemoryManager } from "./manager";
import { loadMemoryManager, saveMemoryManager } from "./persistence";

describe("memory persistence", () => {
  let adapter: StorageAdapter;
  const KEY = "sunland_memory_test-user";

  beforeEach(() => {
    adapter = createMemoryStorageAdapter();
  });

  it("round-trips a remembered name through save + load into a fresh manager", () => {
    const memory = new InMemoryMemoryManager();
    memory.remember(MemoryKeys.Name, "刘锡泽");
    saveMemoryManager(memory, adapter, KEY);

    const restored = new InMemoryMemoryManager();
    loadMemoryManager(restored, adapter, KEY);

    expect(restored.recall(MemoryKeys.Name)?.value).toBe("刘锡泽");
  });

  it("is a no-op when the key has never been written", () => {
    const memory = new InMemoryMemoryManager();
    loadMemoryManager(memory, adapter, "does-not-exist");
    expect(memory.list()).toEqual([]);
  });

  it("never throws on corrupted persisted data", () => {
    adapter.setItem(KEY, "{not valid json");
    const memory = new InMemoryMemoryManager();
    expect(() => loadMemoryManager(memory, adapter, KEY)).not.toThrow();
    expect(memory.list()).toEqual([]);
  });

  it("ignores persisted data that isn't an array", () => {
    adapter.setItem(KEY, JSON.stringify({ oops: "not an array" }));
    const memory = new InMemoryMemoryManager();
    loadMemoryManager(memory, adapter, KEY);
    expect(memory.list()).toEqual([]);
  });

  it("loading twice does not duplicate records", () => {
    const memory = new InMemoryMemoryManager();
    memory.remember(MemoryKeys.Name, "刘锡泽");
    saveMemoryManager(memory, adapter, KEY);

    const restored = new InMemoryMemoryManager();
    loadMemoryManager(restored, adapter, KEY);
    loadMemoryManager(restored, adapter, KEY);
    expect(restored.list()).toHaveLength(1);
  });
});
