import { describe, expect, it } from "vitest";
import { createFarewellIntentMatcher, FAREWELL_PHRASES } from "./farewell";

describe("createFarewellIntentMatcher", () => {
  const matcher = createFarewellIntentMatcher();

  it.each(FAREWELL_PHRASES)("recognizes '%s' as Farewell", (phrase) => {
    const result = matcher.match(phrase);
    expect(result).not.toBeNull();
    expect(matcher.intent).toBe("Farewell");
  });

  it("does not recognize an unrelated sentence", () => {
    expect(matcher.match("谢谢")).toBeNull();
  });
});
