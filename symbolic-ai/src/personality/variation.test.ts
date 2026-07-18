import { describe, expect, it } from "vitest";
import { pickBySeed } from "./variation";

describe("pickBySeed", () => {
  const pool = ["a", "b", "c", "d"] as const;

  it("is deterministic for the same seed", () => {
    expect(pickBySeed(pool, "猫:属于")).toBe(pickBySeed(pool, "猫:属于"));
  });

  it("always returns a member of the pool", () => {
    for (const seed of ["x", "y", "z", "猫", "企鹅", ""]) {
      expect(pool).toContain(pickBySeed(pool, seed));
    }
  });

  it("tends to vary across different seeds", () => {
    const results = new Set(["猫", "狗", "鸟", "鱼", "熊", "狼"].map((seed) => pickBySeed(pool, seed)));
    // Not a strict requirement that all differ, but a 4-item pool across 6
    // distinct seeds should not collapse to a single repeated value.
    expect(results.size).toBeGreaterThan(1);
  });

  it("throws for an empty pool", () => {
    expect(() => pickBySeed([], "seed")).toThrow();
  });
});
