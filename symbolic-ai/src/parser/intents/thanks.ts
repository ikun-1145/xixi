/**
 * Thanks intent — "谢谢"/"感谢"/"thanks"/... all collapse to ONE intent,
 * `Thanks`. See `greeting.ts` for the shared design rationale.
 */
import type { IntentMatcher } from "@/types";
import { createKeywordIntentMatcher } from "./keywordMatcher";

export const THANKS_PHRASES: readonly string[] = [
  "谢谢",
  "谢了",
  "感谢",
  "多谢",
  "thanks",
  "thank you",
  "thx",
];

export function createThanksIntentMatcher(): IntentMatcher {
  return createKeywordIntentMatcher("Thanks", THANKS_PHRASES);
}
