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

export function createStatementPattern(relation: Relation): GrammarPattern {
  const relationPattern = escapeRegExp(relation);
  // group 1: subject (non-greedy)   group 2: optional negation "不"
  // group 3: object (greedy, consumes the remainder)
  const pattern = new RegExp(`^(.+?)(不)?${relationPattern}(.+)$`, "u");

  return {
    name: `statement:${relation}`,
    match(normalizedInput) {
      const matched = pattern.exec(normalizedInput);
      if (!matched) return null;

      const [, subject, negationMarker, object] = matched;
      if (!subject || !object) return null;

      return {
        type: "statement",
        subject,
        relation,
        object,
        negated: negationMarker === "不",
        raw: normalizedInput,
      };
    },
  };
}
