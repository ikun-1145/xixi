/**
 * Location query pattern: "A在哪里"
 *
 * Unlike the other query patterns, "在哪里" is not parameterized by relation —
 * it is always about the built-in spatial relation `CoreRelations.LocatedIn`
 * ("在"). It is kept as its own file (rather than folded into
 * `createObjectOfPattern`) because "哪里" is a distinct question word from
 * "什么", so forcing it through the generic factory would require a special
 * case there — one dedicated pattern is clearer than a leaky abstraction.
 */
import type { GrammarPattern } from "@/types";
import { CoreRelations } from "@/types";

const LOCATE_PATTERN = /^(.+?)在哪里$/u;

export function createLocatePattern(): GrammarPattern {
  return {
    name: "query:locate",
    match(normalizedInput) {
      const matched = LOCATE_PATTERN.exec(normalizedInput);
      if (!matched) return null;

      const [, subject] = matched;
      if (!subject) return null;

      return {
        type: "query",
        subject,
        relation: CoreRelations.LocatedIn,
        kind: "locate",
        raw: normalizedInput,
      };
    },
  };
}
