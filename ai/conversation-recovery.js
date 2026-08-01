import {
  isSupportedProviderId,
  mergeConversationCollections,
} from "./providers/conversation.js";
import { isSameUserIdentity, normalizeUserId } from "./user-identity.js";

const CURRENT_CONVERSATION_PREFIX = "current_conversation_";

function normalizeConversationList(value, expectedUserId = null) {
  if (!Array.isArray(value)) return null;

  return mergeConversationCollections([], value, { retainBaseOnly: false })
    .filter(conversation => (
      conversation &&
      typeof conversation === "object" &&
      conversation.id != null &&
      Array.isArray(conversation.history)
    ))
    .filter(conversation => (
      expectedUserId == null ||
      (
        conversation.userId == null
          ? conversation.provider === "deepseek"
          : isSameUserIdentity(expectedUserId, conversation.userId)
      )
    ));
}

export function filterConversationsForUser(value, userId) {
  const normalizedUserId = normalizeUserId(userId);
  if (!normalizedUserId) return [];
  return normalizeConversationList(value, normalizedUserId) || [];
}

export function getCurrentConversationStorageKey(userId) {
  const normalized = normalizeUserId(userId);
  return normalized ? `${CURRENT_CONVERSATION_PREFIX}${normalized}` : null;
}

export function parseStoredConversations(raw, fallback = [], expectedUserId = null) {
  const safeFallback = normalizeConversationList(fallback, expectedUserId) || [];
  if (raw == null || raw === "") {
    return { conversations: safeFallback, status: "missing" };
  }

  try {
    const parsedValue = JSON.parse(raw);
    const invalidProviderIds = new Set(
      Array.isArray(parsedValue)
        ? parsedValue
          .filter(item => (
            item &&
            typeof item === "object" &&
            Object.prototype.hasOwnProperty.call(item, "provider") &&
            !isSupportedProviderId(item.provider)
          ))
          .map(item => item.id)
        : [],
    );
    const normalized = normalizeConversationList(parsedValue, expectedUserId);
    if (!normalized) {
      return { conversations: safeFallback, status: "invalid" };
    }
    const conversations = mergeConversationCollections(safeFallback, normalized, {
      retainBaseOnly: false,
    });
    safeFallback.forEach(conversation => {
      if (
        invalidProviderIds.has(conversation.id) &&
        !conversations.some(item => item.id === conversation.id)
      ) {
        conversations.push(conversation);
      }
    });
    return {
      conversations,
      status: invalidProviderIds.size ? "invalid" : "ok",
    };
  } catch {
    return { conversations: safeFallback, status: "damaged" };
  }
}

export function parseStoredCurrentConversationId(raw, fallback = null) {
  if (raw == null || raw === "") return fallback;

  try {
    const value = JSON.parse(raw);
    return typeof value === "string" || typeof value === "number"
      ? value
      : fallback;
  } catch {
    return fallback;
  }
}

export function resolveCurrentConversation(conversations, preferredId = null) {
  const safeList = Array.isArray(conversations) ? conversations : [];
  const preferred = preferredId == null
    ? null
    : safeList.find(conversation => String(conversation.id) === String(preferredId));
  return preferred || safeList[0] || null;
}

export function restoreLocalConversationState({
  storage,
  userId,
  fallbackConversations = [],
  fallbackCurrentId = null,
}) {
  const normalizedUserId = normalizeUserId(userId);
  if (!normalizedUserId) {
    return {
      conversations: [],
      currentId: null,
      selectedConversation: null,
      status: "invalid-user",
    };
  }

  let rawConversations = null;
  let rawCurrentId = null;

  try {
    rawConversations = storage.getItem(`conversations_${normalizedUserId}`);
    rawCurrentId = storage.getItem(getCurrentConversationStorageKey(normalizedUserId));
  } catch {
    // Storage 不可用时保留同一用户当前内存状态，不修改任何持久化数据。
  }

  const parsed = parseStoredConversations(
    rawConversations,
    fallbackConversations,
    normalizedUserId,
  );
  const preferredId = parseStoredCurrentConversationId(rawCurrentId, fallbackCurrentId);
  const selected = resolveCurrentConversation(parsed.conversations, preferredId);

  return {
    conversations: parsed.conversations,
    currentId: selected?.id ?? null,
    selectedConversation: selected,
    status: parsed.status,
  };
}

export function persistCurrentConversationId(storage, userId, currentId) {
  const normalizedUserId = normalizeUserId(userId);
  if (!storage || !normalizedUserId || currentId == null) return false;

  try {
    storage.setItem(
      getCurrentConversationStorageKey(normalizedUserId),
      JSON.stringify(currentId),
    );
    return true;
  } catch {
    return false;
  }
}
