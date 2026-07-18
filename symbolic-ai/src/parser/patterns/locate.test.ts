import { describe, expect, it } from "vitest";
import { createLocatePattern } from "./locate";

describe("createLocatePattern", () => {
  const pattern = createLocatePattern();

  it("parses '在哪里' as a locate query", () => {
    expect(pattern.match("猫在哪里")).toEqual({
      type: "query",
      subject: "猫",
      relation: "在",
      kind: "locate",
      raw: "猫在哪里",
    });
  });

  it("returns null without the '在哪里' suffix", () => {
    expect(pattern.match("猫在屋顶")).toBeNull();
  });

  it("returns null when there is no subject", () => {
    expect(pattern.match("在哪里")).toBeNull();
  });
});
