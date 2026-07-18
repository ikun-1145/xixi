/**
 * Yes/no ("verify") query patterns using Mandarin's standard "A-not-AB"
 * reduplicated interrogative: "A <关系不关系> B"
 *
 *   企鹅是不是鸟     ("是"  → "是不是")   → verify 企鹅 是 鸟 ?
 *   企鹅属不属于鸟   ("属于" → "属不属于") → verify 企鹅 属于 鸟 ?
 *   麻雀会不会飞     ("会"  → "会不会")   → verify 麻雀 会 飞 ?
 *
 * The interrogative form is DERIVED from the relation itself
 * (firstChar + "不" + relation) rather than passed in separately. This is a
 * real Mandarin grammar rule (反复问句), not a coincidence — it means every
 * new relation automatically gets a working verify-query for free, with zero
 * extra configuration.
 */
import type { GrammarPattern, Relation } from "@/types";
import { escapeRegExp } from "@/utils";

function deriveReduplicatedInterrogative(relation: Relation): string {
  return `${relation.charAt(0)}不${relation}`;
}

export function createVerifyPattern(relation: Relation): GrammarPattern {
  const interrogative = deriveReduplicatedInterrogative(relation);
  const interrogativePattern = escapeRegExp(interrogative);
  const pattern = new RegExp(`^(.+?)${interrogativePattern}(.+)$`, "u");

  return {
    name: `query:verify:${relation}`,
    match(normalizedInput) {
      const matched = pattern.exec(normalizedInput);
      if (!matched) return null;

      const [, subject, object] = matched;
      if (!subject || !object) return null;

      return {
        type: "query",
        subject,
        relation,
        object,
        kind: "verify",
        raw: normalizedInput,
      };
    },
  };
}
