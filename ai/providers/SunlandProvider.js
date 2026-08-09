import { AIProvider } from "./AIProvider.js";
import { getVerifiedToken, getVerifiedUserId } from "../verified-identity.js";
import { SUNLAND_LOGIN_STATE_MESSAGE } from "../user-identity.js";
import { answerFurryEventQuestion } from "../furry-events.js";
import { ensureSunlandLegacyMigration } from "../sunland-legacy-migration.js";

const DEFAULT_BASE_URL = "https://ai-core.sunland.dev";

function newTurnId() {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `turn-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function remoteErrorMessage(status) {
  if (status === 429) return "请求有点频繁，请稍后再试。";
  if (status === 503) return "Sunland AI 的记忆服务暂时不可用，请稍后重试。";
  return "Sunland AI 暂时无法回答，请稍后重试。";
}

/**
 * Remote-only Sunland provider. Symbolic Core runs inside the authenticated
 * Worker; no engine, knowledge graph or semantic Context executes in the
 * browser. The injected requester owns the app-token refresh-once policy.
 */
export class SunlandProvider extends AIProvider {
  constructor({
    sendRequest = (path, init, auth) => {
      const headers = new Headers(init?.headers);
      if (auth?.token) headers.set("authorization", `Bearer ${auth.token}`);
      return fetch(`${DEFAULT_BASE_URL}${path}`, { ...init, headers });
    },
    storage = globalThis.localStorage,
  } = {}) {
    super();
    this.id = "sunland";
    this.displayName = "Sunland AI";
    this.requiresPro = false;
    this.sendRequest = sendRequest;
    this.storage = storage;
  }

  async send({
    conversation,
    messages,
    onDelta,
    identity,
    furryContext,
    furryContextActive = false,
    turnId,
    observationMode = "off",
    signal,
  }) {
    const userId = getVerifiedUserId(identity);
    const token = getVerifiedToken(identity);
    if (!userId || !token || userId !== conversation?.userId) {
      onDelta?.(SUNLAND_LOGIN_STATE_MESSAGE);
      return { content: SUNLAND_LOGIN_STATE_MESSAGE, blocked: true };
    }
    const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
    const input = lastUserMessage?.content?.trim() ?? "";
    if (!input || signal?.aborted) return { content: "", blocked: true };

    if (furryContextActive && furryContext) {
      const content = answerFurryEventQuestion(input, furryContext);
      onDelta?.(content);
      return { content };
    }

    const migration = await ensureSunlandLegacyMigration({
      identity,
      storage: this.storage,
      sendRequest: this.sendRequest,
      signal,
    });
    if (signal?.aborted) return { content: "", blocked: true };

    const response = await this.sendRequest("/v1/turns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversationId: String(conversation.id),
        turnId: String(turnId || newTurnId()),
        input,
        observationMode: observationMode === "summary" ? "summary" : "off",
      }),
      signal,
    }, { token, userId });
    if (!response?.ok) {
      const content = remoteErrorMessage(response?.status);
      onDelta?.(content);
      return { content, blocked: true };
    }
    const payload = await response.json();
    if (typeof payload?.response !== "string") {
      const content = remoteErrorMessage(502);
      onDelta?.(content);
      return { content, blocked: true };
    }
    onDelta?.(payload.response);
    return {
      content: payload.response,
      ...(payload.observationSummary ? { observationSummary: payload.observationSummary } : {}),
      ...(!migration.ok && migration.reason === "invalid-local-state"
        ? { migrationWarning: "检测到损坏的旧 Sunland 数据，已保留在本机以便恢复。" }
        : {}),
    };
  }
}
