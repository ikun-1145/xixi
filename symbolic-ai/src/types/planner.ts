/**
 * Response Planner contracts (Stage 7).
 *
 * Pipeline position:
 *   Parser -> Knowledge -> Reasoner -> Response Planner -> Personality -> Output
 *
 * The Reasoner (`@/reasoners`) only ever produces an Answer + Confidence +
 * Evidence for a query — concretely, a `ReasoningResult` whose `answers`
 * are `Inference`s, each carrying `conclusion` (Answer), `confidence`
 * (Confidence), and `steps`/`path` (Evidence, the derivation chain). The
 * Reasoner never decides how much of that to SHOW, and never decides tone.
 *
 * The Response Planner sits directly on top of that and decides the ANSWER
 * STRATEGY — never the wording:
 *   - whether there is anything to answer at all (`mode: "no-answer"`)
 *   - whether to surface the derivation chain, i.e. Evidence
 *     (`showEvidence`) — today: only when the user explicitly asked "why"
 *     (`ParsedQuery.explain`, set by the Parser's why-pattern, e.g.
 *     "猫为什么属于生物")
 *   - whether the best answer is uncertain enough to hedge (`isUncertain`),
 *     based on `Inference.confidence`
 *   - (reserved for a later round, NOT implemented yet): whether to ask the
 *     user a follow-up question, or simplify an over-long answer
 *
 * Personality receives an already-decided `ResponsePlan` (alongside the
 * original `ReasoningResult`, for context like the query's subject/relation
 * used to vary phrasing) and renders it in its own voice ONLY. It must
 * never re-derive facts, inspect `Inference.confidence` itself, or decide
 * whether to show Evidence — those decisions have already been made here.
 */
import type { Relation } from "./knowledge";
import type { ReasoningResult } from "./reasoning";

/**
 * - "direct"    -- state the answer plainly, no derivation chain.
 * - "explained" -- state the answer AND its derivation chain (Evidence).
 * - "no-answer" -- nothing relevant is known yet.
 */
export type ResponseMode = "direct" | "explained" | "no-answer";

export interface ResponsePlan {
  readonly mode: ResponseMode;
  /** Whether Personality should surface the derivation chain (Evidence). */
  readonly showEvidence: boolean;
  /** Whether the best answer's confidence is low enough to hedge. */
  readonly isUncertain: boolean;
  /** Representative confidence in [0, 1]; 0 when `mode === "no-answer"`. */
  readonly confidence: number;
  /**
   * Neutral, already-decided narrative text Personality embeds verbatim —
   * includes the derivation chain iff `showEvidence` is true. Never styled;
   * framing (opener/closer/emoji/hedge phrasing) is added by Personality.
   */
  readonly explanation: string;
}

export type ClarificationKind =
  | "ambiguous-intent"
  | "missing-subject"
  | "missing-relation"
  | "missing-object"
  | "uncertain-name"
  | "uncertain-teaching"
  | "conflicting-candidates";

export type ClarificationSlot =
  | "subject"
  | "relation"
  | "object"
  | "name"
  | "intent";

export type ClarificationCandidateLabel =
  | "greeting"
  | "thanks"
  | "farewell"
  | "identity"
  | "recall-name"
  | "query"
  | "remember-name"
  | "teaching"
  | "unknown";

export type ClarificationReasonCategory =
  | "missing-information"
  | "ambiguous"
  | "uncertain";

/**
 * Privacy-safe hand-off from Semantic Understanding to Response Planner.
 *
 * It deliberately excludes candidate ids, raw input, confidence, producer,
 * diagnostics and semantic reason codes. Those are useful for internal
 * comparison only and must never become Personality input.
 */
export interface ClarificationContext {
  readonly clarificationKind: ClarificationKind;
  readonly missingSlots: readonly ClarificationSlot[];
  readonly candidateLabels: readonly ClarificationCandidateLabel[];
  readonly reasonCategory: ClarificationReasonCategory;
  /** Canonical relation only; never a user-provided subject or object. */
  readonly relation?: Relation;
  /** Bounded entity labels from structured context, never raw history. */
  readonly contextLabels?: readonly string[];
}

export interface ClarificationPlan {
  readonly clarificationKind: ClarificationKind;
  readonly focus: ClarificationSlot;
  readonly candidateLabels: readonly ClarificationCandidateLabel[];
  readonly reasonCategory: ClarificationReasonCategory;
  readonly relation?: Relation;
  readonly contextLabels?: readonly string[];
}

/**
 * A pluggable answer-strategy planner (Strategy pattern, same shape as
 * `Reasoner`/`PersonalityProfile` elsewhere in this codebase). Only one
 * implementation exists today (`defaultResponsePlanner`, see `@/planner`)
 * — the interface exists so a smarter/future planner (e.g. one that also
 * asks follow-up questions) can replace it without any caller changing.
 */
export interface ResponsePlanner {
  readonly id: string;
  plan(result: ReasoningResult): ResponsePlan;
  planClarification(context: ClarificationContext): ClarificationPlan;
}
