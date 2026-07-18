/**
 * "Why" verify-query patterns: "A为什么<关系>B" — Chinese's natural
 * wh-in-situ phrasing for "why does A relate to B" (e.g. "猫为什么属于生物"),
 * i.e. the wh-word sits where the answer would go, not fronted.
 *
 * Structurally this is a "verify" query (a specific subject/object pair)
 * exactly like `createVerifyPattern`'s "A关系不关系B" form, PLUS an explicit
 * request that the ANSWER include its derivation — the `explain` flag the
 * Response Planner (Stage 7) uses to decide whether to surface Evidence.
 * The Parser only detects this cue; it never decides what to DO with it.
 *
 * Must be tried before the generic statement pattern for the same relation
 * (see `registry.ts`), otherwise "猫为什么属于生物" would be mis-parsed as
 * the statement {subject: "猫为什么", relation: "属于", object: "生物"} —
 * the same category of ambiguity already documented there for
 * object-of-vs-statement.
 *
 * Known v1 limitation (acceptable, not in scope yet): combining this with
 * the reduplicated interrogative form ("猫为什么属不属于生物") is not
 * recognized — only the plain infix form is.
 */
import type { GrammarPattern, Relation } from "@/types";
import { escapeRegExp } from "@/utils";

export function createWhyPattern(relation: Relation): GrammarPattern {
  const relationPattern = escapeRegExp(relation);
  const pattern = new RegExp(`^(.+?)为什么${relationPattern}(.+)$`, "u");

  return {
    name: `query:why:${relation}`,
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
        explain: true,
        raw: normalizedInput,
      };
    },
  };
}
