import type { IntentMatch, IntentMatcher } from "@/types";
import {
  countKnownRelationMentions,
  hasChoiceOrSequenceStructure,
  hasUnsafeLegacySideEffectStructure,
  LEGACY_SIDE_EFFECT_LIMITS,
  normalizeCapturedValue,
} from "../sideEffectSafety";

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

const NAME_PATTERNS: readonly RegExp[] = [
  /^我\s*叫\s*(.+)$/iu,
  /^我的名字\s*是\s*(.+)$/iu,
  /^你可以\s*叫我\s*(.+)$/iu,
  /^叫我\s*(.+)$/iu,
];

const QUESTION_WORDS = new Set(["什么", "什么名字", "谁"]);
const GREETING_PREFIX =
  /^(?:你好|您好|嗨|哈喽|hello|hi)[,，]\s*/iu;
const TRAILING_FILLER = /[呀啊呢哦啦吧~～]+$/u;
const ONLY_PUNCTUATION = /^[\p{P}\p{S}\s]+$/u;

function extractSafeName(input: string): string | null {
  const singleOperation = input.trim().replace(GREETING_PREFIX, "");
  if (hasUnsafeLegacySideEffectStructure(singleOperation)) {
    return null;
  }

  for (const pattern of NAME_PATTERNS) {
    const matched = pattern.exec(singleOperation);
    if (!matched) continue;
    const name = normalizeCapturedValue(matched[1] ?? "")
      .replace(TRAILING_FILLER, "")
      .trim();
    if (
      name.length === 0 ||
      name.length > LEGACY_SIDE_EFFECT_LIMITS.maxNameLength ||
      QUESTION_WORDS.has(name) ||
      ONLY_PUNCTUATION.test(name) ||
      hasChoiceOrSequenceStructure(name) ||
      countKnownRelationMentions(name) > 0
    ) {
      return null;
    }
    return name;
  }

  return null;
}

export function createRememberNameIntentMatcher(): IntentMatcher {
  return {
    intent: "RememberName",
    match(normalizedInput, rawInput): IntentMatch | null {
      const name = extractSafeName(rawInput ?? normalizedInput);
      return name === null
        ? null
        : { entities: [name], confidence: 0.95 };
    },
  };
}
