import { describe, expect, it } from "vitest";
import { createGreetingIntentMatcher, GREETING_PHRASES } from "./greeting";

describe("createGreetingIntentMatcher", () => {
  const matcher = createGreetingIntentMatcher();

  it.each(GREETING_PHRASES)("recognizes '%s' as Greeting", (phrase) => {
    const result = matcher.match(phrase);
    expect(result).not.toBeNull();
    expect(matcher.intent).toBe("Greeting");
  });

  it("does not recognize an unrelated sentence", () => {
    expect(matcher.match("猫属于哺乳动物")).toBeNull();
  });
});
