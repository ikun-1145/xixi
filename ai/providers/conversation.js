/**
 * Conversation data shape (Stage 3.6).
 *
 * A Conversation is created ONCE bound to a `provider` ("deepseek" |
 * "sunland" | ...future ids), and that field is treated as IMMUTABLE from
 * then on by convention: no code path in `app.js` ever reassigns
 * `conversation.provider` after creation -- only `createConversation()`
 * sets it. All other fields (`history`, `title`, `updatedAt`, ...) keep
 * being mutated exactly as before; this module only adds new fields, it
 * never changes what already existed on a conversation object.
 *
 * Shape:
 *   {
 *     id: number,          // Date.now() -- unchanged from before Stage 3.6
 *     provider: string,     // 🆕 immutable once set: "deepseek" | "sunland"
 *     model: string,        // sub-model/persona within the provider, e.g.
 *                           // "deepseek-v4-flash"/"deepseek-v4-pro" | "frost"
 *     userId: string|null,  // 🆕 who owns this conversation (Sunland's
 *                           // per-user shared brain is keyed by this)
 *     title: string,
 *     history: ChatMessage[],
 *     createdAt: number,    // 🆕 (previously only updatedAt existed)
 *     updatedAt: number,
 *   }
 */

/** Build a brand-new Conversation, provider bound at creation time. */
export function createConversation({ provider, model, userId = null, title = "新对话" } = {}) {
  const now = Date.now();
  return {
    id: now,
    provider,
    model,
    userId,
    title,
    history: [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Backward-compat migration for conversations created before Stage 3.6
 * (no `provider` field at all). Every one of those was, unconditionally,
 * a DeepSeek conversation -- that was the only thing that ever existed --
 * so the default is safe and lossless, not a guess.
 * A no-op (returns `raw` unchanged) for anything already migrated, so it's
 * safe to call on every load, repeatedly.
 */
export function migrateLegacyConversation(raw) {
  if (!raw || typeof raw !== "object" || raw.provider) return raw;
  return {
    ...raw,
    provider: "deepseek",
    model: raw.model || "deepseek-v4-flash",
    userId: raw.userId ?? null,
    createdAt: raw.createdAt || raw.updatedAt || raw.id || Date.now(),
  };
}

/** Migrate a whole conversations array; tolerant of non-array input. */
export function migrateLegacyConversations(list) {
  return Array.isArray(list) ? list.map(migrateLegacyConversation) : list;
}

/**
 * Whether a conversation has "started" (had at least one real exchange) --
 * once true, its `provider` must no longer be changeable by any UI. Mirrors
 * the existing `history.length <= 1` convention already used elsewhere in
 * `app.js` to detect a freshly-created, still-empty chat.
 */
export function hasConversationStarted(conversation) {
  return !!(conversation && Array.isArray(conversation.history) && conversation.history.length > 1);
}
