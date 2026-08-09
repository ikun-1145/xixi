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
// Legacy-only Context envelope helpers. New turns keep Context on the remote
// service; these functions exist solely to import pre-migration conversations
// without loading or executing Symbolic Core in the browser.
function createEmptySemanticContext() {
  return { schemaVersion: 1, version: 0, recentTurns: [] };
}

function normalizeSemanticContext(value) {
  if (!hasValidSemanticContextEnvelope(value)) return createEmptySemanticContext();
  return {
    schemaVersion: 1,
    version: value.version,
    recentTurns: value.recentTurns.slice(-6),
  };
}

function applySemanticContextUpdate(currentValue, update) {
  const current = normalizeSemanticContext(currentValue);
  if (
    update?.kind !== "replace" || update.baseVersion !== current.version ||
    update.nextVersion !== current.version + 1 ||
    update.context?.version !== update.nextVersion
  ) return current;
  return normalizeSemanticContext(update.context);
}

export const SUPPORTED_PROVIDER_IDS = Object.freeze(["deepseek", "sunland"]);
const SUPPORTED_PROVIDERS = new Set(SUPPORTED_PROVIDER_IDS);

export function conversationIdKey(value) {
  return value == null ? null : String(value);
}

export function isSupportedProviderId(provider) {
  return typeof provider === "string" && SUPPORTED_PROVIDERS.has(provider);
}

export function assertSupportedProviderId(provider) {
  if (!isSupportedProviderId(provider)) {
    throw new TypeError(`Unsupported conversation provider: ${String(provider)}`);
  }
  return provider;
}

function hasValidSemanticContextEnvelope(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.schemaVersion === 1 &&
    Number.isSafeInteger(value.version) &&
    value.version >= 0 &&
    Array.isArray(value.recentTurns)
  );
}

export function normalizeConversationSemanticContext(value) {
  return hasValidSemanticContextEnvelope(value)
    ? normalizeSemanticContext(value)
    : createEmptySemanticContext();
}

export function cloneConversationSemanticContext(conversation) {
  return conversation?.provider === "sunland"
    ? normalizeConversationSemanticContext(conversation.semanticContext)
    : null;
}

