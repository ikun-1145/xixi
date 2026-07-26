const RESERVED_SHARED_IDENTITIES = new Set([
  "anonymous",
  "default",
  "guest",
  "null",
  "undefined",
]);

const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9@._+-]{0,127}$/;

export const SUNLAND_LOGIN_STATE_MESSAGE =
  "登录状态好像出了点问题，请重新登录后再试一下。";

export function normalizeUserId(value) {
  if (typeof value !== "string" || value !== value.trim()) return null;
  if (!USER_ID_PATTERN.test(value)) return null;
  if (RESERVED_SHARED_IDENTITIES.has(value.toLowerCase())) return null;
  return value;
}

export function isSameUserIdentity(sessionUserId, conversationUserId) {
  const sessionId = normalizeUserId(sessionUserId);
  const ownerId = normalizeUserId(conversationUserId);
  return !!sessionId && sessionId === ownerId;
}

export function getSunlandKnowledgeStorageKey(userId) {
  const normalized = normalizeUserId(userId);
  return normalized ? `sunland_knowledge_${normalized}` : null;
}
