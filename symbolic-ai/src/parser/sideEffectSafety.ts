/**
 * Shared structural limits for Legacy side-effect parsing.
 *
 * These rules do not decide intent or reason about facts. They only define
 * whether a raw input is shaped like one bounded, auditable write operation.
 */
export const LEGACY_SIDE_EFFECT_LIMITS = Object.freeze({
  maxInputLength: 160,
  maxNameLength: 64,
  maxRelationMentions: 1,
});

const INTERNAL_CLAUSE_BOUNDARY = /[,，;；。.!！?？\r\n]/u;
const TRAILING_DECLARATIVE_PUNCTUATION = /[。.!！]+$/u;
const QUESTION_CUE =
  /[?？]|(?:是不是|会不会|有没有|能不能|属不属于|为什么|怎么|什么|啥|谁|哪里|哪儿|吗|呢)(?:[啊呀呢哦啦]?[。.!！]?)$/u;
const CHOICE_OR_SEQUENCE_CUE =
  /(?:还是|或者|或是|然后|并且|而且|同时|接着|另外)/u;
const PROHIBITION_CUE =
  /(?:不要|别|无需|不用|禁止)(?:再)?(?:记住|记|保存|学习|教)/u;
const KNOWN_RELATION_CUES = Object.freeze([
  "指的是",
  "意思是",
  "是一种",
  "属于",
  "喜欢",
  "拥有",
  "具备",
  "会",
  "有",
  "是",
  "在",
]);

export function stripTrailingDeclarativePunctuation(
  input: string,
): string {
  return input.trim().replace(TRAILING_DECLARATIVE_PUNCTUATION, "").trim();
}

export function hasInternalClauseBoundary(input: string): boolean {
  return INTERNAL_CLAUSE_BOUNDARY.test(
    stripTrailingDeclarativePunctuation(input),
  );
}

export function hasQuestionStructure(input: string): boolean {
  return QUESTION_CUE.test(input.trim());
}

export function hasChoiceOrSequenceStructure(input: string): boolean {
  return CHOICE_OR_SEQUENCE_CUE.test(input);
}

export function hasExplicitSideEffectProhibition(input: string): boolean {
  return PROHIBITION_CUE.test(input);
}

export function countKnownRelationMentions(input: string): number {
  let remaining = input;
  let count = 0;

  for (const cue of KNOWN_RELATION_CUES) {
    let index = remaining.indexOf(cue);
    while (index >= 0) {
      count += 1;
      remaining =
        remaining.slice(0, index) +
        " ".repeat(cue.length) +
        remaining.slice(index + cue.length);
      index = remaining.indexOf(cue);
    }
  }

  return count;
}

export function hasUnsafeLegacySideEffectStructure(
  raw: string,
): boolean {
  const input = raw.trim();
  return (
    input.length === 0 ||
    input.length > LEGACY_SIDE_EFFECT_LIMITS.maxInputLength ||
    hasInternalClauseBoundary(input) ||
    hasQuestionStructure(input) ||
    hasChoiceOrSequenceStructure(input) ||
    hasExplicitSideEffectProhibition(input) ||
    countKnownRelationMentions(input) >
      LEGACY_SIDE_EFFECT_LIMITS.maxRelationMentions
  );
}

export function normalizeCapturedValue(value: string): string {
  return stripTrailingDeclarativePunctuation(value)
    .replace(/\s+/gu, " ")
    .trim();
}
