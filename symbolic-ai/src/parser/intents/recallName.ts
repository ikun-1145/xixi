import type { IntentMatcher } from "@/types";
import { createKeywordIntentMatcher } from "./keywordMatcher";

/**
 * "我叫什么？" / "你知道我的名字吗" / "你记得我的名字吗" -- a closed set of
 * phrasings (same shape as Greeting/Thanks/Farewell), so this reuses
 * `createKeywordIntentMatcher` directly rather than needing its own regex
 * logic.
 *
 * MUST be registered BEFORE `RememberName` in the intent registry: without
 * that ordering, "我叫什么" would otherwise fall through to
 * `RememberName`'s `^我叫(.+)$` pattern and be misread as the user naming
 * themselves "什么". (`RememberName` also keeps its own defensive guard
 * against this, but the registry order is the primary safeguard, exactly
 * like "verify" patterns must precede "object-of" patterns in
 * `parser/registry.ts`.)
 */
export const RECALL_NAME_PHRASES: readonly string[] = [
  "我叫什么",
  "我叫什么名字",
  "你知道我的名字吗",
  "你记得我的名字吗",
];

export function createRecallNameIntentMatcher(): IntentMatcher {
  return createKeywordIntentMatcher("RecallName", RECALL_NAME_PHRASES);
}
