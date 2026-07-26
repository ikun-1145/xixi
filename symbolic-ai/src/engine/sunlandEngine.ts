/**
 * Sunland Core Engine -- the single composition point that wires
 * Parser -> Knowledge -> Reasoner -> Response Planner -> Personality into
 * one call, so ANY host (a website Provider, a CLI, a future API server) can
 * talk to Sunland AI's "brain" without importing each module individually.
 *
 * Query answering (the "query" case in `respond()` below) calls the real
 * `graphReasoner` (`@/reasoners`, implements the `Reasoner` interface --
 * Stage 6, Knowledge Graph v1) to get a `ReasoningResult`, then hands that
 * to `defaultResponsePlanner` (`@/planner`, implements the `ResponsePlanner`
 * interface -- Stage 7, Response Planner) to decide the answer STRATEGY
 * (plain answer vs. explained vs. hedged), and only THEN hands the result to
 * Personality. This file's own role in that hand-off is just plumbing --
 * `intentToResponseContext` and the `"query"` branch below decide WHICH
 * `ResponseContext` shape a given intent/query maps to, nothing more; the
 * actual strategy decisions live in `@/planner`, not here.
 *
 * Zero DOM/browser dependency: identical behavior in a browser, Node, or a
 * CLI. Persistence (if any) is injected via a `StorageAdapter` -- this file
 * never touches `window`/`localStorage` itself (see `types/storage.ts`).
 *
 * Introduced in Stage 3.5 as the minimum viable "Sunland brain" needed to
 * back a `SunlandProvider` on the production website, ahead of the
 * originally-planned Stage 4/6/7 order -- an explicit, user-approved
 * priority pivot (integrate with the website first, deepen the reasoning
 * core later).
 */
import type {
  ClarificationContext,
  IdentityAspect,
  KnowledgeStore,
  MemoryManager,
  ParseResult,
  ParsedIntent,
  Parser,
  PersonalityProfile,
  Relation,
  ResponseContext,
  StorageAdapter,
} from "@/types";
import { CoreRelations, MemoryKeys } from "@/types";
import {
  createKnowledgeStore,
  createSelfKnowledgeStore,
  CREATOR_RELATION,
  loadKnowledgeStore,
  saveKnowledgeStore,
  seedKnowledgeStore,
  SUNLAND_SUBJECT,
} from "@/knowledge";
import { createMemoryManager, loadMemoryManager, saveMemoryManager } from "@/memory";
import { createParser } from "@/parser";
import { getPersonality } from "@/personality";
import { defaultResponsePlanner } from "@/planner";
import { graphReasoner } from "@/reasoners";
import {
  createObservationSummary,
  sanitizeObservationSummary,
  type ObservationClarificationKind,
  type ObservationMode,
  type ObservationReasonCategory,
  type ObservationRelationCategory,
  type ObservationResultCategory,
  type ObservationSummary,
  type ObservationSummaryInput,
  type RelationAlignmentResult,
} from "@/observation";
import {
  adaptUnderstandingDecision,
  analyzeSemanticInput,
  createEmptySemanticContext,
  createSemanticContextUpdate,
  createSemanticErrorShadowDiagnostic,
  createSemanticShadowDiagnostic,
  isLegacySideEffectResult,
  normalizeSemanticContext,
  planUnderstanding,
  type SemanticAdoptionResult,
  type SemanticAnalysis,
  type SemanticCandidate,
  type SemanticContext,
  type SemanticContextMode,
  type SemanticContextUpdate,
  type SemanticMode,
  type SemanticShadowDiagnostic,
  type UnderstandingDecision,
  type UnderstandingPolicy,
} from "@/semantic";

export type {
  SemanticContextMode,
  SemanticMode,
  SemanticShadowDiagnostic,
} from "@/semantic";
export type {
  ObservationMode,
  ObservationSummary,
} from "@/observation";

export interface SemanticRuntime {
  analyze(input: string, context?: SemanticContext): SemanticAnalysis;
  plan(
    analysis: SemanticAnalysis,
    policy?: UnderstandingPolicy,
  ): UnderstandingDecision;
}

export interface ObservationRuntime {
  /** Monotonic clock seam. Exact values never leave the summary builder. */
  now(): number | null;
  /**
   * Testable finalization seam. It receives only an already bucketed,
   * whitelist-safe summary, never precise measurements or engine objects.
   * Its result is validated again before it can leave Core.
   */
  finalizeSummary(summary: ObservationSummary): unknown;
}

