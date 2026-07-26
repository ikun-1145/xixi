import { describe, expect, it } from "vitest";
import { createRememberNameIntentMatcher } from "./rememberName";

describe("createRememberNameIntentMatcher", () => {
  const matcher = createRememberNameIntentMatcher();

  it.each([
    ["我叫刘锡泽", "刘锡泽"],
    ["我的名字是刘锡泽", "刘锡泽"],
    ["叫我锡泽", "锡泽"],
    ["你可以叫我霜蓝", "霜蓝"],
    ["我的名字是 Alice Chen", "Alice Chen"],
    ["你好，我叫小明", "小明"],
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

  it.each([
    "名字小明",
    "我不是小明",
    "不要记住我叫小明",
    "我叫小明，猫属于动物",
    "我叫",
    "我叫？？？",
  ])("rejects unsafe or incomplete name input '%s'", (input) => {
    expect(matcher.match(input)).toBeNull();
  });
});
