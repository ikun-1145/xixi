import { describe, expect, it } from "vitest";
import { createWhyPattern } from "./why";
import { CoreRelations } from "@/types";

describe("createWhyPattern", () => {
  const pattern = createWhyPattern(CoreRelations.IsA);

  it("parses 'A为什么关系B' as a verify query with explain: true", () => {
    const result = pattern.match("猫为什么属于生物");
    expect(result).toEqual({
      type: "query",
      subject: "猫",
      relation: "属于",
      object: "生物",
      kind: "verify",
      explain: true,
      raw: "猫为什么属于生物",
    });
  });

  it("returns null when the relation is absent", () => {
    expect(pattern.match("猫属于生物")).toBeNull();
  });

  it("returns null when there is no subject before 为什么", () => {
    expect(pattern.match("为什么属于生物")).toBeNull();
  });

  it("returns null when there is no object after the relation", () => {
    expect(pattern.match("猫为什么属于")).toBeNull();
  });

  it("does not match a different relation's why-pattern", () => {
    const canPattern = createWhyPattern(CoreRelations.Can);
    expect(canPattern.match("猫为什么属于生物")).toBeNull();
  });
});