export interface SunlandEngineOptions {
  /** Shared knowledge store; created fresh if omitted. */
  readonly knowledgeStore?: KnowledgeStore;
  /** Shared memory manager (facts about the user); created fresh if omitted. */
  readonly memory?: MemoryManager;
  /** Persona id; defaults to Frost (`DEFAULT_PERSONALITY_ID`). */
  readonly personalityId?: string;
  /** Custom grammar; defaults to `createParser()`'s built-in patterns. */
  readonly parser?: Parser;
  /**
   * When provided, the store (and, under a derived key, the memory manager)
   * auto-load from `storage.adapter`/`storage.key` on creation, and
   * auto-save after every learned fact / remembered value. Omit for a
   * purely in-memory (non-persisted) engine, e.g. in tests.
   */
  readonly storage?: { readonly adapter: StorageAdapter; readonly key: string };
  /**
   * Populate a FRESH, empty store with illustrative demo facts (猫/企鹅/...).
   * Intended for local dev/demos only -- real deployments should leave this
   * `false` (the default) so a real user's brain starts empty and grows
   * purely from what they actually teach it. Ignored if the store already
   * has facts in it (either passed in directly, or restored from storage).
   */
  readonly seedDemoData?: boolean;
  /**
   * Stage 8.5A rollout mode. `passive` adopts only read-only intents/queries
   * and structured clarification; all writes remain on the legacy path.
   */
  readonly semanticMode?: SemanticMode;
  /**
   * Retain only the latest privacy-safe Shadow comparison in memory so tests
   * and local diagnostics can inspect it. Disabled by default; never logs or
   * persists anything.
   */
  readonly semanticDebug?: boolean;
  /**
   * Stage 8.6 rollout flag. Disabled by default until a host explicitly owns
   * per-user, per-conversation persistence and optimistic update handling.
   */
  readonly semanticContextMode?: SemanticContextMode;
  /** Optional pure runtime seam for deterministic tests/custom policy hosts. */
  readonly semanticRuntime?: Partial<SemanticRuntime>;
  /** Optional centrally-defined Planner policy. */
  readonly understandingPolicy?: UnderstandingPolicy;
  /**
   * Optional observation seam for deterministic/error-isolation tests.
   * It is never called unless a process() call explicitly requests summary.
   */
  readonly observationRuntime?: Partial<ObservationRuntime>;
}

export interface SunlandProcessOptions {
  /** Host-owned, serializable context snapshot. Damaged values fail closed. */
  readonly semanticContext?: unknown;
  /** Stable host request/turn id; a deterministic local id is used if omitted. */
  readonly turnId?: string;
  /**
   * Evaluated after response execution. Hosts can bind this to request
   * activity/abort/identity checks without importing browser APIs into Core.
   */
  readonly canCommitSemanticContext?: () => boolean;
  /**
   * Privacy-safe, per-request summary only. Off by default; Core never stores
   * or aggregates summaries and never infers whether a user consented.
   */
  readonly observationMode?: ObservationMode;
}

export interface SunlandProcessResult {
  readonly response: string;
  readonly semanticContextUpdate: SemanticContextUpdate;
  readonly observationSummary?: ObservationSummary;
}

export interface SunlandEngine {
  /** Parse + route + render a single conversational turn. Never throws. */
  respond(input: string): string;
  /**
   * Context-aware equivalent of respond(). It never stores context itself;
   * the host must apply the optimistic update to the originating conversation.
   */
  process(
    input: string,
    options?: SunlandProcessOptions,
  ): SunlandProcessResult;
  /** The shared brain backing this engine instance (e.g. for visualization). */
  readonly knowledgeStore: KnowledgeStore;
  /** Facts remembered ABOUT the user (name today; age/preferences later). */
  readonly memory: MemoryManager;
  readonly semanticMode: SemanticMode;
  readonly semanticContextMode: SemanticContextMode;
  /** Returns null unless semanticDebug was explicitly enabled. */
  getLastSemanticShadow(): SemanticShadowDiagnostic | null;
}

const IDENTITY_ASPECT_RELATION: Record<IdentityAspect, Relation> = {
  identity: CoreRelations.Is,
  capability: CoreRelations.Can,
  creator: CREATOR_RELATION,
};

