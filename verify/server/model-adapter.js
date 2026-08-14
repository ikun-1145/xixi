import { VERIFY_LIMITS } from "./constants.js";
import { VerifyError } from "./errors.js";

const DEFAULT_GATEWAY_URL = "https://api.sunland.dev/";

function parseSseEvent(rawEvent) {
  let result = "";
  for (const line of rawEvent.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const payload = JSON.parse(data);
      const delta = payload?.choices?.[0]?.delta?.content;
      const content = delta ?? payload?.choices?.[0]?.message?.content;
      if (typeof content === "string") result += content;
    } catch {
      // 非 JSON 的 SSE 心跳或诊断行不属于模型正文。
    }
  }
  return result;
}

export async function readGatewayResponse(response, maxBytes = VERIFY_LIMITS.maxModelResponseBytes) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new VerifyError("MODEL_RESPONSE_TOO_LARGE", "模型响应超出安全限制。", 502);
    }
    if (contentType.includes("application/json")) {
      try {
        const payload = JSON.parse(text);
        return payload?.choices?.[0]?.message?.content ?? payload?.content ?? text;
      } catch {
        return text;
      }
    }
    return text;
  }

  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let output = "";
  let receivedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        throw new VerifyError("MODEL_RESPONSE_TOO_LARGE", "模型响应超出安全限制。", 502);
      }
      buffered += decoder.decode(value, { stream: true });
      const events = buffered.split(/\r?\n\r?\n/);
      buffered = events.pop() || "";
      for (const event of events) output += parseSseEvent(event);
    }
    buffered += decoder.decode();
    if (buffered) output += parseSseEvent(buffered);
    return output.trim();
  } finally {
    reader.releaseLock();
  }
}

function gatewayFetch(env, request, fetchImpl) {
  if (env?.AI_GATEWAY && typeof env.AI_GATEWAY.fetch === "function") {
    return env.AI_GATEWAY.fetch(request);
  }
  return fetchImpl(request);
}

export async function callDeepSeek({
  env,
  authorization,
  messages,
  maxTokens = 2_500,
  temperature = 0.1,
  fetchImpl = fetch,
  signal,
}) {
  if (!/^Bearer\s+\S{10,4096}$/i.test(authorization || "")) {
    throw new VerifyError("AUTH_REQUIRED", "请先登录霜蓝账号后再开始核验。", 401);
  }

  const timeoutSignal = AbortSignal.timeout(VERIFY_LIMITS.modelTimeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const request = new Request(DEFAULT_GATEWAY_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization,
    },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      deep: false,
      stream: true,
      temperature,
      max_tokens: maxTokens,
      messages,
    }),
    signal: combinedSignal,
  });

  let response;
  try {
    response = await gatewayFetch(env, request, fetchImpl);
  } catch (error) {
    if (error?.name === "AbortError" || error?.name === "TimeoutError") {
      throw new VerifyError("MODEL_TIMEOUT", "DeepSeek 分析超时，请稍后重试。", 504);
    }
    throw new VerifyError("MODEL_UNAVAILABLE", "DeepSeek 分析服务暂时不可用。", 502);
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new VerifyError("AUTH_REQUIRED", "登录状态已失效，请重新登录。", 401);
    }
    if (response.status === 429) {
      throw new VerifyError("RATE_LIMITED", "今日使用次数已达上限或请求过于频繁。", 429);
    }
    throw new VerifyError("MODEL_UNAVAILABLE", "DeepSeek 分析服务暂时不可用。", 502);
  }

  const content = await readGatewayResponse(response);
  if (!content) throw new VerifyError("MODEL_EMPTY_RESPONSE", "DeepSeek 未返回可用结果。", 502);
  return content;
}

