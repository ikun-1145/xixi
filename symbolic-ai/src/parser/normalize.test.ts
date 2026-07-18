import { describe, expect, it } from "vitest";
import { normalizeInput } from "./normalize";

describe("normalizeInput", () => {
  it("removes internal and surrounding whitespace", () => {
    expect(normalizeInput("猫 属于 哺乳动物")).toBe("猫属于哺乳动物");
    expect(normalizeInput("  猫属于哺乳动物  ")).toBe("猫属于哺乳动物");
  });

  it("strips trailing Chinese and Western punctuation", () => {
    expect(normalizeInput("猫属于什么？")).toBe("猫属于什么");
    expect(normalizeInput("猫属于什么?")).toBe("猫属于什么");
    expect(normalizeInput("企鹅是不是鸟。")).toBe("企鹅是不是鸟");
  });

  it("is idempotent for already-normalized input", () => {
    expect(normalizeInput("猫属于哺乳动物")).toBe("猫属于哺乳动物");
  });

  it("collapses to an empty string for blank input", () => {
    expect(normalizeInput("   ")).toBe("");
    expect(normalizeInput("")).toBe("");
  });
});
