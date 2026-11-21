/**
 * Turn API error responses into stable, user-facing messages. The upstream body
 * may contain provider details, so never forward it to a toast, log or chat.
 * This module deliberately has no retry, quota or session side effects.
 */
const GENERIC_FAILURE = "请求失败，请稍后重试。";

function responseCode(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = typeof payload.error === "string"
    ? payload.error
    : typeof payload.code === "string"
      ? payload.code
      : typeof payload.error?.code === "string"
        ? payload.error.code
        : null;
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value)
    ? value
    : null;
}

export function classifyAiHttpError(status, code = null) {
  if (status === 429 && code === "LIMIT") {
    return { message: "今天的使用次数已达上限，请稍后再试。", showLimitModal: true };
  }
  if (status === 429) {
    return { message: "请求过于频繁或模型暂时限流，请稍后再试。", showLimitModal: false };
  }
  if (status === 409 && ["REQUEST_COMMITTED", "REQUEST_IN_FLIGHT", "REQUEST_CONFLICT"].includes(code)) {
    return { message: "当前请求已提交或正在处理，请先检查对话状态，避免重复发送。", showLimitModal: false };
  }
  if (["MODEL_OUTCOME_UNKNOWN", "QUOTA_COMMIT_UNKNOWN", "QUOTA_RELEASE_UNKNOWN"].includes(code)) {
    return { message: "请求处理结果暂时无法确认，请先刷新使用额度，避免重复发送。", showLimitModal: false };
  }
  if (status === 402) {
    return { message: "AI 上游服务额度暂时不可用，请稍后再试。", showLimitModal: false };
  }
  if (status === 502 || status === 503 || status === 504) {
    return { message: "AI 服务暂时不可用，请稍后再试。", showLimitModal: false };
  }
  if (status === 403 && code === "PRO_REQUIRED") {
    return { message: "当前模型需要 Pro 会员，请检查会员状态。", showLimitModal: false };
  }
  if (status === 401) {
    return { message: "登录状态已失效，请重新登录。", showLimitModal: false };
  }
  return { message: GENERIC_FAILURE, showLimitModal: false };
}

export async function classifyAiResponseError(response) {
  let code = null;
  try {
    if (/\bjson\b|\+json\b/i.test(response?.headers?.get("content-type") || "")) {
      // Response.clone avoids consuming the original error body. Ignore
      // malformed JSON and all free-text descriptions from the backend.
      code = responseCode(await response.clone().json());
    }
  } catch {
    // Error reporting must not itself break the request handler.
  }
  return classifyAiHttpError(response?.status, code);
}
