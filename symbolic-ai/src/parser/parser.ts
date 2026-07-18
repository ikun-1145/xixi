/**
 * RegexParser — the concrete `Parser` implementation.
 *
 * Responsibility is deliberately narrow:
 *   1. normalize the raw input
 *   2. try each `IntentMatcher` in order, first match wins (conversational
 *      moments — "你好", "谢谢", "再见", ... — are recognized as an INTENT,
 *      not routed through the knowledge-teaching grammar below)
 *   3. otherwise, hand it to each GrammarPattern in order, first match wins
 *      (this is the pre-existing statement/query grammar, unchanged)
 *   4. stamp the result's `raw` field with the user's ORIGINAL (un-normalized)
 *      input, so downstream explanations quote exactly what the user typed
 *   5. if nothing matches, return a `ParseFailure` explaining why
 *
 * It holds no grammar/intent knowledge itself — that all lives in
 * `patterns/` and `intents/` respectively — so it never needs to change when
 * new sentence patterns OR new intents are added.
 */
import type { GrammarPattern, IntentMatcher, ParseResult, Parser } from "@/types";
import { defaultIntentMatchers } from "./intents";
import { normalizeInput } from "./normalize";
import { defaultPatterns } from "./registry";

export class RegexParser implements Parser {
  private readonly patterns: readonly GrammarPattern[];
  private readonly intentMatchers: readonly IntentMatcher[];

  constructor(
    patterns: readonly GrammarPattern[] = defaultPatterns,
    intentMatchers: readonly IntentMatcher[] = defaultIntentMatchers,
  ) {
    this.patterns = patterns;
    this.intentMatchers = intentMatchers;
  }

  parse(input: string): ParseResult {
    const normalized = normalizeInput(input);

    if (!normalized) {
      return { type: "unknown", raw: input, reason: "输入为空" };
    }

    for (const matcher of this.intentMatchers) {
      const match = matcher.match(normalized);
      if (match) {
        return {
          type: "intent",
          intent: matcher.intent,
          entities: match.entities ?? [],
          confidence: match.confidence,
          raw: input,
        };
      }
    }

    for (const pattern of this.patterns) {
      const result = pattern.match(normalized);
      if (result) {
        return { ...result, raw: input };
      }
    }

    return {
      type: "unknown",
      raw: input,
      reason: `没有匹配的语法规则："${normalized}"`,
    };
  }
}
