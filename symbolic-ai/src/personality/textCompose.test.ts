import { describe, expect, it } from "vitest";
import { compose } from "./textCompose";

describe("compose", () => {
  it("joins non-empty parts with a single space", () => {
    expect(compose("a", "b", "c")).toBe("a b c");
  });

  it("skips undefined, null, and empty-string parts", () => {
    expect(compose("a", "", "b", undefined, "c", null)).toBe("a b c");
  });

  it("returns an empty string when given no usable parts", () => {
    expect(compose(undefined, null, "")).toBe("");
  });
});