function isIdentityAspect(value: string | undefined): value is IdentityAspect {
  return value === "identity" || value === "capability" || value === "creator";
}

interface ObservationTurnState {
  readonly startedAt: number | null;
  resultCategory: ObservationResultCategory;
  reasonCategory: ObservationReasonCategory;
  relationCategory: ObservationRelationCategory;
  semanticAdopted: boolean;
  legacyFallback: boolean;
  contextUsed: boolean;
  clarificationKind: ObservationClarificationKind;
  reasonerPathLength: number | null;
  semanticDurationMs: number | null;
  reasonerDurationMs: number | null;
  queriedRelation: ObservationRelationCategory;
  alternativeKnownRelation: ObservationRelationCategory;
  alignmentResult: RelationAlignmentResult;
  classificationLocked: boolean;
}

const OBSERVABLE_RELATIONS: ReadonlySet<ObservationRelationCategory> =
  new Set([
    "属于",
    "是",
    "会",
    "喜欢",
    "在",
    "有",
    "意思是",
    "开发者",
    "none",
    "unknown",
  ]);

function observableRelation(
  relation: string | undefined,
): ObservationRelationCategory {
  if (relation === undefined || relation.length === 0) return "none";
  return OBSERVABLE_RELATIONS.has(
    relation as ObservationRelationCategory,
  )
    ? (relation as ObservationRelationCategory)
    : "unknown";
}

function monotonicNow(): number | null {
  try {
    const now = globalThis.performance?.now();
    return typeof now === "number" && Number.isFinite(now)
      ? now
      : null;
  } catch {
    return null;
  }
}

function elapsedMilliseconds(
  startedAt: number | null,
  endedAt: number | null,
): number | null {
  if (
    startedAt === null ||
    endedAt === null ||
    !Number.isFinite(startedAt) ||
    !Number.isFinite(endedAt) ||
    endedAt < startedAt
  ) {
    return null;
  }
  return endedAt - startedAt;
}

function decisionCandidates(
  decision: UnderstandingDecision,
): readonly SemanticCandidate[] {
  switch (decision.kind) {
    case "accept":
      return [
        decision.selectedCandidate,
        ...decision.secondaryCandidates,
      ];
    case "clarify":
      return decision.candidateOptions;
    case "reject-side-effect":
      return [decision.rejectedCandidate];
    case "no-understanding":
      return [];
  }
}

function clarificationReason(
  kind: ObservationClarificationKind,
): ObservationReasonCategory {
  switch (kind) {
    case "missing-subject":
      return "missing-subject";
    case "missing-relation":
      return "missing-relation";
    case "missing-object":
      return "missing-object";
    case "ambiguous-intent":
      return "ambiguous-intent";
    case "conflicting-candidates":
      return "conflicting-candidates";
    case "uncertain-name":
    case "uncertain-teaching":
      return "insufficient-evidence";
    case "none":
      return "unclassified";
  }
}

function createObservationTurnState(
  startedAt: number | null,
): ObservationTurnState {
  return {
    startedAt,
    resultCategory: "safe-fallback",
    reasonCategory: "unclassified",
    relationCategory: "none",
    semanticAdopted: false,
    legacyFallback: false,
    contextUsed: false,
    clarificationKind: "none",
    reasonerPathLength: 0,
    semanticDurationMs: null,
    reasonerDurationMs: null,
    queriedRelation: "none",
    alternativeKnownRelation: "none",
    alignmentResult: "unavailable",
    classificationLocked: false,
  };
}

/**
 * Resolve an `Identity` intent against `selfStore` -- the Knowledge half of
 * "Knowledge + Personality composing an Identity answer together". This is
 * intentionally the SAME shape as `answerQuery` above: look up real facts by
 * pattern, hand them to Personality unmodified. Nothing about Sunland AI's
 * identity/capabilities/creator is hardcoded in this file or in Personality
 * -- it all lives in `knowledge/selfKnowledge.ts` and can grow there (the
 * future Knowledge Engine's job) without this function changing.
 */
function answerIdentity(parsed: ParsedIntent, selfStore: KnowledgeStore): ResponseContext {
  const [subject = SUNLAND_SUBJECT, aspectValue] = parsed.entities;
  const aspect: IdentityAspect = isIdentityAspect(aspectValue) ? aspectValue : "identity";
  const relation = IDENTITY_ASPECT_RELATION[aspect];
  const facts = selfStore.match({ subject, relation });
  return { kind: "identity", aspect, subject, facts, raw: parsed.raw };
}

