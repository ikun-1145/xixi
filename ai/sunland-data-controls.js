import {
  getVerifiedUserId,
  IdentityAuthority,
  isVerifiedIdentity,
} from "./verified-identity.js";
import {
  getSunlandKnowledgeStorageKey,
  SUNLAND_LOGIN_STATE_MESSAGE,
} from "./user-identity.js";

const NAME_MEMORY_KEY = "name";
const USER_KNOWLEDGE_SOURCE = "user";
const DATA_CHANNEL_NAME = "sunland-data-control-v1";
const identityAuthority = new IdentityAuthority();
const storageEnforcers = new Map();
const dataChannel = typeof BroadcastChannel === "function"
  ? new BroadcastChannel(DATA_CHANNEL_NAME)
  : null;

function readCachedDisplayUser() {
  try {
    const value = JSON.parse(localStorage.getItem("user") || "null");
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

async function resolveVerifiedIdentity() {
  const token = localStorage.getItem("token");
  const result = await identityAuthority.resolve({
    token,
    cachedUser: readCachedDisplayUser(),
    force: true,
  });
  if (!result.ok || !isVerifiedIdentity(result.identity)) return null;
  return result.identity;
}

function parseStoredRecords(raw) {
  if (raw === null) return { valid: true, records: [] };
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value)
      ? { valid: true, records: value }
      : { valid: false, records: [] };
  } catch {
    return { valid: false, records: [] };
  }
}

function serializeRecords(records) {
  return records.length ? JSON.stringify(records) : null;
}

function writeStoredValue(key, value) {
  if (value === null) {
    localStorage.removeItem(key);
  } else {
    localStorage.setItem(key, value);
  }
}

function recordCreatedAfter(record, cutoff) {
  const timestamp = Date.parse(record?.createdAt);
  return Number.isFinite(timestamp) && timestamp > cutoff;
}

function clearRecordsWithBoundary(key, userId, sessionToken, isTargetRecord) {
  const cutoff = Date.now();
  const parsed = parseStoredRecords(localStorage.getItem(key));
  const removedIds = new Set();
  const remaining = parsed.valid
    ? parsed.records.filter(record => {
      if (!isTargetRecord(record)) return true;
      if (typeof record?.id === "string") removedIds.add(record.id);
      return false;
    })
    : [];

  writeStoredValue(key, serializeRecords(remaining));

  // Other open AI tabs may still hold an older in-memory engine. Re-apply
  // this deletion only to records that existed before the clear operation;
  // genuinely new records created afterwards remain allowed.
  storageEnforcers.set(key, {
    userId,
    sessionToken,
    enforce(raw) {
      const next = parseStoredRecords(raw);
      if (!next.valid) return null;
      return serializeRecords(next.records.filter(record => (
        !isTargetRecord(record) ||
        (
          !removedIds.has(record?.id) &&
          recordCreatedAfter(record, cutoff)
        )
      )));
    },
  });
}

function setStatus(message, type = "") {
  const status = document.getElementById("sunlandDataStatus");
  if (!status) return;
  status.textContent = message;
  status.className = `sunland-data-status${type ? ` ${type}` : ""}`;
}

function notifySunlandDataChanged(userId) {
  dataChannel?.postMessage({
    type: "sunland-data-cleared",
    userId,
  });
}

async function runDangerousAction({
  button,
  confirmation,
  successMessage,
  action,
}) {
  if (!confirm(confirmation)) return;
  button.disabled = true;
  setStatus("正在处理，请稍候。");

  try {
    const identity = await resolveVerifiedIdentity();
    const userId = getVerifiedUserId(identity);
    const knowledgeKey = getSunlandKnowledgeStorageKey(userId);
    if (!identity || !userId || !knowledgeKey) {
      setStatus(SUNLAND_LOGIN_STATE_MESSAGE, "error");
      return;
    }

    action({
      userId,
      sessionToken: localStorage.getItem("token"),
      knowledgeKey,
      memoryKey: `${knowledgeKey}::memory`,
    });
    notifySunlandDataChanged(userId);
    setStatus(successMessage, "success");
  } catch (error) {
    console.error("Sunland data clear failed:", error);
    setStatus("暂时无法完成清除，请稍后再试。", "error");
  } finally {
    button.disabled = false;
  }
}

function bindDataControls() {
  const clearNameButton = document.getElementById("clearSunlandNameBtn");
  const clearKnowledgeButton = document.getElementById("clearSunlandKnowledgeBtn");
  if (!clearNameButton || !clearKnowledgeButton) return;

  clearNameButton.addEventListener("click", () => {
    runDangerousAction({
      button: clearNameButton,
      confirmation: "确定让 Sunland AI 忘记你的名字吗？聊天记录不会受到影响。",
      successMessage: "Sunland AI 已忘记你的名字，聊天记录没有受到影响。",
      action: ({ userId, sessionToken, memoryKey }) => {
        clearRecordsWithBoundary(
          memoryKey,
          userId,
          sessionToken,
          record => record?.key === NAME_MEMORY_KEY,
        );
      },
    });
  });

  clearKnowledgeButton.addEventListener("click", () => {
    runDangerousAction({
      button: clearKnowledgeButton,
      confirmation: "确定清除你教给 Sunland AI 的全部知识吗？系统内置知识和聊天记录不会受到影响。",
      successMessage: "你教给 Sunland AI 的知识已清除，系统内置知识和聊天记录没有受到影响。",
      action: ({ userId, sessionToken, knowledgeKey }) => {
        clearRecordsWithBoundary(
          knowledgeKey,
          userId,
          sessionToken,
          record => record?.source == null || record.source === USER_KNOWLEDGE_SOURCE,
        );
      },
    });
  });
}

window.addEventListener("storage", event => {
  const boundary = storageEnforcers.get(event.key);
  const currentIdentity = identityAuthority.current();
  if (
    !boundary ||
    getVerifiedUserId(currentIdentity) !== boundary.userId ||
    boundary.sessionToken !== localStorage.getItem("token")
  ) return;
  const currentValue = localStorage.getItem(event.key);
  const enforcedValue = boundary.enforce(currentValue);
  if (currentValue !== enforcedValue) writeStoredValue(event.key, enforcedValue);
});

bindDataControls();
