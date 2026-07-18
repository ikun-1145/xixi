import { describe, expect, it } from "vitest";
import { createRememberNameIntentMatcher } from "./rememberName";

describe("createRememberNameIntentMatcher", () => {
  const matcher = createRememberNameIntentMatcher();

  it.each([
    ["我叫刘锡泽", "刘锡泽"],
    ["我的名字是刘锡泽", "刘锡泽"],
    ["叫我锡泽", "锡泽"],
  ])("recognizes '%s' as RememberName with name entity '%s'", (input, name) => {
    const result = matcher.match(input);
    expect(result).not.toBeNull();
    expect(result?.entities).toEqual([name]);
    expect(matcher.intent).toBe("RememberName");
  });

  it("does not treat '我叫什么' as RememberName (would otherwise capture '什么' as a name)", () => {
    expect(matcher.match("我叫什么")).toBeNull();
  });

  it("does not recognize an unrelated sentence", () => {
    expect(matcher.match("猫属于哺乳动物")).toBeNull();
  });
});
