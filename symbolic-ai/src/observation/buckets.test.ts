import { describe, expect, it } from "vitest";
import {
  bucketDuration,
  bucketKnowledgeCount,
  bucketReasonerPath,
} from "./buckets";

describe("observation buckets", () => {
  it.each([
    [-1, "unavailable"],
    [Number.NaN, "unavailable"],
    [0, "under-1ms"],
    [0.999, "under-1ms"],
    [1, "1-5ms"],
    [4.999, "1-5ms"],
    [5, "5-16ms"],
    [15.999, "5-16ms"],
    [16, "16-50ms"],
    [49.999, "16-50ms"],
    [50, "over-50ms"],
  ] as const)("buckets duration %s", (value, expected) => {
    expect(bucketDuration(value)).toBe(expected);
  });

  it.each([
    [-1, "unavailable"],
    [1.5, "unavailable"],
    [0, "0"],
    [1, "1-99"],
    [99, "1-99"],
    [100, "100-999"],
    [999, "100-999"],
    [1_000, "1000-4999"],
    [4_999, "1000-4999"],
    [5_000, "5000-plus"],
  ] as const)("buckets knowledge count %s", (value, expected) => {
    expect(bucketKnowledgeCount(value)).toBe(expected);
  });

  it.each([
    [-1, "unavailable"],
    [1.5, "unavailable"],
    [0, "none"],
    [1, "direct"],
    [2, "2-5"],
    [5, "2-5"],
    [6, "6-20"],
    [20, "6-20"],
    [21, "21-50"],
    [50, "21-50"],
    [51, "51-plus"],
  ] as const)("buckets reasoner path %s", (value, expected) => {
    expect(bucketReasonerPath(value)).toBe(expected);
  });

  it("uses unavailable when a measurement is absent", () => {
    expect(bucketDuration(null)).toBe("unavailable");
    expect(bucketKnowledgeCount(null)).toBe("unavailable");
    expect(bucketReasonerPath(null)).toBe("unavailable");
  });
});
