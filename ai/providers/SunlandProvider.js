import { AIProvider } from "./AIProvider.js";
import { createSunlandEngine } from "../vendor/sunland-core.js";

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
  _getEngine(userId) {
    const key = String(userId ?? "anonymous");
    let engine = this._engines.get(key);
    if (!engine) {
      engine = createSunlandEngine({
        storage: { adapter: window.localStorage, key: `sunland_knowledge_${key}` },
      });
      this._engines.set(key, engine);
    }
    return engine;
  }

  async send({ conversation, messages, onDelta }) {
    const engine = this._getEngine(conversation?.userId);
    const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
    const input = lastUserMessage?.content ?? "";

    // Symbolic reasoning is effectively instant -- no real stream to read,
    // but we still go through `onDelta` so the UI's rendering path is
    // identical regardless of which provider answered.
    const content = engine.respond(input);
    onDelta?.(content);

    return { content };
  }
}
