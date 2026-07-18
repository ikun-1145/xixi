/**
 * Frost (霜蓝) — the default persona for a furry-community-facing AI.
 *
 * Frost is temperate, friendly, reliable — a companion in the fandom rather
 * than a customer-service bot. Technical/factual content stays plain and
 * accurate; only the FRAMING around it (opener/closer, at most one emoji)
 * carries Frost's voice.
 *
 * CRITICAL INVARIANT: every render function below embeds the incoming
 * factual fields (`result.explanation`, `record.subject/relation/object`,
 * `failure.reason`) VERBATIM. Frost never regenerates or edits that content
 * — it only wraps it. (Enforced by tests in frost.test.ts and, jointly with
 * PlainPersonality, in boundary.test.ts.)
 */
import type {
  IdentityAspect,
  KnowledgeRecord,
  MemoryKey,
  ParseFailure,
  PersonalityProfile,
  ReasoningResult,
  ResponseContext,
  ResponsePlan,
} from "@/types";
import { MemoryKeys } from "@/types";
import { compose } from "./textCompose";
import { pickBySeed } from "./variation";
import {
  CAPABILITY_CLOSERS,
  CAPABILITY_OPENERS,
  CREATOR_CLOSERS,
  CREATOR_OPENERS,
  FAREWELL_LINES,
  FROST_EMOJI,
  GREETING_LINES,
  IDENTITY_CLOSERS,
  IDENTITY_OPENERS,
  LEARNED_CLOSERS,
  LEARNED_OPENERS,
  MEMORY_RECALL_NOT_FOUND_LINES,
  MEMORY_REMEMBERED_CLOSERS,
  MEMORY_REMEMBERED_OPENERS,
  NAME_RECALL_FOUND_CLOSERS,
  NAME_RECALL_FOUND_OPENERS,
  NAME_RECALL_NOT_FOUND_LINES,
  NAME_REMEMBERED_CLOSERS,
  NAME_REMEMBERED_OPENERS,
  REASONING_ANSWER_CLOSERS,
  REASONING_ANSWER_OPENERS,
  REASONING_NO_ANSWER_CLOSERS,
  REASONING_NO_ANSWER_OPENERS,
  REASONING_UNCERTAIN_HEDGES,
  THANKS_LINES,
  UNKNOWN_INPUT_CLOSERS,
  UNKNOWN_INPUT_OPENERS,
} from "./frostPhrases";

/** Append at most one emoji from Frost's palette, deterministically by seed. */
function withEmoji(text: string, seed: string): string {
  const emoji = pickBySeed(FROST_EMOJI, seed);
  return `${text} ${emoji}`;
}

function renderReasoningResult(result: ReasoningResult, plan: ResponsePlan): string {
  const seed = `${result.query.subject}:${result.query.relation}:${result.query.kind}`;
  const hasAnswer = plan.mode !== "no-answer";

  const opener = pickBySeed(
    hasAnswer ? REASONING_ANSWER_OPENERS : REASONING_NO_ANSWER_OPENERS,
    seed,
  );
  const closer = pickBySeed(
    hasAnswer ? REASONING_ANSWER_CLOSERS : REASONING_NO_ANSWER_CLOSERS,
    `${seed}:closer`,
  );
  // The DECISION to hedge is the Response Planner's (`plan.isUncertain`,
  // based on confidence); only the WORDING of the hedge is Frost's to pick.
  const hedge = plan.isUncertain ? pickBySeed(REASONING_UNCERTAIN_HEDGES, `${seed}:hedge`) : undefined;

  // `plan.explanation` is embedded verbatim — it is the Response Planner's
  // neutral, already-decided narrative (whether or not it includes the
  // derivation chain was decided there, not here). Frost frames it, never
  // rewrites it.
  return withEmoji(compose(opener, plan.explanation, hedge, closer), seed);
}

function renderLearned(record: KnowledgeRecord): string {
  const seed = `${record.subject}:${record.relation}:${record.object}`;
  const opener = pickBySeed(LEARNED_OPENERS, seed);
  const closer = pickBySeed(LEARNED_CLOSERS, `${seed}:closer`);

  const negation = record.negated ? "不" : "";
  const fact = `${record.subject} ${negation}${record.relation} ${record.object}`;

  return withEmoji(compose(opener, fact, closer), seed);
}

function renderUnknownInput(failure: ParseFailure): string {
  const seed = failure.raw;
  const opener = pickBySeed(UNKNOWN_INPUT_OPENERS, seed);
  const closer = pickBySeed(UNKNOWN_INPUT_CLOSERS, `${seed}:closer`);

  return withEmoji(compose(opener, `（${failure.reason}）`, closer), seed);
}

function renderGreeting(raw?: string): string {
  const seed = raw && raw.length > 0 ? raw : "greeting";
  const line = pickBySeed(GREETING_LINES, seed);
  return withEmoji(line, seed);
}

function renderThanks(raw?: string): string {
  const seed = raw && raw.length > 0 ? raw : "thanks";
  const line = pickBySeed(THANKS_LINES, seed);
  return withEmoji(line, seed);
}

function renderFarewell(raw?: string): string {
  const seed = raw && raw.length > 0 ? raw : "farewell";
  const line = pickBySeed(FAREWELL_LINES, seed);
  return withEmoji(line, seed);
}

