/**
 * Parser contracts.
 *
 * The parser turns natural-language input into a structured object using
 * grammar rules + regular expressions only. NO AI / NO LLM.
 *
 * Output is a discriminated union so consumers can exhaustively switch on
 * `result.type`.
 */
import type { Relation } from "./knowledge";

/** A declarative fact provided by the user, e.g. "猫 属于 哺乳动物". */
export interface ParsedStatement {
  readonly type: "statement";
  readonly subject: string;
  readonly relation: Relation;
  readonly object: string;
  readonly negated: boolean;
  /** Original untouched input, for explainability. */
  readonly raw: string;
}

/**
 * The shape of a question.
 * - "object-of": open question, e.g. 猫 属于什么 / 猫 是什么 / 鸟 会什么
 * - "verify":    yes/no question, e.g. 企鹅 是不是 鸟 / 麻雀 会不会 飞
 * - "locate":    where question, e.g. 猫 在哪里
 */
export type QueryKind = "object-of" | "verify" | "locate";

/** A question to be answered by the reasoning engine. */
export interface ParsedQuery {
  readonly type: "query";
  readonly subject: string;
  readonly relation: Relation;
  /** Present only for "verify" queries (the candidate object). */
  readonly object?: string;
  readonly kind: QueryKind;
  /**
   * True when the user explicitly asked "why" using Chinese's natural
   * wh-in-situ "为什么" phrasing (e.g. "猫为什么属于生物" — see
   * `parser/patterns/why.ts`), requesting that the answer surface its
   * derivation rather than just the verdict. The Parser only detects and
   * forwards this signal, as plain extracted structure — deciding whether
   * to actually ACT on it (i.e. show Evidence) is the Response Planner's
   * job (Stage 7), never the Parser's and never Personality's.
   */
  readonly explain?: boolean;
  readonly raw: string;
}

/** Emitted when no grammar pattern matched. */
export interface ParseFailure {
  readonly type: "unknown";
  readonly raw: string;
  /** Machine/human hint about why parsing failed. */
  readonly reason: string;
}

/**
 * Known conversational intents (Stage 4 — Basic Understanding). This is
 * deliberately a plain string union, not an open `string`: adding a new
 * intent is a conscious, reviewable step (one new literal here + one new
 * `IntentMatcher` + one registry line — see `parser/intents/`), never an
 * ad-hoc runtime string. It is NOT a replacement for the `Reasoner` (Stage
 * 4's other half, still on hold) — intents are surface-level conversational
 * moments (greetings, thanks, small talk), not factual reasoning.
 *
 * "Identity" is the first intent whose answer is NOT a static phrase bank:
 * "你是谁"/"Sunland AI 是什么"/"你能做什么"/"是谁开发了你" are resolved
 * against real facts in a knowledge store (see `knowledge/selfKnowledge.ts`
 * and `engine/sunlandEngine.ts`'s `answerIdentity`), then rendered by
 * Personality — Knowledge + Personality composing an answer together, ahead
 * of the future Knowledge Engine, rather than Personality (or the Parser)
 * hardcoding what Sunland AI "is".
 *
 * "RememberName"/"RecallName" (Stage 5 — Memory Foundation) are the first
 * intents backed by a `MemoryManager` instead of a `KnowledgeStore`: facts
 * ABOUT the user (their name), not world knowledge and not the AI's own
 * identity. Deliberately separate literal intents per remembered field
 * (matching the user's own naming: future rounds add "RememberAge"/
 * "RecallAge", "RememberPreference"/"RecallPreference", ... rather than one
 * generic "Remember"/"Recall" intent) — this keeps each field's Parser-side
 * extraction and Personality-side phrasing independently reviewable.
 */
export type IntentName =
  | "Greeting"
  | "Thanks"
  | "Farewell"
  | "Identity"
  | "RememberName"
  | "RecallName";

/**
 * Which aspect of "self" an Identity question is asking about. A closed
 * union (not an open `string`) because exactly these three shapes of answer
 * exist today — resolved into `ParsedIntent.entities[1]` by the Identity
 * matcher, then narrowed back to this type by the engine before it becomes
 * part of a `ResponseContext` (see `types/personality.ts`).
 */
export type IdentityAspect = "identity" | "capability" | "creator";

/**
 * A recognized conversational intent, e.g. "你好"/"Hi"/"嗨" all collapse to
 * `{ intent: "Greeting" }` — the Parser identifies WHAT the user means, not
 * which of the many possible phrasings they used. `entities` is reserved for
 * future intents that carry extracted data (e.g. a `Time` intent capturing
 * "明天"); it is always `[]` for the purely-conversational intents below.
 * For `Identity` specifically, `entities` is `[subject, aspect]` — e.g.
 * `["Sunland AI", "capability"]` for "你能做什么", or `["霜蓝", "identity"]`
 * for "霜蓝是谁" — see `parser/intents/identity.ts`. For `RememberName`,
 * `entities` is `[name]` — e.g. `["刘锡泽"]` for "我叫刘锡泽" — the free-text
 * name the user gave, extracted (never invented) by the Parser; `RecallName`
 * needs no entities (always `[]`), it's a pure request to look one up.
 * `confidence` lets Personality/Reasoner (later) treat a fuzzy/ambiguous
 * match differently from a clean one, without the Parser needing to know
 * what "differently" means.
 */
export interface ParsedIntent {
  readonly type: "intent";
  readonly intent: IntentName;
  readonly entities: readonly string[];
  readonly confidence: number;
  readonly raw: string;
}

export type ParseResult = ParsedStatement | ParsedQuery | ParsedIntent | ParseFailure;

/**
 * A single grammar rule. Patterns are tried in order; the first match wins.
 * New sentence patterns are added by implementing this interface — no changes
 * to the parser core are required (open/closed principle).
 */
export interface GrammarPattern {
  readonly name: string;
  /** Attempt to interpret the (normalized) input. Return null to skip. */
  match(normalizedInput: string): ParseResult | null;
}

/** What an `IntentMatcher` reports when it recognizes its intent. */
export interface IntentMatch {
  readonly entities?: readonly string[];
  readonly confidence: number;
}

/**
 * A single intent recognizer (Strategy pattern, same shape as
 * `GrammarPattern`/`InferenceRule`/`PersonalityProfile` elsewhere in this
 * codebase). Each matcher owns ONE intent and a list of phrasings that mean
 * it — adding a new intent is a new file + one registry line, never a new
 * branch in the Parser itself (open/closed principle).
 */
export interface IntentMatcher {
  readonly intent: IntentName;
  /** Attempt to recognize this matcher's intent. Return null to skip. */
  match(normalizedInput: string): IntentMatch | null;
}

/** The parser facade consumed by the UI / reasoning pipeline. */
export interface Parser {
  parse(input: string): ParseResult;
}