/** Build a brand-new Conversation, provider bound at creation time. */
export function createConversation({ provider, model, userId = null, title = "新对话" } = {}) {
  assertSupportedProviderId(provider);
  const now = Date.now();
  const conversation = {
    id: now,
    provider,
    model,
    userId,
    title,
    history: [],
    createdAt: now,
    updatedAt: now,
  };
  if (provider === "sunland") {
    conversation.semanticContext = createEmptySemanticContext();
  }
  return conversation;
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
  if (!raw || typeof raw !== "object") return raw;
  if (Object.prototype.hasOwnProperty.call(raw, "provider")) {
    if (!isSupportedProviderId(raw.provider)) return null;
    if (raw.provider === "sunland") {
      const semanticContext = normalizeConversationSemanticContext(
        raw.semanticContext,
      );
      return raw.semanticContext === semanticContext
        ? raw
        : { ...raw, semanticContext };
    }
    if (Object.prototype.hasOwnProperty.call(raw, "semanticContext")) {
      const normalized = { ...raw };
      delete normalized.semanticContext;
      return normalized;
    }
    return raw;
  }
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
 * Whether a conversation has "started" (has its first non-system message) --
 * once true, its `provider` must no longer be changeable by any UI. Checking
 * message roles instead of a magic history length also protects legacy or
 * future conversations that do not contain exactly one system message.
 */
export function hasConversationStarted(conversation) {
  return !!(
    conversation &&
    Array.isArray(conversation.history) &&
    conversation.history.some(message => message?.role !== "system")
  );
}

/**
 * Make the provider field physically immutable once the first real message is
 * present. The property stays enumerable so JSON persistence is unchanged.
 */
export function sealConversationProvider(conversation) {
  if (!hasConversationStarted(conversation) || !isSupportedProviderId(conversation.provider)) {
    return conversation;
  }

  const descriptor = Object.getOwnPropertyDescriptor(conversation, "provider");
  if (descriptor?.writable === false && descriptor?.configurable === false) return conversation;
  Object.defineProperty(conversation, "provider", {
    value: conversation.provider,
    enumerable: true,
    configurable: false,
    writable: false,
  });
  return conversation;
}

/**
 * Provider changes are allowed only while a conversation is still empty.
 * Callers never assign `conversation.provider` directly.
 */
export function setConversationProvider(conversation, provider, model) {
  if (!conversation || typeof conversation !== "object") return false;
  if (!isSupportedProviderId(provider)) return false;
  if (hasConversationStarted(conversation) && conversation.provider !== provider) return false;

  if (conversation.provider !== provider) conversation.provider = provider;
  if (model) conversation.model = model;
  if (provider === "sunland") {
    conversation.semanticContext = normalizeConversationSemanticContext(
      conversation.semanticContext,
    );
  } else {
    delete conversation.semanticContext;
  }
  return true;
}

function normalizedConversation(raw) {
  const migrated = migrateLegacyConversation(raw);
  if (!migrated || typeof migrated !== "object") return null;
  if (!isSupportedProviderId(migrated.provider)) return null;
  if (migrated.id == null || !Array.isArray(migrated.history)) return null;
  const normalized = { ...migrated };
  if (normalized.provider === "sunland") {
    normalized.semanticContext = normalizeConversationSemanticContext(
      normalized.semanticContext,
    );
  } else {
    delete normalized.semanticContext;
  }
  return sealConversationProvider(normalized);
}

function mergedSemanticContext(existingRaw, incomingRaw) {
  const existing = normalizeConversationSemanticContext(
    existingRaw?.semanticContext,
  );
  if (
    incomingRaw?.provider !== "sunland" ||
    !hasValidSemanticContextEnvelope(incomingRaw?.semanticContext)
  ) {
    return existing;
  }
  const incoming = normalizeConversationSemanticContext(
    incomingRaw.semanticContext,
  );
  return incoming.version > existing.version ? incoming : existing;
}

export function applyConversationSemanticContextUpdate(
  conversation,
  update,
) {
  if (!conversation || conversation.provider !== "sunland") return false;
  const current = normalizeConversationSemanticContext(
    conversation.semanticContext,
  );
  const next = applySemanticContextUpdate(current, update);
  if (next === current || next.version === current.version) return false;
  conversation.semanticContext = next;
  return true;
}

/**
 * Merge mutable conversation data while preserving the provider that was
 * already bound when the first message was written. A started incoming copy
 * may establish the provider only when the local copy is still empty.
 */
export function mergeConversationRecords(existingRaw, incomingRaw) {
  const existing = normalizedConversation(existingRaw);
  const incoming = normalizedConversation(incomingRaw);
  if (!incoming) return existing;
  if (!existing) return incoming;
  // Flutter 会把会话 id 序列化为字符串，网页端历史数据则可能是数字。
  // 两者表示同一个毫秒时间戳时必须合并，避免跨端同步后出现重复会话。
  if (conversationIdKey(existing.id) !== conversationIdKey(incoming.id)) {
    return existing;
  }
  if (
    existing.userId != null &&
    incoming.userId != null &&
    existing.userId !== incoming.userId
  ) {
    return existing;
  }

  const existingStarted = hasConversationStarted(existing);
  const incomingStarted = hasConversationStarted(incoming);
  let winner;
  if (!existingStarted && incomingStarted) {
    winner = incoming;
  } else {
    winner = (incoming.updatedAt || 0) > (existing.updatedAt || 0)
      ? incoming
      : existing;
  }

  const provider = existingStarted && incoming.provider !== existing.provider
    ? existing.provider
    : winner.provider;
  const merged = {
      ...winner,
      provider,
      ...(existingStarted && incoming.provider !== existing.provider
        ? { model: existing.model }
        : {}),
  };
  if (provider === "sunland") {
    merged.semanticContext = mergedSemanticContext(existingRaw, incomingRaw);
  } else {
    delete merged.semanticContext;
  }

  return sealConversationProvider(merged);
}

/**
 * Local/cloud/realtime all use this one merge policy. Unknown providers are
 * rejected instead of being routed to DeepSeek.
 */
export function mergeConversationCollections(baseValue, incomingValue, {
  retainBaseOnly = true,
} = {}) {
  const normalizeUnique = value => {
    const records = Array.isArray(value)
      ? value.map(normalizedConversation).filter(Boolean)
      : [];
    const unique = new Map();
    records.forEach(record => {
      const key = conversationIdKey(record.id);
      unique.set(key, mergeConversationRecords(unique.get(key), record));
    });
    return Array.from(unique.values());
  };
  const base = normalizeUnique(baseValue);
  const incoming = normalizeUnique(incomingValue);
  const baseById = new Map(
    base.map(conversation => [conversationIdKey(conversation.id), conversation]),
  );
  const merged = incoming.map(conversation => (
    mergeConversationRecords(
      baseById.get(conversationIdKey(conversation.id)),
      conversation,
    )
  )).filter(Boolean);

  if (retainBaseOnly) {
    const incomingIds = new Set(
      incoming.map(conversation => conversationIdKey(conversation.id)),
    );
    base.forEach(conversation => {
      if (!incomingIds.has(conversationIdKey(conversation.id))) {
        merged.push(conversation);
      }
    });
  }

  return merged;
}
