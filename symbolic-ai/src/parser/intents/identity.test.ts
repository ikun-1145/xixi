import { describe, expect, it } from "vitest";
import { createIdentityIntentMatcher } from "./identity";

describe("createIdentityIntentMatcher", () => {
  const matcher = createIdentityIntentMatcher();

  it("exposes the Identity intent", () => {
    expect(matcher.intent).toBe("Identity");
  });

  it.each<[string, string, string]>([
    ["你是谁", "Sunland AI", "identity"],
    ["你叫什么", "Sunland AI", "identity"],
    ["你叫什么名字", "Sunland AI", "identity"],
    ["Sunland AI是什么", "Sunland AI", "identity"],
    ["霜蓝是谁", "霜蓝", "identity"],
    ["frost是谁", "霜蓝", "identity"],
    ["你能做什么", "Sunland AI", "capability"],
    ["你会做什么", "Sunland AI", "capability"],
    ["是谁开发了你", "Sunland AI", "creator"],
    ["谁做的你", "Sunland AI", "creator"],
  ])("recognizes '%s' as subject=%s, aspect=%s", (input, subject, aspect) => {
    const match = matcher.match(input);
    expect(match).not.toBeNull();
    expect(match?.entities).toEqual([subject, aspect]);
    expect(match?.confidence).toBeGreaterThan(0);
  });

  it("does not fire on ordinary statements that merely mention '你'", () => {
    expect(matcher.match("你喜欢猫")).toBeNull();
  });

  it("does not fire on input with no self-reference at all", () => {
    expect(matcher.match("猫属于什么")).toBeNull();
  });

  it("prefers 'creator' over 'identity' when a question contains both '是谁' and '开发'", () => {
    const match = matcher.match("是谁开发了你");
    expect(match?.entities?.[1]).toBe("creator");
  });
});
