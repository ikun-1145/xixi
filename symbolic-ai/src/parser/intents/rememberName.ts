import type { IntentMatch, IntentMatcher } from "@/types";

/**
 * RememberName intent: "我叫刘锡泽" / "我的名字是刘锡泽" / "叫我锡泽".
 *
 * Unlike Greeting/Thanks/Farewell/RecallName (closed phrase lists), the name
 * itself is free text, not one of a fixed set of phrasings -- so this is
 * pattern-based (a capture group), mirroring how `parser/patterns/objectOf
 * .ts` captures a variable subject via `(.+?)`, rather than an exact-match
 * `Set`.
 *
 * MUST be registered AFTER `RecallName` in the intent registry (see that
 * file's doc comment) -- a defensive `QUESTION_WORDS` guard is also kept
 * here so this stays correct even if the registry order ever changes.
 */

const NAME_PATTERNS: readonly RegExp[] = [/^我叫(.+)$/u, /^我的名字是(.+)$/u, /^叫我(.+)$/u];

const QUESTION_WORDS = new Set(["什么", "什么名字", "谁"]);

export function createRememberNameIntentMatcher(): IntentMatcher {
  return {
    intent: "RememberName",
    match(normalizedInput): IntentMatch | null {
      for (const pattern of NAME_PATTERNS) {
        const matched = pattern.exec(normalizedInput);
        if (!matched) continue;
        const [, name] = matched;
        if (!name || QUESTION_WORDS.has(name)) return null;
        return { entities: [name], confidence: 0.95 };
      }
      return null;
    },
  };
}