/**
 * Renders an Identity answer from real `KnowledgeRecord`s (never hardcoded
 * text) -- `facts` were already resolved by the engine from a knowledge
 * store; Frost only frames them (opener/closer/emoji), same invariant as
 * `renderLearned`/`renderReasoningResult` above. `facts` can be legitimately
 * empty (nothing known yet about `subject`/`aspect`) and this still degrades
 * gracefully instead of throwing or inventing an answer.
 */
function renderIdentity(
  aspect: IdentityAspect,
  subject: string,
  facts: readonly KnowledgeRecord[],
  raw?: string,
): string {
  const seed = raw && raw.length > 0 ? raw : `identity:${subject}:${aspect}`;

  if (aspect === "capability") {
    const opener = pickBySeed(CAPABILITY_OPENERS, seed);
    const closer = pickBySeed(CAPABILITY_CLOSERS, `${seed}:closer`);
    const body =
      facts.length > 0
        ? facts.map((fact) => `· ${fact.object}`).join("\n")
        : `关于「${subject}」能做什么，我目前还没有明确的答案。`;
    return withEmoji(compose(opener, body, closer), seed);
  }

  if (aspect === "creator") {
    const opener = pickBySeed(CREATOR_OPENERS, seed);
    const closer = pickBySeed(CREATOR_CLOSERS, `${seed}:closer`);
    const [first] = facts;
    const body = first ? first.object : "这个我暂时还不清楚。";
    return withEmoji(compose(opener, body, closer), seed);
  }

  // aspect === "identity"
  const opener = pickBySeed(IDENTITY_OPENERS, seed);
  const closer = pickBySeed(IDENTITY_CLOSERS, `${seed}:closer`);
  const [first] = facts;
  const body = first
    ? `${first.subject} ${first.negated ? "不" : ""}${first.relation} ${first.object}`
    : `关于「${subject}」，我目前还没有明确的答案。`;
  return withEmoji(compose(opener, body, closer), seed);
}

/**
 * Renders "a fact was just remembered" -- `value` is embedded verbatim
 * (never rephrased/invented), same invariant as `renderLearned`. `key ===
 * MemoryKeys.Name` gets natural, tailored phrasing; any other key (future
 * RememberAge/RememberPreference/...) falls back to a still-warm, more
 * generic frame so this keeps working before those get their own lines.
 */
function renderRemembered(key: MemoryKey, value: string, raw?: string): string {
  const seed = raw && raw.length > 0 ? raw : `remembered:${key}`;

  if (key === MemoryKeys.Name) {
    const opener = pickBySeed(NAME_REMEMBERED_OPENERS, seed);
    const closer = pickBySeed(NAME_REMEMBERED_CLOSERS, `${seed}:closer`);
    return withEmoji(compose(opener, `你叫 ${value}`, closer), seed);
  }

  const opener = pickBySeed(MEMORY_REMEMBERED_OPENERS, seed);
  const closer = pickBySeed(MEMORY_REMEMBERED_CLOSERS, `${seed}:closer`);
  return withEmoji(compose(opener, value, closer), seed);
}

/**
 * Renders a recall answer -- `value` is `null` when nothing has been
 * remembered yet, which must degrade gracefully (never invent a name).
 */
function renderRecalled(key: MemoryKey, value: string | null, raw?: string): string {
  const seed = raw && raw.length > 0 ? raw : `recalled:${key}`;

  if (key === MemoryKeys.Name) {
    if (value === null) {
      return withEmoji(pickBySeed(NAME_RECALL_NOT_FOUND_LINES, seed), seed);
    }
    const opener = pickBySeed(NAME_RECALL_FOUND_OPENERS, seed);
    const closer = pickBySeed(NAME_RECALL_FOUND_CLOSERS, `${seed}:closer`);
    return withEmoji(compose(opener, value, closer), seed);
  }

  if (value === null) {
    return withEmoji(pickBySeed(MEMORY_RECALL_NOT_FOUND_LINES, seed), seed);
  }
  return withEmoji(value, seed);
}

function renderError(message: string): string {
  // Deliberately undecorated: technical/error content stays professional and
  // clear, per the persona spec — no emoji here.
  return `抱歉，出了点问题：${message}`;
}

export const FrostPersonality: PersonalityProfile = {
  id: "frost",
  displayName: "霜蓝 Frost",
  description:
    "温柔友善、带一点活力的兽圈朋友型人格。默认人格。仅影响语言风格与语气，" +
    "不改变任何推理结论、置信度或知识内容。",
  respond(context: ResponseContext): string {
    switch (context.kind) {
      case "reasoning-result":
        return renderReasoningResult(context.result, context.plan);
      case "learned":
        return renderLearned(context.record);
      case "unknown-input":
        return renderUnknownInput(context.failure);
      case "greeting":
        return renderGreeting(context.raw);
      case "thanks":
        return renderThanks(context.raw);
      case "farewell":
        return renderFarewell(context.raw);
      case "identity":
        return renderIdentity(context.aspect, context.subject, context.facts, context.raw);
      case "remembered":
        return renderRemembered(context.key, context.value, context.raw);
      case "recalled":
        return renderRecalled(context.key, context.value, context.raw);
      case "error":
        return renderError(context.message);
      default: {
        // Exhaustiveness check: if ResponseContext gains a new variant, this
        // line fails to compile until Frost handles it.
        const exhaustiveCheck: never = context;
        throw new Error(`Frost: unhandled response context ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  },
};
