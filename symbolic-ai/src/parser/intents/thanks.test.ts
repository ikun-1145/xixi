import { describe, expect, it } from "vitest";
import { createThanksIntentMatcher, THANKS_PHRASES } from "./thanks";

describe("createThanksIntentMatcher", () => {
  const matcher = createThanksIntentMatcher();

  it.each(THANKS_PHRASES)("recognizes '%s' as Thanks", (phrase) => {
    const result = matcher.match(phrase);
    expect(result).not.toBeNull();
    expect(matcher.intent).toBe("Thanks");
  });

  it("does not recognize an unrelated sentence", () => {
    expect(matcher.match("再见")).toBeNull();
  });
});
