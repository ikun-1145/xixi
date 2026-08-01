import { AIProvider } from "./AIProvider.js";
import { createSunlandEngine } from "../vendor/sunland-core.js";
import {
  getSunlandKnowledgeStorageKey,
  SUNLAND_LOGIN_STATE_MESSAGE,
} from "../user-identity.js";
import {
  getVerifiedUserId,
  isVerifiedIdentity,
} from "../verified-identity.js";
import { answerFurryEventQuestion } from "../furry-events.js";

/**
 * Sunland AI provider -- runs the Sunland Core engine (Parser -> Knowledge
 * -> Personality; a Reasoner lands later behind the same engine, Stage 4)
 * entirely IN THE BROWSER. No network round-trip, no external LLM: this is
 * the actual point of Sunland AI being a separate system, not a chatbot
 * skin over someone else's model.
 *
 * SHARED BRAIN, INDEPENDENT CONVERSATIONS: exactly one `SunlandEngine`
 * (and therefore exactly one `KnowledgeStore`) is created per logged-in
 * user and cached here for the lifetime of the page -- every Sunland
 * conversation that user has talks to the SAME evolving brain. `messages`
 * (the per-conversation chat transcript) is never fed back into the
 * engine wholesale: Sunland has no LLM-style rolling context window, so
 * only the latest user turn is parsed. This is a structural difference
 * from DeepSeek, not just a policy -- there is no code path by which one
 * provider's state can leak into the other's.
 *
 * Persistence uses `window.localStorage` directly -- it already satisfies
 * Core's `StorageAdapter` shape (`getItem`/`setItem`/`removeItem`) with zero
 * wrapper code. Swapping to Supabase later means swapping this one adapter
 * argument, nothing else.
 */
export class SunlandProvider extends AIProvider {
  constructor() {
    super();
    this.id = "sunland";
    this.displayName = "Sunland AI";
    // Free for every regular logged-in user -- never gated behind Pro.
    this.requiresPro = false;
    /** @type {Map<string, ReturnType<typeof createSunlandEngine>>} */
    this._engines = new Map();
  }

  /** One shared engine per user, created lazily, never demo-seeded. */
  _getEngine(identity) {
    const userId = getVerifiedUserId(identity);
    const storageKey = getSunlandKnowledgeStorageKey(userId);
    if (!isVerifiedIdentity(identity) || !userId || !storageKey) {
      throw new TypeError("Sunland engine requires a verified identity");
    }

    let engine = this._engines.get(userId);
    if (!engine) {
      engine = createSunlandEngine({
        storage: { adapter: window.localStorage, key: storageKey },
        semanticMode: "passive",
        semanticDebug: false,
        semanticContextMode: "enabled",
      });
      this._engines.set(userId, engine);
    }
    return engine;
  }

  async send({
    conversation,
    messages,
    onDelta,
    identity,
    semanticContext,
    furryContext,
    furryContextActive = false,
    turnId,
    canCommitSemanticContext,
    observationMode = "off",
    signal,
  }) {
    const userId = getVerifiedUserId(identity);
    if (!userId || userId !== conversation?.userId) {
      onDelta?.(SUNLAND_LOGIN_STATE_MESSAGE);
      return { content: SUNLAND_LOGIN_STATE_MESSAGE, blocked: true };
    }

    const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
    const input = lastUserMessage?.content ?? "";
    if (signal?.aborted) {
      return { content: "", blocked: true, semanticContextUpdate: null };
    }

    // 兽聚查询是一个独立、可解释的原生领域能力。查询结果以结构化上下文
    // 传入，而不是写进知识图谱或依赖外部 LLM；因此不会污染用户长期知识，
    // 同时能与 DeepSeek 使用同一份卡片数据回答当前问题。
    if (furryContextActive && furryContext) {
      const content = answerFurryEventQuestion(input, furryContext);
      onDelta?.(content);
      return { content, semanticContextUpdate: null };
    }

    const engine = this._getEngine(identity);

    // Symbolic reasoning is effectively instant -- no real stream to read,
    // but we still go through `onDelta` so the UI's rendering path is
    // identical regardless of which provider answered.
    const processed = engine.process(input, {
      semanticContext,
      turnId,
      observationMode: observationMode === "summary" ? "summary" : "off",
      canCommitSemanticContext: () => (
        signal?.aborted !== true &&
        canCommitSemanticContext?.() !== false
      ),
    });
    const content = processed.response;
    onDelta?.(content);

    const result = {
      content,
      semanticContextUpdate: processed.semanticContextUpdate,
    };
    if (processed.observationSummary) {
      result.observationSummary = processed.observationSummary;
    }
    return result;
  }
}
