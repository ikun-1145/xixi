import { describe, expect, it } from "vitest";
import { createRecallNameIntentMatcher, RECALL_NAME_PHRASES } from "./recallName";

describe("createRecallNameIntentMatcher", () => {
  const matcher = createRecallNameIntentMatcher();

  it.each(RECALL_NAME_PHRASES)("recognizes '%s' as RecallName", (phrase) => {
    const result = matcher.match(phrase);
    expect(result).not.toBeNull();
    expect(result?.entities).toEqual([]);
    expect(matcher.intent).toBe("RecallName");
  });

  it("does not recognize an unrelated sentence", () => {
    expect(matcher.match("猫属于哺乳动物")).toBeNull();
  });

  it("does not recognize a RememberName-shaped sentence", () => {
    expect(matcher.match("我叫刘锡泽")).toBeNull();
  });
});
