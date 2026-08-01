/**
 * Frost (霜蓝) — the default persona for a furry-community-facing AI.
 *
 * Frost is temperate, friendly, reliable — a companion in the fandom rather
 * than a customer-service bot. Technical/factual content stays plain and
 * accurate; only the FRAMING around it (opener/closer, at most one emoji)
 * carries Frost's voice.
 *
 * CRITICAL INVARIANT: every factual render function below embeds the incoming
 * factual fields (`result.explanation`, `record.subject/relation/object`)
 * VERBATIM. Parse failures are different: `failure.reason` remains internal
 * diagnostic data and is intentionally converted into a natural fallback
 * before anything reaches the user.
 */
import type {
  ClarificationPlan,
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
  REASONING_ANSWER_OPENERS,
  REASONING_NO_ANSWER_CLOSERS,
  REASONING_NO_ANSWER_OPENERS,
  REASONING_UNCERTAIN_HEDGES,
  THANKS_LINES,
  UNKNOWN_INPUT_CLOSERS,
  UNKNOWN_INPUT_OPENERS,
} from "./frostPhrases";

const FROST_ACCENT_OPTIONS: readonly string[] = [
  "",
  "",
  "",
  "",
  "",
  "",
  "🐾",
  "✨",
];

/** Add one low-frequency accent deterministically for eligible social turns. */
function withOptionalAccent(
  text: string,
  context: string,
  seed: string,
): string {
  const accent = pickBySeed(
    FROST_ACCENT_OPTIONS,
    `${context}:${seed}:accent`,
  );
  return accent.length > 0 ? `${text} ${accent}` : text;
}

function renderReasoningResult(result: ReasoningResult, plan: ResponsePlan): string {
  const seed = `${result.query.subject}:${result.query.relation}:${result.query.kind}`;
  const hasAnswer = plan.mode !== "no-answer";

  // The DECISION to hedge is the Response Planner's (`plan.isUncertain`,
  // based on confidence); only the WORDING of the hedge is Frost's to pick.
  const hedge = plan.isUncertain ? pickBySeed(REASONING_UNCERTAIN_HEDGES, `${seed}:hedge`) : undefined;

  // `plan.explanation` is embedded verbatim — it is the Response Planner's
  // neutral, already-decided narrative (whether or not it includes the
  // derivation chain was decided there, not here). Frost frames it, never
  // rewrites it.
  if (hasAnswer) {
    const opener = pickBySeed(REASONING_ANSWER_OPENERS, seed);
    return `${opener}${plan.explanation}${hedge ?? ""}`;
  }

  const opener = pickBySeed(REASONING_NO_ANSWER_OPENERS, seed);
  const closer = pickBySeed(REASONING_NO_ANSWER_CLOSERS, `${seed}:closer`);
  return `${opener}${plan.explanation}${closer}`;
}

function renderLearned(record: KnowledgeRecord): string {
  const seed = `${record.subject}:${record.relation}:${record.object}`;
  const opener = pickBySeed(LEARNED_OPENERS, seed);
  const closer = pickBySeed(LEARNED_CLOSERS, `${seed}:closer`);

  const negation = record.negated ? "不" : "";
  const fact = `${record.subject} ${negation}${record.relation} ${record.object}`;

  return [opener, fact, closer].join("\n\n");
}

function renderUnknownInput(failure: ParseFailure): string {
  const normalizedInput = failure.raw.trim();
  if (!normalizedInput) {
    return "好像还没有输入内容，可以跟我说点什么。";
  }

  const seed = normalizedInput;
  const opener = pickBySeed(UNKNOWN_INPUT_OPENERS, seed);
  const closer = pickBySeed(UNKNOWN_INPUT_CLOSERS, `${seed}:closer`);

  return `${opener}${closer}`;
}

function renderGreeting(raw?: string): string {
  const seed = raw && raw.length > 0 ? raw : "greeting";
  const line = pickBySeed(GREETING_LINES, seed);
  return withOptionalAccent(line, "greeting", seed);
}

function renderThanks(raw?: string): string {
  const seed = raw && raw.length > 0 ? raw : "thanks";
  const line = pickBySeed(THANKS_LINES, seed);
  return withOptionalAccent(line, "thanks", seed);
}

