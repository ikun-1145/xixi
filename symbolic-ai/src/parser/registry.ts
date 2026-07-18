/**
 * Default grammar pattern registry.
 *
 * `RegexParser` tries patterns IN ORDER and returns the first match — so
 * ordering here is a real design decision, not an arbitrary list:
 *
 *   1. locate            "猫在哪里"
 *   2. why (all rel.)    "猫为什么属于生物" (Stage 7 — Response Planner's
 *                        `explain` cue; see `patterns/why.ts`)
 *   3. verify (all rel.) "企鹅是不是鸟" / "企鹅属不属于鸟" / "麻雀会不会飞"
 *   4. object-of (all)   "猫属于什么" / "猫是什么" / "鸟会什么"
 *   5. statement (all)   "猫属于哺乳动物" / "企鹅不会飞"
 *
 * Queries MUST be tried before statements. Both "猫属于什么" (a query) and
 * "猫属于哺乳动物" (a statement) share the substring "猫属于", so if the
 * generic statement pattern for 属于 ran first it would happily — but
 * incorrectly — parse "猫属于什么" as the statement (猫, 属于, "什么"),
 * treating the literal characters "什么" as an object instead of recognizing
 * the question. Trying the more specific query patterns first resolves this
 * ambiguity deterministically. The same reasoning applies to "why" patterns:
 * "猫为什么属于生物" would otherwise be mis-parsed as the statement
 * {subject: "猫为什么", relation: "属于", object: "生物"} (see `why.ts`).
 *
 * Similarly, verify patterns ("是不是") must precede object-of patterns
 * ("是什么") and statement patterns ("是") because they share a relation
 * prefix — but since their trailing literals ("不是" vs "什么" vs anything
 * else) never overlap, their relative order versus object-of doesn't matter;
 * they are grouped by kind here purely for readability. "Why" patterns never
 * overlap with verify/object-of either (they require the literal "为什么"
 * cue neither of those looks for), so its exact position among the other
 * query kinds doesn't matter — only that it precedes `statement`.
 *
 * Adding a new relation (e.g. a plugin introducing "害怕"): register one
 * statement + one object-of + one verify pattern for it. No existing pattern
 * needs to change — this is the Open/Closed Principle in practice.
 */
import { CoreRelations, type GrammarPattern, type Relation } from "@/types";
import {
  createLocatePattern,
  createObjectOfPattern,
  createStatementPattern,
  createVerifyPattern,
  createWhyPattern,
} from "./patterns";

/**
 * Relations that get the full statement / object-of / verify pattern trio.
 * `CoreRelations.LocatedIn` ("在") is deliberately included: without a way to
 * assert "猫在屋顶", the "猫在哪里" location query would have no facts to
 * ever match against.
 */
const RELATIONS_WITH_FULL_GRAMMAR: readonly Relation[] = [
  CoreRelations.IsA,
  CoreRelations.Is,
  CoreRelations.Can,
  CoreRelations.Likes,
  CoreRelations.LocatedIn,
];

export const defaultPatterns: readonly GrammarPattern[] = [
  createLocatePattern(),
  ...RELATIONS_WITH_FULL_GRAMMAR.map(createWhyPattern),
  ...RELATIONS_WITH_FULL_GRAMMAR.map(createVerifyPattern),
  ...RELATIONS_WITH_FULL_GRAMMAR.map(createObjectOfPattern),
  ...RELATIONS_WITH_FULL_GRAMMAR.map(createStatementPattern),
];
