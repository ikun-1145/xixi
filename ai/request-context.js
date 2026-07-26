import {
  applyConversationSemanticContextUpdate,
  cloneConversationSemanticContext,
  isSupportedProviderId,
  sealConversationProvider,
} from "./providers/conversation.js";
import {
  getVerifiedUserId,
  isVerifiedIdentity,
} from "./verified-identity.js";

function cloneHistory(history) {
  return Array.isArray(history)
    ? history.map(message => ({ ...message }))
    : [];
}

function createRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `request-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Keeps every asynchronous generation bound to the conversation and user that
 * started it. Only one active request is accepted per conversation; requests
 * for different conversations remain independent.
 */
export class RequestCoordinator {
  constructor({
    getConversation,
    getCurrentUserId,
    onConversationChanged = () => {},
    createAbortController = () => new AbortController(),
    now = () => Date.now(),
  }) {
    this.getConversation = getConversation;
    this.getCurrentUserId = getCurrentUserId;
    this.onConversationChanged = onConversationChanged;
    this.createAbortController = createAbortController;
    this.now = now;
    this.requests = new Map();
    this.conversationRequests = new Map();
  }

  begin({
    conversation,
    identity,
    userId,
    providerId,
    model,
    deep,
    history,
    diagnostics = null,
  }) {
    if (
      !conversation ||
      conversation.id == null ||
      !isVerifiedIdentity(identity) ||
      getVerifiedUserId(identity) !== userId ||
      !isSupportedProviderId(providerId)
    ) {
      return null;
    }
    if (this.activeForConversation(conversation.id)) return null;

    const requestId = createRequestId();
    sealConversationProvider(conversation);
    const semanticContext =
      providerId === "sunland"
        ? cloneConversationSemanticContext(conversation)
        : null;
    const context = {
      requestId,
      conversationId: conversation.id,
      providerId,
      userId,
      identity,
      model,
      deep: Boolean(deep),
      history: cloneHistory(history),
      semanticContext,
      semanticContextVersion:
        semanticContext?.version ?? null,
      diagnostics,
      controller: this.createAbortController(),
      startedAt: this.now(),
      status: "active",
    };

    this.requests.set(requestId, context);
    this.conversationRequests.set(conversation.id, requestId);
    return context;
  }

  get size() {
    return this.requests.size;
  }

  activeForConversation(conversationId) {
    const requestId = this.conversationRequests.get(conversationId);
    const context = requestId ? this.requests.get(requestId) : null;
    return context?.status === "active" ? context : null;
  }

  canWrite(context) {
    if (!context || context.status !== "active") return false;
    if (context.controller.signal.aborted) return false;
    if (this.requests.get(context.requestId) !== context) return false;
    if (this.getCurrentUserId() !== context.userId) return false;

    const conversation = this.getConversation(context.conversationId);
    if (!conversation) return false;
    if (conversation.provider !== context.providerId) return false;
    if (conversation.userId != null && conversation.userId !== context.userId) return false;
    return true;
  }

  target(context) {
    return this.canWrite(context)
      ? this.getConversation(context.conversationId)
      : null;
  }

  canCommitSemanticContext(context) {
    if (!this.canWrite(context) || context.providerId !== "sunland") {
      return false;
    }
    const conversation = this.getConversation(context.conversationId);
    const current = cloneConversationSemanticContext(conversation);
    return Boolean(
      current &&
      current.version === context.semanticContextVersion &&
      this.conversationRequests.get(context.conversationId) === context.requestId
    );
  }

  replaceHistory(context, nextHistory, { updatedAt = this.now() } = {}) {
    const conversation = this.target(context);
    if (!conversation) return false;

    context.history = cloneHistory(nextHistory);
    conversation.history = cloneHistory(nextHistory);
    conversation.updatedAt = updatedAt;
    sealConversationProvider(conversation);
    this.onConversationChanged(context, conversation);
    return true;
  }

  appendMessage(context, message, options) {
    return this.replaceHistory(
      context,
      [...context.history, { ...message }],
      options,
    );
  }

  appendMessageWithSemanticContext(
    context,
    message,
    semanticContextUpdate,
    { updatedAt = this.now() } = {},
  ) {
    const conversation = this.target(context);
    if (!conversation) {
      return { messageSaved: false, contextCommitted: false };
    }

    const nextHistory = [...context.history, { ...message }];
    context.history = cloneHistory(nextHistory);
    conversation.history = cloneHistory(nextHistory);
    conversation.updatedAt = updatedAt;
    sealConversationProvider(conversation);

    const contextCommitted = Boolean(
      this.canCommitSemanticContext(context) &&
      semanticContextUpdate &&
      typeof semanticContextUpdate === "object" &&
      applyConversationSemanticContextUpdate(
        conversation,
        semanticContextUpdate,
      )
    );
    if (contextCommitted) {
      context.semanticContext = cloneConversationSemanticContext(conversation);
      context.semanticContextVersion = context.semanticContext.version;
    }
    this.onConversationChanged(context, conversation);
    return { messageSaved: true, contextCommitted };
  }

  abort(context, reason = "user") {
    if (!context || this.requests.get(context.requestId) !== context) return false;
    if (context.status !== "active") return false;

    context.status = "aborted";
    context.abortReason = reason;
    context.controller.abort(reason);
    return true;
  }

  finish(context, status = "completed") {
    if (!context || this.requests.get(context.requestId) !== context) return false;

    if (context.status === "active") context.status = status;
    this.requests.delete(context.requestId);
    if (this.conversationRequests.get(context.conversationId) === context.requestId) {
      this.conversationRequests.delete(context.conversationId);
    }
    return true;
  }
}

export function isRequestVisibleForConversation(
  context,
  currentConversationId,
  bubbleConnected = true,
) {
  return Boolean(
    context &&
    context.conversationId === currentConversationId &&
    bubbleConnected,
  );
}

export function applyRequestTitle({
  conversations,
  conversationId,
  userId,
  requestId,
  title,
  fallbackTitle = "新对话",
  updatedAt = Date.now(),
}) {
  const conversation = conversations.find(item => item.id === conversationId);
  if (
    !conversation ||
    conversation.userId !== userId ||
    conversation._autoTitleRequestId !== requestId
  ) return false;

  conversation.title = title || fallbackTitle || "新对话";
  conversation._autoTitle = false;
  delete conversation._autoTitleRequestId;
  conversation.updatedAt = updatedAt;
  return true;
}

export { cloneHistory as cloneRequestHistory };
