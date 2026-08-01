import {
  getVerifiedToken,
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
const DATA_CHANGE_MESSAGE = "sunland-data-cleared";

function readCachedDisplayUser(storage) {
  try {
    const value = JSON.parse(storage?.getItem("user") || "null");
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
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

function writeStoredValue(storage, key, value) {
  if (value === null) {
    storage.removeItem(key);
  } else {
    storage.setItem(key, value);
  }
}

function recordCreatedAfter(record, cutoff) {
  const timestamp = Date.parse(record?.createdAt);
  return Number.isFinite(timestamp) && timestamp > cutoff;
}

function isUserKnowledgeRecord(record) {
  return !!record &&
    typeof record === "object" &&
    !Array.isArray(record) &&
    typeof record.id === "string" &&
    record.id.length > 0 &&
    typeof record.subject === "string" &&
    record.subject.length > 0 &&
    typeof record.relation === "string" &&
    record.relation.length > 0 &&
    typeof record.object === "string" &&
    record.object.length > 0 &&
    typeof record.negated === "boolean" &&
    (record.source == null || record.source === USER_KNOWLEDGE_SOURCE);
}

function knowledgeLabel(record) {
  return `${record.subject} ${record.negated ? "不" : ""}${record.relation} ${record.object}`;
}

function readUserKnowledge(storage, knowledgeKey) {
  const parsed = parseStoredRecords(storage.getItem(knowledgeKey));
  if (!parsed.valid) return { ok: false, records: [] };

  const recordsById = new Map();
  for (const record of parsed.records) {
    if (!isUserKnowledgeRecord(record) || recordsById.has(record.id)) {
      continue;
    }
    recordsById.set(record.id, Object.freeze({
      id: record.id,
      label: knowledgeLabel(record),
    }));
  }
  return {
    ok: true,
    records: Object.freeze([...recordsById.values()]),
  };
}

function appendDeletionBoundary(
  storageEnforcers,
  key,
  userId,
  sessionToken,
  rule,
) {
  const previous = storageEnforcers.get(key);
  const rules = previous?.userId === userId &&
    previous.sessionToken === sessionToken
    ? [...previous.rules, rule]
    : [rule];

  storageEnforcers.set(key, {
    userId,
    sessionToken,
    rules,
    enforce(raw) {
      const next = parseStoredRecords(raw);
      if (!next.valid) return null;
      let records = next.records;
      for (const boundary of rules) {
        records = records.filter(record => (
          !boundary.isTargetRecord(record) ||
          (
            !boundary.removedIds.has(record?.id) &&
            recordCreatedAfter(record, boundary.cutoff)
          )
        ));
      }
      return serializeRecords(records);
    },
  });
}

function clearRecordsWithBoundary({
  storage,
  storageEnforcers,
  key,
  userId,
  sessionToken,
  isTargetRecord,
}) {
  const parsed = parseStoredRecords(storage.getItem(key));
  if (!parsed.valid) return { ok: false, reason: "invalid-storage" };

  const cutoff = Date.now();
  const removedIds = new Set();
  const remaining = parsed.records.filter(record => {
    if (!isTargetRecord(record)) return true;
    if (typeof record?.id === "string") removedIds.add(record.id);
    return false;
  });
  const removedCount = parsed.records.length - remaining.length;

  if (removedCount === 0) {
    return { ok: true, removedCount: 0 };
  }

  writeStoredValue(storage, key, serializeRecords(remaining));
  appendDeletionBoundary(
    storageEnforcers,
    key,
    userId,
    sessionToken,
    {
      cutoff,
      removedIds,
      isTargetRecord,
    },
  );
  return { ok: true, removedCount };
}

function createDataSyncChannel({
  BroadcastChannelImpl = globalThis.BroadcastChannel,
} = {}) {
  let channel = null;
  let disposed = false;
  const listeners = new Set();

  try {
    if (typeof BroadcastChannelImpl === "function") {
      channel = new BroadcastChannelImpl(DATA_CHANNEL_NAME);
      channel.addEventListener("message", event => {
        const message = event?.data;
        if (
          disposed ||
          message?.type !== DATA_CHANGE_MESSAGE ||
          typeof message.userId !== "string"
        ) return;
        for (const listener of listeners) {
          try {
            listener(message.userId);
          } catch {
            // One settings listener must not affect the others.
          }
        }
      });
    }
  } catch {
    channel = null;
  }

  return Object.freeze({
    notify(userId) {
      if (disposed || !channel || typeof userId !== "string") return false;
      try {
        channel.postMessage({
          type: DATA_CHANGE_MESSAGE,
          userId,
        });
        return true;
      } catch {
        return false;
      }
    },

    subscribe(listener) {
      if (disposed || typeof listener !== "function") return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    dispose() {
      if (disposed) return false;
      disposed = true;
      listeners.clear();
      try {
        channel?.close();
      } catch {
        // Best-effort only.
      }
      channel = null;
      return true;
    },
  });
}

export function createSunlandDataControlsController({
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  storageRef = globalThis.localStorage,
  identityAuthority = new IdentityAuthority(),
  syncChannel = createDataSyncChannel({
    BroadcastChannelImpl: windowRef?.BroadcastChannel,
  }),
  confirmImpl = message => (
    typeof windowRef?.confirm === "function" &&
    windowRef.confirm(message)
  ),
} = {}) {
  const elements = {
    clearNameButton: documentRef?.getElementById("clearSunlandNameBtn"),
    clearKnowledgeButton: documentRef?.getElementById("clearSunlandKnowledgeBtn"),
    knowledgeCount: documentRef?.getElementById("sunlandKnowledgeCount"),
    knowledgeEmpty: documentRef?.getElementById("sunlandKnowledgeEmpty"),
    knowledgeList: documentRef?.getElementById("sunlandKnowledgeList"),
    status: documentRef?.getElementById("sunlandDataStatus"),
  };
  const storageEnforcers = new Map();
  let identity = null;
  let knowledgeKey = null;
  let knowledgeRecords = [];
  let knowledgeReadable = false;
  let busy = false;
  let initialized = false;
  let disposed = false;
  let lifecycleVersion = 0;
  let unsubscribeSync = () => {};

  function setStatus(message, type = "") {
    if (!elements.status) return;
    elements.status.textContent = message;
    elements.status.className =
      `sunland-data-status${type ? ` ${type}` : ""}`;
  }

  function renderKnowledgeList() {
    if (!elements.knowledgeList || !elements.knowledgeEmpty) return;
    elements.knowledgeList.textContent = "";

    const identityValid = isVerifiedIdentity(identity);
    const controlsDisabled = busy || !identityValid;
    if (elements.clearNameButton) {
      elements.clearNameButton.disabled = controlsDisabled;
    }
    if (elements.clearKnowledgeButton) {
      elements.clearKnowledgeButton.disabled =
        controlsDisabled || !knowledgeReadable ||
        knowledgeRecords.length === 0;
    }

    if (elements.knowledgeCount) {
      elements.knowledgeCount.textContent = !identityValid
        ? "需要重新登录"
        : knowledgeReadable
          ? `共 ${knowledgeRecords.length} 条`
          : "暂时无法读取";
    }

    if (!identityValid) {
      elements.knowledgeEmpty.hidden = false;
      elements.knowledgeEmpty.textContent = SUNLAND_LOGIN_STATE_MESSAGE;
      return;
    }
    if (!knowledgeReadable) {
      elements.knowledgeEmpty.hidden = false;
      elements.knowledgeEmpty.textContent =
        "暂时无法读取教学知识，请稍后再试。";
      return;
    }
    if (knowledgeRecords.length === 0) {
      elements.knowledgeEmpty.hidden = false;
      elements.knowledgeEmpty.textContent = "暂无用户教学知识";
      return;
    }

    elements.knowledgeEmpty.hidden = true;
    for (const record of knowledgeRecords) {
      const item = documentRef.createElement("li");
      item.className = "sunland-knowledge-item";

      const text = documentRef.createElement("span");
      text.className = "sunland-knowledge-text";
      text.textContent = record.label;

      const button = documentRef.createElement("button");
      button.className = "knowledge-delete-btn";
      button.type = "button";
      button.textContent = "删除";
      button.disabled = busy;
      button.setAttribute(
        "aria-label",
        `删除教学知识：${record.label}`,
      );
      button.addEventListener("click", () => {
        void deleteKnowledgeRecord(record.id, record.label);
      });

      item.append(text, button);
      elements.knowledgeList.appendChild(item);
    }
  }

  async function resolveVerifiedIdentity({ force = false } = {}) {
    let token;
    try {
      token = storageRef?.getItem("token");
    } catch {
      token = null;
    }
    const result = await identityAuthority.resolve({
      token,
      cachedUser: readCachedDisplayUser(storageRef),
      force,
    });
    if (
      !result.ok ||
      !isVerifiedIdentity(result.identity) ||
      getVerifiedToken(result.identity) !== storageRef?.getItem("token")
    ) {
      return null;
    }
    return result.identity;
  }

  async function refreshKnowledgeList({ forceIdentity = false } = {}) {
    const version = ++lifecycleVersion;
    let nextIdentity;
    try {
      nextIdentity = await resolveVerifiedIdentity({
        force: forceIdentity,
      });
    } catch {
      nextIdentity = null;
    }
    if (disposed || version !== lifecycleVersion) {
      return { ok: false, reason: "stale-refresh" };
    }

    const nextUserId = getVerifiedUserId(nextIdentity);
    const nextKnowledgeKey =
      getSunlandKnowledgeStorageKey(nextUserId);
    if (!nextIdentity || !nextUserId || !nextKnowledgeKey) {
      identityAuthority.clear();
      identity = null;
      knowledgeKey = null;
      knowledgeRecords = [];
      knowledgeReadable = false;
      storageEnforcers.clear();
      renderKnowledgeList();
      return { ok: false, reason: "invalid-identity" };
    }

    if (getVerifiedUserId(identity) !== nextUserId) {
      storageEnforcers.clear();
    }
    identity = nextIdentity;
    knowledgeKey = nextKnowledgeKey;

    try {
      const snapshot = readUserKnowledge(storageRef, knowledgeKey);
      knowledgeReadable = snapshot.ok;
      knowledgeRecords = snapshot.records;
    } catch {
      knowledgeReadable = false;
      knowledgeRecords = [];
    }
    renderKnowledgeList();
    return {
      ok: knowledgeReadable,
      count: knowledgeRecords.length,
    };
  }

  async function runDangerousAction({
    confirmation,
    successMessage,
    action,
  }) {
    if (!confirmImpl(confirmation)) {
      return { ok: false, reason: "cancelled" };
    }
    busy = true;
    renderKnowledgeList();
    setStatus("正在处理，请稍候。");

    try {
      const verifiedIdentity = await resolveVerifiedIdentity({
        force: true,
      });
      const userId = getVerifiedUserId(verifiedIdentity);
      const verifiedKnowledgeKey =
        getSunlandKnowledgeStorageKey(userId);
      const sessionToken = storageRef?.getItem("token");
      if (
        !verifiedIdentity ||
        !userId ||
        !verifiedKnowledgeKey ||
        getVerifiedToken(verifiedIdentity) !== sessionToken
      ) {
        identity = null;
        knowledgeKey = null;
        knowledgeRecords = [];
        knowledgeReadable = false;
        setStatus(SUNLAND_LOGIN_STATE_MESSAGE, "error");
        return { ok: false, reason: "invalid-identity" };
      }

      identity = verifiedIdentity;
      knowledgeKey = verifiedKnowledgeKey;
      const result = action({
        userId,
        sessionToken,
        knowledgeKey,
        memoryKey: `${knowledgeKey}::memory`,
      });
      if (!result?.ok) {
        setStatus(
          "暂时无法完成这个操作，请稍后再试。",
          "error",
        );
        return result ?? { ok: false, reason: "action-failed" };
      }

      if (result.removedCount > 0) {
        syncChannel.notify(userId);
      }
      await refreshKnowledgeList();
      setStatus(
        result.removedCount > 0
          ? successMessage
          : "对应的数据已经不存在，列表已刷新。",
        result.removedCount > 0 ? "success" : "",
      );
      return result;
    } catch {
      setStatus("暂时无法完成这个操作，请稍后再试。", "error");
      return { ok: false, reason: "operation-failed" };
    } finally {
      busy = false;
      renderKnowledgeList();
    }
  }

  function deleteKnowledgeRecord(recordId, label = "") {
    if (
      typeof recordId !== "string" ||
      !knowledgeRecords.some(record => record.id === recordId)
    ) {
      return Promise.resolve({
        ok: false,
        reason: "unknown-record",
      });
    }
    return runDangerousAction({
      confirmation:
        `确定删除“${label}”吗？删除后无法恢复。`,
      successMessage: "这条教学知识已删除。",
      action: ({ userId, sessionToken, knowledgeKey: key }) =>
        clearRecordsWithBoundary({
          storage: storageRef,
          storageEnforcers,
          key,
          userId,
          sessionToken,
          isTargetRecord: record => (
            record?.id === recordId &&
            isUserKnowledgeRecord(record)
          ),
        }),
    });
  }

  function bindEvents() {
    elements.clearNameButton?.addEventListener("click", () => {
      void runDangerousAction({
        confirmation:
          "确定让 Sunland AI 忘记你的名字吗？聊天记录不会受到影响。",
        successMessage:
          "Sunland AI 已忘记你的名字，聊天记录没有受到影响。",
        action: ({ userId, sessionToken, memoryKey }) =>
          clearRecordsWithBoundary({
            storage: storageRef,
            storageEnforcers,
            key: memoryKey,
            userId,
            sessionToken,
            isTargetRecord: record =>
              record?.key === NAME_MEMORY_KEY,
          }),
      });
    });

    elements.clearKnowledgeButton?.addEventListener("click", () => {
      void runDangerousAction({
        confirmation:
          "确定清除你教给 Sunland AI 的全部知识吗？系统内置知识和聊天记录不会受到影响。",
        successMessage:
          "你教给 Sunland AI 的知识已清除，系统内置知识和聊天记录没有受到影响。",
        action: ({ userId, sessionToken, knowledgeKey: key }) =>
          clearRecordsWithBoundary({
            storage: storageRef,
            storageEnforcers,
            key,
            userId,
            sessionToken,
            isTargetRecord: isUserKnowledgeRecord,
          }),
      });
    });

    windowRef?.addEventListener?.("storage", handleStorageChange);
    unsubscribeSync = syncChannel.subscribe(userId => {
      if (userId === getVerifiedUserId(identity)) {
        void refreshKnowledgeList();
      }
    });
  }

  function handleStorageChange(event) {
    if (disposed) return;
    const boundary = storageEnforcers.get(event?.key);
    const currentIdentity = identityAuthority.current();
    if (
      boundary &&
      getVerifiedUserId(currentIdentity) === boundary.userId &&
      boundary.sessionToken === storageRef?.getItem("token")
    ) {
      const currentValue = storageRef.getItem(event.key);
      const enforcedValue = boundary.enforce(currentValue);
      if (currentValue !== enforcedValue) {
        writeStoredValue(storageRef, event.key, enforcedValue);
      }
    }

    if (event?.key === "token") {
      void refreshKnowledgeList({ forceIdentity: true });
      return;
    }
    if (event?.key === knowledgeKey) {
      void refreshKnowledgeList();
    }
  }

  async function initialize() {
    if (disposed) return { ok: false, reason: "disposed" };
    if (!initialized) {
      initialized = true;
      bindEvents();
    }
    return refreshKnowledgeList({ forceIdentity: true });
  }

  function dispose() {
    if (disposed) return false;
    disposed = true;
    lifecycleVersion += 1;
    unsubscribeSync();
    syncChannel.dispose();
    windowRef?.removeEventListener?.(
      "storage",
      handleStorageChange,
    );
    identityAuthority.clear();
    identity = null;
    knowledgeKey = null;
    knowledgeRecords = [];
    storageEnforcers.clear();
    return true;
  }

  return Object.freeze({
    initialize,
    refreshKnowledgeList,
    deleteKnowledgeRecord,
    dispose,
    getState() {
      return Object.freeze({
        identityValid: isVerifiedIdentity(identity),
        knowledgeReadable,
        knowledgeCount: knowledgeRecords.length,
        busy,
      });
    },
  });
}

if (typeof document !== "undefined") {
  const defaultController =
    createSunlandDataControlsController();
  void defaultController.initialize();
}
