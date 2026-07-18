/**
 * Default intent-matcher registry.
 *
 * `RegexParser` tries these BEFORE the statement/query grammar (see
 * `parser.ts`) — conversational moments like "你好" are recognized as
 * intents first, rather than falling through to "no matching grammar rule".
 * Order among the exact-phrase matchers (Greeting/Thanks/Farewell/
 * RecallName) doesn't matter relative to EACH OTHER (their phrase lists are
 * disjoint), but two orderings ARE load-bearing:
 *   - Identity is listed after those, since it uses looser keyword-based
 *     classification rather than an exact-phrase list — a future
 *     exact-phrase intent should still be tried before Identity's broader
 *     matching.
 *   - RecallName MUST precede RememberName: "我叫什么" would otherwise be
 *     captured by RememberName's `^我叫(.+)$` pattern as if "什么" were a
 *     name (see `rememberName.ts`'s doc comment).
 * Adding a new intent (Question/Time/Weather/Math/KnowledgeQuery/
 * MemoryQuery/Conversation/RememberAge/...) is exactly this: one new
 * matcher + one new line, never a change to existing entries.
 */
import type { IntentMatcher } from "@/types";
import { createFarewellIntentMatcher } from "./farewell";
import { createGreetingIntentMatcher } from "./greeting";
import { createIdentityIntentMatcher } from "./identity";
import { createRecallNameIntentMatcher } from "./recallName";
import { createRememberNameIntentMatcher } from "./rememberName";
import { createThanksIntentMatcher } from "./thanks";

export const defaultIntentMatchers: readonly IntentMatcher[] = [
  createGreetingIntentMatcher(),
  createThanksIntentMatcher(),
  createFarewellIntentMatcher(),
  createIdentityIntentMatcher(),
  createRecallNameIntentMatcher(),
  createRememberNameIntentMatcher(),
];