/**
 * Resolve a `RememberName` intent: `parsed.entities` is `[name]` (extracted,
 * never invented, by the Parser). This is the ONLY place that calls
 * `memory.remember` — Parser never stores, Personality never touches
 * `MemoryManager` directly. Persistence (if configured) is triggered by the
 * caller in `respond()`, mirroring the statement-learning path's `persist()`
 * call.
 */
function answerRememberName(parsed: ParsedIntent, memory: MemoryManager): ResponseContext {
  const [name] = parsed.entities;
  const record = memory.remember(MemoryKeys.Name, name ?? "");
  return { kind: "remembered", key: record.key, value: record.value, raw: parsed.raw };
}

/** Resolve a `RecallName` intent: no entities needed, always looks up by key. */
function answerRecallName(parsed: ParsedIntent, memory: MemoryManager): ResponseContext {
  const record = memory.recall(MemoryKeys.Name);
  return { kind: "recalled", key: MemoryKeys.Name, value: record?.value ?? null, raw: parsed.raw };
}

/**
 * Map a recognized `ParsedIntent` to the `ResponseContext` Personality
 * expects. This mapping decision lives here (the composition root), NOT in
 * Personality itself: Personality never inspects `IntentName` — it only ever
 * renders an already-decided `ResponseContext` kind, keeping "what did the
 * user mean" (Parser/engine) and "how do we phrase it" (Personality)
 * strictly separate, per the pipeline's one-way dependency rule. The
 * exhaustiveness check below means adding a new `IntentName` without adding
 * a case here is a compile error, not a silent gap.
 */
function intentToResponseContext(
  parsed: ParsedIntent,
  selfStore: KnowledgeStore,
  memory: MemoryManager,
): ResponseContext {
  switch (parsed.intent) {
    case "Greeting":
      return { kind: "greeting", raw: parsed.raw };
    case "Thanks":
      return { kind: "thanks", raw: parsed.raw };
    case "Farewell":
      return { kind: "farewell", raw: parsed.raw };
    case "Identity":
      return answerIdentity(parsed, selfStore);
    case "RememberName":
      return answerRememberName(parsed, memory);
    case "RecallName":
      return answerRecallName(parsed, memory);
    default: {
      const exhaustiveCheck: never = parsed.intent;
      throw new Error(`createSunlandEngine: unhandled intent "${String(exhaustiveCheck)}"`);
    }
  }
}

