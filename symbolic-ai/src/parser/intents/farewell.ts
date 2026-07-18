/**
 * Farewell intent — "再见"/"拜拜"/"bye"/... all collapse to ONE intent,
 * `Farewell`. See `greeting.ts` for the shared design rationale.
 */
import type { IntentMatcher } from "@/types";
import { createKeywordIntentMatcher } from "./keywordMatcher";

export const FAREWELL_PHRASES: readonly string[] = [
  "再见",
  "拜拜",
  "88",
  "bye",
  "goodbye",
  "see you",
];

export function createFarewellIntentMatcher(): IntentMatcher {
  return createKeywordIntentMatcher("Farewell", FAREWELL_PHRASES);
}
