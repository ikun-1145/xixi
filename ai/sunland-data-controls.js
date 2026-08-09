import {
  getVerifiedToken,
  getVerifiedUserId,
  IdentityAuthority,
  isVerifiedIdentity,
} from "./verified-identity.js";
import { SUNLAND_LOGIN_STATE_MESSAGE } from "./user-identity.js";

const API_BASE = "https://ai-core.sunland.dev";
const CHANNEL_NAME = "sunland-data-control-v1";

function readCachedUser(storage) {
  try {
    const value = JSON.parse(storage?.getItem("user") || "null");
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function label(record) {
  return `${record.subject} ${record.negated ? "不" : ""}${record.relation} ${record.object}`;
}

function createChannel(BroadcastChannelImpl) {
  let channel = null;
  const listeners = new Set();
  try {
    if (typeof BroadcastChannelImpl === "function") {
      channel = new BroadcastChannelImpl(CHANNEL_NAME);
      channel.addEventListener("message", (event) => {
        if (event.data?.type !== "sunland-data-changed") return;
        listeners.forEach((listener) => listener(event.data.userId));
      });
    }
  } catch {
    channel = null;
  }
  return {
    notify(userId) { channel?.postMessage({ type: "sunland-data-changed", userId }); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { listeners.clear(); channel?.close(); },
  };
}

export function createSunlandDataControlsController({
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  storageRef = globalThis.localStorage,
  identityAuthority = new IdentityAuthority(),
  fetchImpl = (...args) => fetch(...args),
  confirmImpl = (message) => windowRef?.confirm?.(message) === true,
  syncChannel = createChannel(windowRef?.BroadcastChannel),
} = {}) {
  const elements = {
    clearName: documentRef?.getElementById("clearSunlandNameBtn"),
    clearKnowledge: documentRef?.getElementById("clearSunlandKnowledgeBtn"),
    count: documentRef?.getElementById("sunlandKnowledgeCount"),
    empty: documentRef?.getElementById("sunlandKnowledgeEmpty"),
    list: documentRef?.getElementById("sunlandKnowledgeList"),
    status: documentRef?.getElementById("sunlandDataStatus"),
  };
  let identity = null;
  let records = [];
  let readable = false;
  let busy = false;
  let disposed = false;
  let unsubscribe = () => {};

  function setStatus(message, type = "") {
    if (!elements.status) return;
    elements.status.textContent = message;
    elements.status.className = `sunland-data-status${type ? ` ${type}` : ""}`;
  }

  function render() {
    const valid = isVerifiedIdentity(identity);
    if (elements.clearName) elements.clearName.disabled = busy || !valid;
    if (elements.clearKnowledge) elements.clearKnowledge.disabled = busy || !valid || !readable || records.length === 0;
    if (elements.count) elements.count.textContent = !valid ? "需要重新登录" : readable ? `共 ${records.length} 条` : "暂时无法读取";
    if (!elements.list || !elements.empty) return;
    elements.list.textContent = "";
    if (!valid || !readable || records.length === 0) {
      elements.empty.hidden = false;
      elements.empty.textContent = !valid
        ? SUNLAND_LOGIN_STATE_MESSAGE
        : readable ? "暂无用户教学知识" : "暂时无法读取教学知识，请稍后再试。";
      return;
    }
    elements.empty.hidden = true;
    for (const record of records) {
      const item = documentRef.createElement("li");
      item.className = "sunland-knowledge-item";
      const text = documentRef.createElement("span");
      text.className = "sunland-knowledge-text";
      text.textContent = label(record);
      const button = documentRef.createElement("button");
      button.className = "knowledge-delete-btn";
      button.type = "button";
      button.textContent = "删除";
      button.disabled = busy;
      button.setAttribute("aria-label", `删除教学知识：${text.textContent}`);
      button.addEventListener("click", () => void deleteKnowledgeRecord(record.id, text.textContent));
      item.append(text, button);
      elements.list.appendChild(item);
    }
  }

  async function resolveIdentity(force = false) {
    const result = await identityAuthority.resolve({
      token: storageRef?.getItem("token"),
      cachedUser: readCachedUser(storageRef),
      force,
    });
    return result.ok && isVerifiedIdentity(result.identity) ? result.identity : null;
  }

  async function request(path, init = {}, retried = false) {
    const token = getVerifiedToken(identity);
    if (!token) return null;
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    const response = await fetchImpl(`${API_BASE}${path}`, { ...init, headers });
    if (response?.status !== 401 || retried) return response;

    const expectedUserId = getVerifiedUserId(identity);
    identity = await resolveIdentity(true);
    if (!identity || getVerifiedUserId(identity) !== expectedUserId) return null;
    return request(path, init, true);
  }

  async function refreshKnowledgeList({ forceIdentity = false } = {}) {
    try {
      identity = await resolveIdentity(forceIdentity);
      if (!identity || disposed) throw new Error("invalid-identity");
      const response = await request("/v1/knowledge?limit=100");
      if (!response?.ok) throw new Error("knowledge-unavailable");
      const data = await response.json();
      records = Array.isArray(data?.items) ? data.items : [];
      readable = true;
      render();
      return { ok: true, count: records.length };
    } catch {
      records = [];
      readable = false;
      render();
      return { ok: false, reason: identity ? "remote-failure" : "invalid-identity" };
    }
  }

  async function dangerous({ confirmation, path, successMessage }) {
    if (!confirmImpl(confirmation)) return { ok: false, reason: "cancelled" };
    busy = true;
    render();
    setStatus("正在处理，请稍候。");
    try {
      identity = await resolveIdentity(true);
      if (!identity) throw new Error("invalid-identity");
      const response = await request(path, { method: "DELETE" });
      if (!response?.ok) throw new Error("delete-failed");
      syncChannel.notify(getVerifiedUserId(identity));
      await refreshKnowledgeList();
      setStatus(successMessage, "success");
      return { ok: true, removedCount: 1 };
    } catch {
      setStatus("暂时无法完成这个操作，请稍后再试。", "error");
      return { ok: false, reason: "operation-failed" };
    } finally {
      busy = false;
      render();
    }
  }

  function deleteKnowledgeRecord(recordId, recordLabel = "") {
    if (!records.some((record) => record.id === recordId)) return Promise.resolve({ ok: false, reason: "unknown-record" });
    return dangerous({
      confirmation: `确定删除“${recordLabel}”吗？删除后无法恢复。`,
      path: `/v1/knowledge/${encodeURIComponent(recordId)}`,
      successMessage: "这条教学知识已删除。",
    });
  }

  function bind() {
    elements.clearName?.addEventListener("click", () => void dangerous({
      confirmation: "确定让 Sunland AI 忘记你的名字吗？聊天记录不会受到影响。",
      path: "/v1/memory/name",
      successMessage: "Sunland AI 已忘记你的名字，聊天记录没有受到影响。",
    }));
    elements.clearKnowledge?.addEventListener("click", () => void dangerous({
      confirmation: "确定清除你教给 Sunland AI 的全部知识吗？系统内置知识和聊天记录不会受到影响。",
      path: "/v1/knowledge",
      successMessage: "你教给 Sunland AI 的知识已清除。",
    }));
    windowRef?.addEventListener?.("storage", onStorage);
    unsubscribe = syncChannel.subscribe((userId) => {
      if (userId === getVerifiedUserId(identity)) void refreshKnowledgeList();
    });
  }

  function onStorage(event) {
    if (event.key === "token") void refreshKnowledgeList({ forceIdentity: true });
  }

  async function initialize() {
    if (disposed) return { ok: false, reason: "disposed" };
    bind();
    return refreshKnowledgeList({ forceIdentity: true });
  }

  function dispose() {
    if (disposed) return false;
    disposed = true;
    unsubscribe();
    syncChannel.dispose();
    windowRef?.removeEventListener?.("storage", onStorage);
    identityAuthority.clear();
    return true;
  }

  return Object.freeze({
    initialize,
    refreshKnowledgeList,
    deleteKnowledgeRecord,
    dispose,
    getState: () => Object.freeze({
      identityValid: isVerifiedIdentity(identity),
      knowledgeReadable: readable,
      knowledgeCount: records.length,
      busy,
    }),
  });
}

if (typeof document !== "undefined") {
  void createSunlandDataControlsController().initialize();
}
