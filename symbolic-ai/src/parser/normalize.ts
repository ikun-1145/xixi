/**
 * Text normalization shared by every GrammarPattern.
 *
 * Chinese sentences are not whitespace-delimited ("猫属于哺乳动物"), but the
 * spec's examples are written with spaces for readability ("猫 属于 哺乳动物").
 * To support both without complicating every regex, we normalize ONCE before
 * any pattern runs:
 *
 *   1. strip all whitespace (spaces are never meaningful within these
 *      sentence patterns)
 *   2. strip trailing punctuation (？?！!。.，,；;) so "猫属于什么？" and
 *      "猫属于什么" are treated identically
 *
 * Every pattern factory can then assume a clean, punctuation-free string and
 * focus purely on grammar.
 */
const WHITESPACE = /\s+/gu;
const TRAILING_PUNCTUATION = /[?？!！。.,，;；]+$/u;

export function normalizeInput(raw: string): string {
  return raw.replace(WHITESPACE, "").replace(TRAILING_PUNCTUATION, "");
}
