/**
 * Open ("object-of") query patterns: "A <关系>什么"
 *
 * Asks the reasoning engine to fill in the object of a relation, e.g.:
 *   猫属于什么   → find X such that 猫 属于 X
 *   猫是什么     → find X such that 猫 是 X
 *   鸟会什么     → find X such that 鸟 会 X
 *
 * Same rationale as `createStatementPattern`: one shared shape, factored into
 * a single factory parameterized by relation.
 */
import type { GrammarPattern, Relation } from "@/types";
import { escapeRegExp } from "@/utils";

export function createObjectOfPattern(relation: Relation): GrammarPattern {
  const relationPattern = escapeRegExp(relation);
  const pattern = new RegExp(`^(.+?)${relationPattern}什么$`, "u");

  return {
    name: `query:object-of:${relation}`,
    match(normalizedInput) {
      const matched = pattern.exec(normalizedInput);
      if (!matched) return null;

      const [, subject] = matched;
      if (!subject) return null;

      return {
        type: "query",
        subject,
        relation,
        kind: "object-of",
        raw: normalizedInput,
      };
    },
  };
}
