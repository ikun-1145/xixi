/**
 * Statement patterns: "A [不] <关系> B"
 *
 * Covers every declarative fact the user can teach the system, e.g.:
 *   猫属于哺乳动物   → { subject: "猫", relation: "属于", object: "哺乳动物", negated: false }
 *   企鹅不会飞       → { subject: "企鹅", relation: "会",  object: "飞",      negated: true  }
 *
 * `createStatementPattern` is a factory, not a one-off pattern, because every
 * core relation (属于/是/会/喜欢/在) shares an IDENTICAL grammar shape — only
 * the relation word differs. Factoring this out means adding a brand new
 * relation is a single line in `registry.ts`, never a copy-pasted regex.
 */
import type { GrammarPattern, Relation } from "@/types";
import { escapeRegExp } from "@/utils";
import {
  hasUnsafeLegacySideEffectStructure,
  normalizeCapturedValue,
} from "../sideEffectSafety";

function whitespaceTolerantLiteral(value: string): string {
  return [...value]
    .map((character) => escapeRegExp(character))
    .join("\\s*");
}

export function createStatementPattern(
  relation: Relation,
  aliases: readonly string[] = [relation],
): GrammarPattern {
  const relationPattern = [...aliases]
    .sort((left, right) => right.length - left.length)
    .map(whitespaceTolerantLiteral)
    .join("|");
  // group 1: subject (non-greedy)   group 2: optional negation "不"
  // group 3: object. Matching raw input preserves meaningful entity spaces.
  const pattern = new RegExp(
    `^\\s*(.+?)\\s*(不|没)?\\s*(?:${relationPattern})\\s*(.+?)\\s*[。.!！]*\\s*$`,
    "u",
  );

  return {
    name: `statement:${relation}`,
    match(normalizedInput, rawInput) {
      const input = rawInput ?? normalizedInput;
      if (hasUnsafeLegacySideEffectStructure(input)) {
        return null;
      }

      const matched = pattern.exec(input);
      if (!matched) return null;

      const [, subject, negationMarker, object] = matched;
      if (!subject || !object) return null;
      const cleanSubject = normalizeCapturedValue(subject);
      const cleanObject = normalizeCapturedValue(object);
      if (!cleanSubject || !cleanObject) return null;

      return {
        type: "statement",
        subject: cleanSubject,
        relation,
        object: cleanObject,
        negated: negationMarker === "不" || negationMarker === "没",
        raw: input,
      };
    },
  };
}
