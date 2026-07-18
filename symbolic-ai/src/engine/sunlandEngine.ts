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
}

export interface SunlandEngine {
  /** Parse + route + render a single conversational turn. Never throws. */
  respond(input: string): string;
  /** The shared brain backing this engine instance (e.g. for visualization). */
  readonly knowledgeStore: KnowledgeStore;
  /** Facts remembered ABOUT the user (name today; age/preferences later). */
  readonly memory: MemoryManager;
}

const IDENTITY_ASPECT_RELATION: Record<IdentityAspect, Relation> = {
  identity: CoreRelations.Is,
  capability: CoreRelations.Can,
  creator: CREATOR_RELATION,
};

function isIdentityAspect(value: string | undefined): value is IdentityAspect {
  return value === "identity" || value === "capability" || value === "creator";
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

  return {
    knowledgeStore: store,
    memory,
    respond(input: string): string {
      const parsed: ParseResult = parser.parse(input);
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
          // Reasoner produces Answer/Confidence/Evidence only; the Response
          // Planner decides whether to answer plainly, explain the
          // derivation (only when the user asked "为什么"), or hedge on low
          // confidence; Personality then renders that decision in its voice.
          const result = graphReasoner.answer(parsed, store);
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
    },
  };
}
