import { describe, expect, it } from "vitest";
import { CoreRelations } from "@/types";
import { createStatementPattern } from "./statement";

describe("createStatementPattern", () => {
  const isAPattern = createStatementPattern(CoreRelations.IsA); // 属于
  const canPattern = createStatementPattern(CoreRelations.Can); // 会

  it("parses a plain (non-negated) statement", () => {
    expect(isAPattern.match("猫属于哺乳动物")).toEqual({
      type: "statement",
      subject: "猫",
      relation: "属于",
      object: "哺乳动物",
      negated: false,
      raw: "猫属于哺乳动物",
    });
  });

  it("parses a negated statement", () => {
    expect(canPattern.match("企鹅不会飞")).toEqual({
      type: "statement",
      subject: "企鹅",
      relation: "会",
      object: "飞",
      negated: true,
      raw: "企鹅不会飞",
    });
  });

  it("returns null when the relation is absent", () => {
    expect(isAPattern.match("猫喜欢鱼")).toBeNull();
  });

  it("returns null when subject or object would be empty", () => {
    expect(isAPattern.match("属于哺乳动物")).toBeNull(); // no subject
    expect(isAPattern.match("猫属于")).toBeNull(); // no object
  });

  it("is parameterized per relation with no shared mutable state", () => {
    const likesPattern = createStatementPattern(CoreRelations.Likes);
    expect(likesPattern.match("猫喜欢鱼")).toMatchObject({
      subject: "猫",
      relation: "喜欢",
      object: "鱼",
      negated: false,
    });
    // A pattern only recognizes its own relation.
    expect(likesPattern.match("猫属于哺乳动物")).toBeNull();
  });
});
