import { describe, expect, it } from "vitest";
import { createConfidence, isConfidence } from "./types";

describe("semantic confidence", () => {
  it("accepts finite values in the inclusive range", () => {
    expect(createConfidence(0)).toBe(0);
    expect(createConfidence(0.5)).toBe(0.5);
    expect(createConfidence(1)).toBe(1);
  });

  it.each([-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid confidence %s",
    (value) => {
      expect(() => createConfidence(value)).toThrow(RangeError);
      expect(isConfidence(value)).toBe(false);
    },
  );

  it("recognizes valid confidence values at runtime", () => {
    expect(isConfidence(0.25)).toBe(true);
    expect(isConfidence("0.25")).toBe(false);
  });
});