function renderFarewell(raw?: string): string {
  const seed = raw && raw.length > 0 ? raw : "farewell";
  const line = pickBySeed(FAREWELL_LINES, seed);
  return withOptionalAccent(line, "farewell", seed);
}

function renderClarification(plan: ClarificationPlan): string {
  const labels = new Set(plan.candidateLabels);

  if (labels.has("identity") && labels.has("query")) {
    return "这个问题里像是同时问了我的名字和能力，可以分开问我。";
  }

  if (
    plan.focus === "subject" &&
    (plan.contextLabels?.length ?? 0) >= 2
  ) {
    const contextLabels = plan.contextLabels ?? [];
    const alternatives = [
      contextLabels.slice(0, -1).join("、"),
      contextLabels.at(-1),
    ].join("还是");
    return `你指的是${alternatives}呢？可以再确认一下。`;
  }

  if (plan.focus === "object" && plan.relation === "会") {
    return "你想问我会做什么呢？可以再具体一些。";
  }

  if (plan.focus === "object") {
    return "这里还缺少要说明的内容，可以再告诉我它是什么吗？";
  }

  if (plan.focus === "subject") {
    return "你想问的是谁或什么？可以再补充一点。";
  }

  if (plan.focus === "relation") {
    return "你想了解它哪一方面？可以再说具体一些。";
  }

  if (plan.focus === "name") {
    return "你是在问名字，还是想告诉我你的名字呢？";
  }

  if (labels.has("teaching")) {
    return "这条信息还没有说完整，可以再告诉我对象和它们的关系吗？";
  }

  return "我看到不止一种可能的意思，可以换一种更具体的说法吗？";
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
        ? `${opener}${facts.map((fact) => fact.object).join("；")}。`
        : `关于「${subject}」能做什么，我目前还没有明确的答案。`;
    return `${body}${closer}`;
  }

  if (aspect === "creator") {
    const opener = pickBySeed(CREATOR_OPENERS, seed);
    const closer = pickBySeed(CREATOR_CLOSERS, `${seed}:closer`);
    const [first] = facts;
    const body = first ? first.object : "这个我暂时还不清楚。";
    return compose(opener, body, closer);
  }

  // aspect === "identity"
  const opener = pickBySeed(IDENTITY_OPENERS, seed);
  const closer = pickBySeed(IDENTITY_CLOSERS, `${seed}:closer`);
  const [first] = facts;
  const isFrostIdentity = subject === "霜蓝" || first?.subject === "霜蓝";
  const body = first
    ? isFrostIdentity
      ? `我就是霜蓝，${first.negated ? "不" : ""}${first.relation} ${first.object}。`
      : `${opener}${first.subject}，${first.negated ? "不" : ""}${first.relation}${first.object}。`
    : `关于「${subject}」，我目前还没有明确的答案。`;
  return `${body}${closer}`;
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
    return withOptionalAccent(
      `${opener}${value}。${closer}`,
      "name-remembered",
      seed,
    );
  }

  const opener = pickBySeed(MEMORY_REMEMBERED_OPENERS, seed);
  const closer = pickBySeed(MEMORY_REMEMBERED_CLOSERS, `${seed}:closer`);
  return compose(opener, value, closer);
}

/**
 * Renders a recall answer -- `value` is `null` when nothing has been
 * remembered yet, which must degrade gracefully (never invent a name).
 */
function renderRecalled(key: MemoryKey, value: string | null, raw?: string): string {
  const seed = raw && raw.length > 0 ? raw : `recalled:${key}`;

  if (key === MemoryKeys.Name) {
    if (value === null) {
      return pickBySeed(NAME_RECALL_NOT_FOUND_LINES, seed);
    }
    const opener = pickBySeed(NAME_RECALL_FOUND_OPENERS, seed);
    const closer = pickBySeed(NAME_RECALL_FOUND_CLOSERS, `${seed}:closer`);
    return withOptionalAccent(
      `${opener}${value}${closer}`,
      "name-recalled",
      seed,
    );
  }

  if (value === null) {
    return pickBySeed(MEMORY_RECALL_NOT_FOUND_LINES, seed);
  }
  return value;
}

function renderError(_message: string): string {
  // Internal error details stay available to the caller/logs, but never cross
  // the final user-visible Personality boundary.
  return "抱歉，我现在遇到了一点问题，请稍后再试一次。";
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
      case "clarification":
        return renderClarification(context.plan);
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
