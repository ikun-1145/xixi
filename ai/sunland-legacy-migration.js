import { getSunlandKnowledgeStorageKey } from "./user-identity.js";
import { getVerifiedToken, getVerifiedUserId } from "./verified-identity.js";

function parseRawArray(raw) {
  if (raw == null) return { ok: true, value: [] };
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? { ok: true, value } : { ok: false, value: [] };
  } catch {
    return { ok: false, value: [] };
  }
}

function snapshotKeys(userId) {
  return {
    knowledge: `sunland_remote_legacy_knowledge_${userId}`,
    memory: `sunland_remote_legacy_memory_${userId}`,
    conversations: `sunland_remote_legacy_conversations_${userId}`,
  };
}

export function preserveSunlandLegacyState({ identity, storage }) {
  const userId = getVerifiedUserId(identity);
  const knowledgeKey = getSunlandKnowledgeStorageKey(userId);
  if (!userId || !knowledgeKey || !storage) return false;
  try {
    const marker = JSON.parse(storage.getItem(`sunland_remote_migration_${userId}`) || "null");
    if (marker?.status === "complete") return true;
  } catch {}
  const snapshots = snapshotKeys(userId);
  const sources = {
    knowledge: knowledgeKey,
    memory: `${knowledgeKey}::memory`,
    conversations: `conversations_${userId}`,
  };
  Object.entries(sources).forEach(([name, sourceKey]) => {
    const raw = storage.getItem(sourceKey);
    if (raw != null && storage.getItem(snapshots[name]) == null) {
      storage.setItem(snapshots[name], raw);
    }
  });
  return true;
}

function validContext(value) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    value.schemaVersion === 1 && Number.isSafeInteger(value.version) &&
    value.version >= 0 && Array.isArray(value.recentTurns);
}

function newMigrationId() {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `migration-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function ensureSunlandLegacyMigration({ identity, storage, sendRequest, signal }) {
  const userId = getVerifiedUserId(identity);
  const token = getVerifiedToken(identity);
  const knowledgeKey = getSunlandKnowledgeStorageKey(userId);
  if (!userId || !token || !knowledgeKey || !storage) return { ok: false, reason: "invalid-identity" };
  const markerKey = `sunland_remote_migration_${userId}`;
  let marker;
  try {
    marker = JSON.parse(storage.getItem(markerKey) || "null");
  } catch {
    marker = null;
  }
  if (marker?.status === "complete") return { ok: true, reused: true };

  preserveSunlandLegacyState({ identity, storage });
  const snapshots = snapshotKeys(userId);
  const rawKnowledge = storage.getItem(snapshots.knowledge) ?? storage.getItem(knowledgeKey);
  const rawMemory = storage.getItem(snapshots.memory) ?? storage.getItem(`${knowledgeKey}::memory`);
  const conversationsKey = `conversations_${userId}`;
  const rawConversations = storage.getItem(snapshots.conversations) ?? storage.getItem(conversationsKey);
  const knowledge = parseRawArray(rawKnowledge);
  const memory = parseRawArray(rawMemory);
  const conversations = parseRawArray(rawConversations);
  if (!knowledge.ok || !memory.ok || !conversations.ok) {
    return { ok: false, reason: "invalid-local-state" };
  }
  const contexts = conversations.value
    .filter((conversation) => conversation?.provider === "sunland" && validContext(conversation.semanticContext))
    .map((conversation) => ({ conversationId: String(conversation.id), context: conversation.semanticContext }));
  const migrationId = typeof marker?.migrationId === "string" ? marker.migrationId : newMigrationId();
  storage.setItem(markerKey, JSON.stringify({ migrationId, status: "pending" }));

  const response = await sendRequest("/v1/migrations/local-state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ migrationId, knowledge: knowledge.value, memory: memory.value, contexts }),
    signal,
  }, { token, userId });
  if (!response?.ok) return { ok: false, reason: "remote-failure" };
  const receipt = await response.json();
  if (receipt?.migrationId !== migrationId || receipt?.status !== "complete") {
    return { ok: false, reason: "invalid-receipt" };
  }

  if (storage.getItem(knowledgeKey) === rawKnowledge) storage.removeItem(knowledgeKey);
  if (storage.getItem(`${knowledgeKey}::memory`) === rawMemory) {
    storage.removeItem(`${knowledgeKey}::memory`);
  }
  const currentConversations = parseRawArray(storage.getItem(conversationsKey));
  if (currentConversations.ok && storage.getItem(conversationsKey) != null) {
    const withoutContext = currentConversations.value.map((conversation) => {
      if (conversation?.provider !== "sunland" || !("semanticContext" in conversation)) return conversation;
      const copy = { ...conversation };
      delete copy.semanticContext;
      return copy;
    });
    storage.setItem(conversationsKey, JSON.stringify(withoutContext));
  }
  Object.values(snapshots).forEach(key => storage.removeItem(key));
  storage.setItem(markerKey, JSON.stringify({ migrationId, status: "complete" }));
  return { ok: true, migrationId };
}
