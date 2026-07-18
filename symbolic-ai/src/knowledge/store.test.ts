import { beforeEach, describe, expect, it } from "vitest";
import type { Triple } from "@/types";
import { CoreRelations } from "@/types";
import { InMemoryKnowledgeStore } from "./store";

const catIsMammal: Triple = {
  subject: "猫",
  relation: CoreRelations.IsA,
  object: "哺乳动物",
  negated: false,
};

const penguinCannotFly: Triple = {
  subject: "企鹅",
  relation: CoreRelations.Can,
  object: "飞",
  negated: true,
};

describe("InMemoryKnowledgeStore", () => {
  let store: InMemoryKnowledgeStore;

  beforeEach(() => {
    store = new InMemoryKnowledgeStore();
  });

  describe("add / has / all", () => {
    it("starts empty", () => {
      expect(store.all()).toEqual([]);
      expect(store.has(catIsMammal)).toBe(false);
    });

    it("adds a triple and returns a fully-populated record", () => {
      const record = store.add(catIsMammal);
      expect(record.subject).toBe("猫");
      expect(record.relation).toBe(CoreRelations.IsA);
      expect(record.object).toBe("哺乳动物");
      expect(record.negated).toBe(false);
      expect(record.id).toBeTruthy();
      expect(record.confidence).toBe(1);
      expect(record.source).toBe("user");
      expect(() => new Date(record.createdAt).toISOString()).not.toThrow();
      expect(store.all()).toEqual([record]);
      expect(store.has(catIsMammal)).toBe(true);
    });

    it("applies AddOptions (confidence/source) when provided", () => {
      const record = store.add(penguinCannotFly, { confidence: 0.9, source: "seed" });
      expect(record.confidence).toBe(0.9);
      expect(record.source).toBe("seed");
    });

    it("is idempotent for an exact duplicate triple (same fact identity)", () => {
      const first = store.add(catIsMammal);
      const second = store.add(catIsMammal, { confidence: 0.2, source: "inference" });
      expect(second).toBe(first); // same object identity, options ignored
      expect(store.all()).toHaveLength(1);
    });

    it("treats negation as part of fact identity (not idempotent across negation)", () => {
      store.add({ ...penguinCannotFly, negated: false });
      store.add({ ...penguinCannotFly, negated: true });
      expect(store.all()).toHaveLength(2);
    });

    it("rejects out-of-range confidence values", () => {
      expect(() => store.add(catIsMammal, { confidence: 1.5 })).toThrow(RangeError);
      expect(() => store.add(catIsMammal, { confidence: -0.1 })).toThrow(RangeError);
      expect(() => store.add(catIsMammal, { confidence: Number.NaN })).toThrow(RangeError);
      expect(store.all()).toEqual([]); // rejected calls must not partially insert
    });

    it("accepts boundary confidence values 0 and 1", () => {
      expect(store.add(catIsMammal, { confidence: 0 }).confidence).toBe(0);
      expect(store.add(penguinCannotFly, { confidence: 1 }).confidence).toBe(1);
    });
  });

  describe("match", () => {
    beforeEach(() => {
      store.add(catIsMammal);
      store.add({ subject: "哺乳动物", relation: CoreRelations.IsA, object: "动物", negated: false });
      store.add({ subject: "猫", relation: CoreRelations.Likes, object: "鱼", negated: false });
      store.add(penguinCannotFly);
      store.add({ subject: "鸟", relation: CoreRelations.Can, object: "飞", negated: false });
    });

    it("returns everything for an empty (all-wildcard) pattern", () => {
      expect(store.match({})).toHaveLength(5);
    });

    it("filters by a single field", () => {
      const results = store.match({ subject: "猫" });
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.subject === "猫")).toBe(true);
    });

    it("filters by multiple fields combined (AND semantics)", () => {
      const results = store.match({ subject: "猫", relation: CoreRelations.IsA });
      expect(results).toHaveLength(1);
      expect(results[0]?.object).toBe("哺乳动物");
    });

    it("filters by negated explicitly", () => {
      const negatedOnly = store.match({ relation: CoreRelations.Can, negated: true });
      expect(negatedOnly).toHaveLength(1);
      expect(negatedOnly[0]?.subject).toBe("企鹅");

      const positiveOnly = store.match({ relation: CoreRelations.Can, negated: false });
      expect(positiveOnly).toHaveLength(1);
      expect(positiveOnly[0]?.subject).toBe("鸟");
    });

    it("returns an empty array when nothing matches", () => {
      expect(store.match({ subject: "不存在的东西" })).toEqual([]);
    });
  });

  describe("remove", () => {
    it("removes a record and cleans up all indexes", () => {
      const record = store.add(catIsMammal);
      store.add({ subject: "猫", relation: CoreRelations.Likes, object: "鱼", negated: false });

      store.remove(record.id);

      expect(store.all()).toHaveLength(1);
      expect(store.has(catIsMammal)).toBe(false);
      expect(store.match({ subject: "猫" })).toHaveLength(1);
      expect(store.match({ relation: CoreRelations.IsA })).toEqual([]);
    });

    it("is a no-op for an unknown id", () => {
      store.add(catIsMammal);
      expect(() => store.remove("does-not-exist")).not.toThrow();
      expect(store.all()).toHaveLength(1);
    });
  });

  describe("clear", () => {
    it("empties the store and all indexes", () => {
      store.add(catIsMammal);
      store.add(penguinCannotFly);
      store.clear();
      expect(store.all()).toEqual([]);
      expect(store.match({})).toEqual([]);
      expect(store.has(catIsMammal)).toBe(false);
    });
  });

  describe("addMany", () => {
    it("bulk-inserts pre-built records and skips ones whose id already exists", () => {
      const record = store.add(catIsMammal);
      const untouchedDuplicate = { ...record, confidence: 0.1 }; // same id, different data

      store.addMany([
        untouchedDuplicate,
        {
          id: "seed-1",
          subject: "苏格拉底",
          relation: CoreRelations.Is,
          object: "人",
          negated: false,
          confidence: 1,
          source: "seed",
          createdAt: new Date().toISOString(),
        },
      ]);

      expect(store.all()).toHaveLength(2);
      // existing id was NOT overwritten by the duplicate-id payload
      expect(store.all().find((r) => r.id === record.id)?.confidence).toBe(1);
      expect(store.match({ subject: "苏格拉底" })).toHaveLength(1);
    });
  });
});
