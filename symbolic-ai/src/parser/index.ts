/**
 * MODULE: parser
 * Responsibility: turn raw text into a `ParseResult` using grammar patterns.
 * Depends on: types + utils only. Must NOT import knowledge/reasoners/ui.
 *
 * Public API:
 *   - createParser()       convenience factory (default grammar + intents)
 *   - RegexParser          the class, for custom/plugin pattern/intent sets
 *   - defaultPatterns      the built-in grammar pattern list
 *   - defaultIntentMatchers the built-in intent matcher list
 *   - create*Pattern(...)  factories for authoring new GrammarPatterns
 *   - create*IntentMatcher() factories for authoring new IntentMatchers
 *   - normalizeInput(...)  shared text normalization
 */
import type { Parser } from "@/types";
import { RegexParser } from "./parser";

export * from "./normalize";
export * from "./patterns";
export * from "./registry";
export * from "./intents";
export * from "./parser";

/** Convenience factory returning a parser configured with the default grammar. */
export function createParser(): Parser {
  return new RegexParser();
}