/** Create a ready-to-use Sunland Core engine instance. */
export function createSunlandEngine(options: SunlandEngineOptions = {}): SunlandEngine {
  const store = options.knowledgeStore ?? createKnowledgeStore();
  const memory: MemoryManager = options.memory ?? createMemoryManager();
  const personality: PersonalityProfile = getPersonality(options.personalityId);
  const parser: Parser = options.parser ?? createParser();
  const storage = options.storage;
  const semanticMode = options.semanticMode ?? "passive";
  const semanticContextMode = options.semanticContextMode ?? "off";
  const semanticDebug = options.semanticDebug === true;
  const semanticAnalyze =
    options.semanticRuntime?.analyze ?? analyzeSemanticInput;
  const semanticPlan =
    options.semanticRuntime?.plan ?? planUnderstanding;
  const observationNow =
    options.observationRuntime?.now ?? monotonicNow;
  const observationFinalizeSummary =
    options.observationRuntime?.finalizeSummary ??
    ((summary: ObservationSummary): ObservationSummary => summary);
  let lastSemanticShadow: SemanticShadowDiagnostic | null = null;
  // Facts about Sunland AI itself (Identity intent) -- always present, never
  // part of the user's own (persisted) `store` above. See file-level doc
  // comment on `knowledge/selfKnowledge.ts` for why these are kept separate.
  const selfKnowledgeStore = createSelfKnowledgeStore();
  // Memory (facts ABOUT the user) is persisted under a key derived from the
  // caller's own storage key, so a host (e.g. `SunlandProvider.js`) that
  // already passes `{adapter, key}` for the knowledge store needs zero
  // changes to also get memory persistence for free.
  const memoryStorageKey = storage ? `${storage.key}::memory` : undefined;

  if (storage) {
    loadKnowledgeStore(store, storage.adapter, storage.key);
  }
  if (memoryStorageKey && storage) {
    loadMemoryManager(memory, storage.adapter, memoryStorageKey);
  }
  if (options.seedDemoData === true && store.all().length === 0) {
    seedKnowledgeStore(store);
  }

  function persist(): void {
    if (storage) saveKnowledgeStore(store, storage.adapter, storage.key);
  }

  function persistMemory(): void {
    if (storage && memoryStorageKey) saveMemoryManager(memory, storage.adapter, memoryStorageKey);
  }

  function safeObservationNow(): number | null {
    try {
      const value = observationNow();
      return typeof value === "number" && Number.isFinite(value)
        ? value
        : null;
    } catch {
      return null;
    }
  }

  function observeParsedResult(
    parsed: ParseResult,
    observation: ObservationTurnState,
  ): void {
    if (parsed.type === "query" || parsed.type === "statement") {
      observation.relationCategory = observableRelation(
        parsed.relation,
      );
    }
    if (parsed.type === "query") {
      observation.queriedRelation = observableRelation(
        parsed.relation,
      );
    }
    if (observation.classificationLocked) return;

    if (parsed.type === "unknown") {
      observation.resultCategory = "no-understanding";
      observation.reasonCategory = "unknown-safe-fallback";
      return;
    }
    observation.resultCategory = "understood";
    observation.reasonCategory = observation.semanticAdopted
      ? "complete-passive-understanding"
      : "unclassified";
  }

  function observeSemanticAdaptation(
    observation: ObservationTurnState,
    decision: UnderstandingDecision,
    adaptation: SemanticAdoptionResult,
  ): void {
    observation.semanticAdopted =
      semanticMode === "passive" &&
      adaptation.kind !== "fallback-legacy";
    observation.legacyFallback =
      semanticMode === "shadow" ||
      adaptation.kind === "fallback-legacy";
    observation.contextUsed =
      adaptation.kind !== "fallback-legacy" &&
      decisionCandidates(decision).some(
        ({ producer }) => producer === "context",
      );

    if (adaptation.kind === "clarification") {
      observation.clarificationKind =
        adaptation.context.clarificationKind;
      if (
        adaptation.context.clarificationKind ===
          "missing-subject" &&
        observation.contextUsed
      ) {
        observation.resultCategory = "context-unresolved";
        observation.reasonCategory = "unresolved-context";
      } else {
        observation.resultCategory = "clarification";
        observation.reasonCategory = clarificationReason(
          adaptation.context.clarificationKind,
        );
      }
      observation.classificationLocked = true;
      return;
    }

    if (adaptation.kind === "no-understanding") {
      if (
        adaptation.failure.reason.startsWith(
          "legacy-side-effect-blocked:",
        ) ||
        adaptation.failure.reason.startsWith(
          "legacy-side-effect-rejected:",
        ) ||
        adaptation.failure.reason ===
          "semantic-side-effect-rejected"
      ) {
        observation.resultCategory = "side-effect-blocked";
        observation.reasonCategory = "blocked-side-effect";
      } else {
        observation.resultCategory = "no-understanding";
        observation.reasonCategory = "unknown-safe-fallback";
      }
      observation.classificationLocked = true;
    }
  }

  function observeReasoningResult(
    parsed: Extract<ParseResult, { readonly type: "query" }>,
    answers: readonly {
      readonly path: readonly string[];
    }[],
    observation: ObservationTurnState,
  ): void {
    observation.relationCategory = observableRelation(
      parsed.relation,
    );
    observation.queriedRelation = observation.relationCategory;

    if (answers.length === 0) {
      observation.reasonerPathLength = 0;
      if (!observation.classificationLocked) {
        observation.resultCategory = "missing-knowledge";
        observation.reasonCategory = "missing-knowledge";
      }
      observation.alignmentResult = "unavailable";
      return;
    }

    observation.reasonerPathLength = answers.reduce(
      (maximum, answer) =>
        Math.max(maximum, Math.max(1, answer.path.length - 1)),
      1,
    );
    observation.alignmentResult = "aligned";
  }

  function respondToParseResult(
    parsed: ParseResult,
    observation?: ObservationTurnState,
  ): string {
    if (observation !== undefined) {
      observeParsedResult(parsed, observation);
    }
    switch (parsed.type) {
      case "statement": {
        const record = store.add(
          { subject: parsed.subject, relation: parsed.relation, object: parsed.object, negated: parsed.negated },
          { source: "user" },
        );
        persist();
        return personality.respond({ kind: "learned", record });
      }
      case "query": {
        // Reasoner -> Response Planner -> Personality, in that order. The
        // semantic Adapter only supplies a Parser-compatible query; it does
        // not inspect raw input or add any reasoning rule.
        const queryStore =
          parsed.subject.trim().toLocaleLowerCase("und") ===
          SUNLAND_SUBJECT.toLocaleLowerCase("und")
            ? selfKnowledgeStore
            : store;
        const reasonerStartedAt =
          observation === undefined ? null : safeObservationNow();
        const result = graphReasoner.answer(parsed, queryStore);
        if (observation !== undefined) {
          observation.reasonerDurationMs = elapsedMilliseconds(
            reasonerStartedAt,
            safeObservationNow(),
          );
          observeReasoningResult(
            parsed,
            result.answers,
            observation,
          );
        }
        const plan = defaultResponsePlanner.plan(result);
        return personality.respond({ kind: "reasoning-result", result, plan });
      }
      case "intent": {
        const context = intentToResponseContext(parsed, selfKnowledgeStore, memory);
        if (parsed.intent === "RememberName") persistMemory();
        return personality.respond(context);
      }
      case "unknown":
        return personality.respond({ kind: "unknown-input", failure: parsed });
      default: {
        const exhaustiveCheck: never = parsed;
        throw new Error(`createSunlandEngine: unhandled parse result ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  }

  function respondToClarification(context: ClarificationContext): string {
    const plan = defaultResponsePlanner.planClarification(context);
    return personality.respond({ kind: "clarification", plan });
  }

  function process(
    input: string,
    processOptions: SunlandProcessOptions = {},
  ): SunlandProcessResult {
    const observation =
      processOptions.observationMode === "summary"
        ? createObservationTurnState(safeObservationNow())
        : undefined;
    const semanticContext =
      semanticContextMode === "enabled"
        ? normalizeSemanticContext(processOptions.semanticContext)
        : normalizeSemanticContext(
            processOptions.semanticContext ?? createEmptySemanticContext(),
          );
    const noContextUpdate = (): SemanticContextUpdate =>
      Object.freeze({
        kind: "none",
        baseVersion: semanticContext.version,
      });
    const finishWithObservation = (
      result: SunlandProcessResult,
    ): SunlandProcessResult => {
      if (observation === undefined) return result;

      try {
        let knowledgeCount: number | null = null;
        try {
          const count = store.all().length;
          knowledgeCount =
            Number.isSafeInteger(count) && count >= 0
              ? count
              : null;
        } catch {
          knowledgeCount = null;
        }

        const summaryInput: ObservationSummaryInput = {
          resultCategory: observation.resultCategory,
          reasonCategory: observation.reasonCategory,
          relationCategory: observation.relationCategory,
          semanticAdopted: observation.semanticAdopted,
          legacyFallback: observation.legacyFallback,
          contextUsed: observation.contextUsed,
          clarificationKind: observation.clarificationKind,
          reasonerPathLength: observation.reasonerPathLength,
          knowledgeCount,
          totalDurationMs: elapsedMilliseconds(
            observation.startedAt,
            safeObservationNow(),
          ),
          semanticDurationMs: observation.semanticDurationMs,
          reasonerDurationMs: observation.reasonerDurationMs,
          queriedRelation: observation.queriedRelation,
          alternativeKnownRelation:
            observation.alternativeKnownRelation,
          alignmentResult: observation.alignmentResult,
        };
        const summary = createObservationSummary(summaryInput);
        const sanitized = sanitizeObservationSummary(
          observationFinalizeSummary(summary),
        );
        if (sanitized === null) return result;

        return Object.freeze({
          response: result.response,
          semanticContextUpdate: result.semanticContextUpdate,
          observationSummary: sanitized,
        });
      } catch {
        // Observation is strictly best-effort and must never affect a turn.
        return result;
      }
    };
    const resultWithoutContext = (
      response: string,
    ): SunlandProcessResult =>
      finishWithObservation(
        Object.freeze({
          response,
          semanticContextUpdate: noContextUpdate(),
        }),
      );
    const resultWithAcceptedContext = (
      response: string,
      decision: UnderstandingDecision,
      executedResult: ParseResult | null,
    ): SunlandProcessResult => {
      let canCommit = semanticContextMode === "enabled";
      if (canCommit && processOptions.canCommitSemanticContext !== undefined) {
        try {
          canCommit = processOptions.canCommitSemanticContext();
        } catch {
          canCommit = false;
        }
      }
      const semanticContextUpdate =
        semanticMode === "passive"
          ? createSemanticContextUpdate({
              context: semanticContext,
              decision,
              executedResult,
              turnId:
                processOptions.turnId ??
                `turn-${semanticContext.version + 1}`,
              executionSucceeded: true,
              canCommit,
            })
          : noContextUpdate();
      return finishWithObservation(
        Object.freeze({ response, semanticContextUpdate }),
      );
    };

    const legacyResult: ParseResult = parser.parse(input);
    lastSemanticShadow = null;

    if (semanticMode === "off") {
      if (observation !== undefined) {
        observation.legacyFallback = true;
      }
      return resultWithoutContext(
        respondToParseResult(legacyResult, observation),
      );
    }

    let analysis: SemanticAnalysis;
    let decision: UnderstandingDecision;
    let adaptation: SemanticAdoptionResult;
    const semanticStartedAt =
      observation === undefined ? null : safeObservationNow();
    try {
      analysis = semanticAnalyze(
        input,
        semanticContextMode === "enabled"
          ? semanticContext
          : undefined,
      );
      decision = semanticPlan(
        analysis,
        options.understandingPolicy,
      );
      adaptation = adaptUnderstandingDecision(
        decision,
        legacyResult,
        analysis,
      );
      if (observation !== undefined) {
        observation.semanticDurationMs = elapsedMilliseconds(
          semanticStartedAt,
          safeObservationNow(),
        );
        observeSemanticAdaptation(
          observation,
          decision,
          adaptation,
        );
      }

      if (semanticDebug) {
        lastSemanticShadow = createSemanticShadowDiagnostic(
          semanticMode,
          legacyResult,
          decision,
          adaptation,
        );
      }
    } catch {
      if (observation !== undefined) {
        observation.semanticDurationMs = elapsedMilliseconds(
          semanticStartedAt,
          safeObservationNow(),
        );
        observation.semanticAdopted = false;
        observation.legacyFallback = true;
      }
      if (semanticDebug) {
        lastSemanticShadow = createSemanticErrorShadowDiagnostic(
          semanticMode,
          legacyResult,
        );
      }
      const response = isLegacySideEffectResult(legacyResult)
        ? respondToParseResult({
            type: "unknown",
            raw: legacyResult.raw,
            reason: "semantic-side-effect-validation-unavailable",
          }, observation)
        : respondToParseResult(legacyResult, observation);
      if (observation !== undefined) {
        observation.resultCategory = "safe-fallback";
        observation.reasonCategory = "semantic-runtime";
        observation.classificationLocked = true;
      }
      return resultWithoutContext(response);
    }

    if (semanticMode === "shadow") {
      return resultWithoutContext(
        respondToParseResult(legacyResult, observation),
      );
    }

    switch (adaptation.kind) {
      case "adopt":
        return resultWithAcceptedContext(
          respondToParseResult(adaptation.result, observation),
          decision,
          adaptation.result,
        );
      case "clarification":
        return resultWithoutContext(
          respondToClarification(adaptation.context),
        );
      case "no-understanding":
        return resultWithoutContext(
          respondToParseResult(adaptation.failure, observation),
        );
      case "fallback-legacy":
        return resultWithAcceptedContext(
          respondToParseResult(adaptation.result, observation),
          decision,
          adaptation.result,
        );
      default: {
        const exhaustiveCheck: never = adaptation;
        throw new Error(
          `createSunlandEngine: unhandled semantic adaptation ${JSON.stringify(exhaustiveCheck)}`,
        );
      }
    }
  }

  return {
    knowledgeStore: store,
    memory,
    semanticMode,
    semanticContextMode,
    getLastSemanticShadow(): SemanticShadowDiagnostic | null {
      return semanticDebug ? lastSemanticShadow : null;
    },
    respond(input: string): string {
      return process(input).response;
    },
    process,
  };
}
