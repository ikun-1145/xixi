import { describe, expect, it } from "vitest";
import { CoreRelations } from "@/types";
import { createVerifyPattern } from "./verify";

describe("createVerifyPattern", () => {
  it("derives '是不是' from the single-character relation '是'", () => {
    const pattern = createVerifyPattern(CoreRelations.Is);
    expect(pattern.match("企鹅是不是鸟")).toEqual({
      type: "query",
      subject: "企鹅",
      relation: "是",
      object: "鸟",
      kind: "verify",
      raw: "企鹅是不是鸟",
    });
  });

  it("derives '属不属于' from the two-character relation '属于'", () => {
    const pattern = createVerifyPattern(CoreRelations.IsA);
    expect(pattern.match("企鹅属不属于鸟")).toEqual({
      type: "query",
      subject: "企鹅",
      relation: "属于",
      object: "鸟",
      kind: "verify",
      raw: "企鹅属不属于鸟",
    });
  });

  it("derives '会不会' from the single-character relation '会'", () => {
    const pattern = createVerifyPattern(CoreRelations.Can);
    expect(pattern.match("麻雀会不会飞")).toEqual({
      type: "query",
      subject: "麻雀",
      relation: "会",
      object: "飞",
      kind: "verify",
      raw: "麻雀会不会飞",
    });
  });

  it("returns null when the reduplicated interrogative is absent", () => {
    const pattern = createVerifyPattern(CoreRelations.Is);
    expect(pattern.match("企鹅是鸟")).toBeNull();
  });
});
