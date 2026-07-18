import { describe, expect, it } from "vitest";
import { createKeywordIntentMatcher } from "./keywordMatcher";

describe("createKeywordIntentMatcher", () => {
  const matcher = createKeywordIntentMatcher("Greeting", ["你好", "hi"], 0.9);

  it("matches an exact phrase in the list", () => {
    expect(matcher.match("你好")).toEqual({ entities: [], confidence: 0.9 });
  });

  it("is case-insensitive for ASCII phrases", () => {
    expect(matcher.match("HI")).toEqual({ entities: [], confidence: 0.9 });
    expect(matcher.match("Hi")).toEqual({ entities: [], confidence: 0.9 });
  });

  it("tolerates a trailing filler character", () => {
    expect(matcher.match("你好呀")).toEqual({ entities: [], confidence: 0.9 });
    expect(matcher.match("你好啊")).toEqual({ entities: [], confidence: 0.9 });
    expect(matcher.match("hi~")).toEqual({ entities: [], confidence: 0.9 });
  });

  it("returns null for input outside the phrase list", () => {
    expect(matcher.match("你好厉害")).toBeNull();
    expect(matcher.match("再见")).toBeNull();
  });

  it("exposes the intent it was built for", () => {
    expect(matcher.intent).toBe("Greeting");
  });

  it("defaults confidence to 0.95 when not provided", () => {
    const defaulted = createKeywordIntentMatcher("Thanks", ["谢谢"]);
    expect(defaulted.match("谢谢")).toEqual({ entities: [], confidence: 0.95 });
  });
});
