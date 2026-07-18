import { describe, expect, it } from "vitest";
import { MemoryKeys } from "@/types";
import { InMemoryMemoryManager } from "./manager";

describe("InMemoryMemoryManager", () => {
  it("remembers a new fact and returns the created record", () => {
    const memory = new InMemoryMemoryManager();
    const record = memory.remember(MemoryKeys.Name, "刘锡泽");

    expect(record.key).toBe(MemoryKeys.Name);
    expect(record.value).toBe("刘锡泽");
    expect(record.id).toBeTruthy();
    expect(record.createdAt).toBeTruthy();
    expect(record.updatedAt).toBeTruthy();
  });

  it("recalls a remembered fact", () => {
    const memory = new InMemoryMemoryManager();
    memory.remember(MemoryKeys.Name, "刘锡泽");

    const recalled = memory.recall(MemoryKeys.Name);
    expect(recalled).not.toBeNull();
    expect(recalled?.value).toBe("刘锡泽");
  });

  it("returns null when recalling a key that was never remembered", () => {
    const memory = new InMemoryMemoryManager();
    expect(memory.recall(MemoryKeys.Name)).toBeNull();
  });

  it("overwrites an existing value on re-remember, keeping the same id/createdAt", () => {
    const memory = new InMemoryMemoryManager();
    const first = memory.remember(MemoryKeys.Name, "刘锡泽");
    const second = memory.remember(MemoryKeys.Name, "小锡");

    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.value).toBe("小锡");
    expect(memory.recall(MemoryKeys.Name)?.value).toBe("小锡");
    expect(memory.list()).toHaveLength(1);
  });

  it("forgets a fact so recall afterwards returns null", () => {
    const memory = new InMemoryMemoryManager();
    memory.remember(MemoryKeys.Name, "刘锡泽");
    memory.forget(MemoryKeys.Name);

    expect(memory.recall(MemoryKeys.Name)).toBeNull();
  });

  it("forgetting an unknown key is a harmless no-op", () => {
    const memory = new InMemoryMemoryManager();
    expect(() => memory.forget(MemoryKeys.Name)).not.toThrow();
  });

  it("lists all remembered facts", () => {
    const memory = new InMemoryMemoryManager();
    memory.remember(MemoryKeys.Name, "刘锡泽");
    memory.remember("favoriteColor", "蓝色");

    const all = memory.list();
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.key).sort()).toEqual(["favoriteColor", "name"].sort());
  });

  it("searches by key or value substring, case-insensitively", () => {
    const memory = new InMemoryMemoryManager();
    memory.remember(MemoryKeys.Name, "Liu Xize");

    expect(memory.search("liu")).toHaveLength(1);
    expect(memory.search("NAME")).toHaveLength(1);
    expect(memory.search("nomatch")).toHaveLength(0);
  });

  it("restore() adds records without a matching key, and does not overwrite existing keys", () => {
    const memory = new InMemoryMemoryManager();
    memory.remember(MemoryKeys.Name, "现有的名字");

    memory.restore([
      { id: "mem_x", key: MemoryKeys.Name, value: "不应生效", createdAt: "t", updatedAt: "t" },
      { id: "mem_y", key: "age", value: "16", createdAt: "t", updatedAt: "t" },
    ]);

    expect(memory.recall(MemoryKeys.Name)?.value).toBe("现有的名字");
    expect(memory.recall("age")?.value).toBe("16");
  });
});
