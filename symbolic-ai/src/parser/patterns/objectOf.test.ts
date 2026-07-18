import { describe, expect, it } from "vitest";
import { CoreRelations } from "@/types";
import { createObjectOfPattern } from "./objectOf";

describe("createObjectOfPattern", () => {
  it("parses '属于什么' as an object-of query", () => {
    const pattern = createObjectOfPattern(CoreRelations.IsA);
    expect(pattern.match("猫属于什么")).toEqual({
      type: "query",
      subject: "猫",
      relation: "属于",
      kind: "object-of",
      raw: "猫属于什么",
    });
  });

  it("parses '会什么' as an object-of query", () => {
    const pattern = createObjectOfPattern(CoreRelations.Can);
    expect(pattern.match("鸟会什么")).toEqual({
      type: "query",
      subject: "鸟",
      relation: "会",
      kind: "object-of",
      raw: "鸟会什么",
    });
  });

  it("requires the literal '什么' suffix", () => {
    const pattern = createObjectOfPattern(CoreRelations.Is);
    expect(pattern.match("猫是哺乳动物")).toBeNull();
  });

  it("returns null when there is no subject", () => {
    const pattern = createObjectOfPattern(CoreRelations.Is);
    expect(pattern.match("是什么")).toBeNull();
  });
});
