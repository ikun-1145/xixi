/**
 * Generic keyword-based `IntentMatcher` factory.
 *
 * Several intents (Greeting/Thanks/Farewell, and likely more later) share an
 * IDENTICAL recognition shape: a short, closed list of phrasings that all
 * mean the exact same thing ("你好"/"您好"/"哈喽"/"Hi"/"Hello"/"嗨" all mean
 * Greeting). Factoring the matching logic out here means recognizing a new
 * intent of this kind is ONE phrase array + ONE factory call — never a new
 * `if/else` branch, and never six copy-pasted near-identical rules for what
 * is conceptually one rule ("this input is intent X").
 *
 * Deliberately narrow, on purpose:
 *   - case-insensitive (so "Hi"/"HI"/"hi" are equivalent) — Chinese text is
 *     unaffected by `.toLowerCase()`.
 *   - whitespace-insensitive (so "thank you" and "see you" — phrases written
 *     with a space for readability — still match after `RegexParser`'s
 *     shared `normalizeInput()` has already stripped ALL whitespace from the
 *     real input before it ever reaches a matcher); phrases are normalized
 *     the same way when the lookup table is built, so both sides agree.
 *   - tolerant of a trailing filler character (呀/啊/呢/哦/啦/~/～), so casual
 *     variants like "你好呀"/"嗨~" still match — this is a small, LOCAL
 *     normalization scoped to intent-matching only; it does NOT touch
 *     `normalizeInput()` itself (shared by the statement/query grammar) so
 *     nothing about existing knowledge-teaching parsing changes.
 *   - otherwise an EXACT match against the phrase list, not substring
 *     search — "你好厉害" (a compliment) must NOT be recognized as a
 *     Greeting. Broader fuzzy matching is an explicit non-goal for now.
 */
import type { IntentMatcher, IntentName } from "@/types";

const WHITESPACE = /\s+/gu;
const TRAILING_FILLER = /[呀啊呢哦啦~～]+$/u;

/** Same key-normalization applied to both the phrase table and live input. */
function normalizeKey(input: string): string {
  return input.replace(WHITESPACE, "").replace(TRAILING_FILLER, "").toLowerCase();
}

/**
 * Build an `IntentMatcher` that recognizes `intent` whenever the input,
 * after this matcher's own key-normalization, exactly equals one of
 * `phrases` (also key-normalized). Input is expected to have already been
 * through `RegexParser`'s shared `normalizeInput()`, but `normalizeKey` is
 * idempotent, so calling this matcher directly with an un-normalized string
 * (as tests do) still behaves correctly.
 */
export function createKeywordIntentMatcher(
  intent: IntentName,
  phrases: readonly string[],
  confidence = 0.95,
): IntentMatcher {
  const table = new Set(phrases.map(normalizeKey));

  return {
    intent,
    match(normalizedInput) {
      if (!table.has(normalizeKey(normalizedInput))) return null;
      return { entities: [], confidence };
    },
  };
}
