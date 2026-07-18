/**
 * Greeting intent — "你好"/"您好"/"哈喽"/"Hi"/"Hello"/"嗨"/... all collapse to
 * ONE intent, `Greeting`, instead of six independent grammar rules. Adding a
 * new way to say hello later is one more string in `GREETING_PHRASES`, not a
 * new pattern/branch anywhere else.
 */
import type { IntentMatcher } from "@/types";
import { createKeywordIntentMatcher } from "./keywordMatcher";

export const GREETING_PHRASES: readonly string[] = [
  "你好",
  "您好",
  "哈喽",
  "哈啰",
  "嗨",
  "hi",
  "hello",
  "hey",
];

export function createGreetingIntentMatcher(): IntentMatcher {
  return createKeywordIntentMatcher("Greeting", GREETING_PHRASES);
}
