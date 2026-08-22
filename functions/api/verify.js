import { VERIFY_LIMITS } from "../../verify/server/constants.js";
import { VerifyError, toPublicError } from "../../verify/server/errors.js";
import { createSearchProvider } from "../../verify/server/search-provider.js";
import {
  extractVerificationClaims,
  verifyExtractedClaims,
  verifyInput,
} from "../../verify/server/pipeline.js";

const JSON_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

async function enforceOptionalRateLimit(context) {
  const limiter = context.env?.VERIFY_RATE_LIMITER;
  if (!limiter || typeof limiter.limit !== "function") return;
  const clientIp = context.request.headers.get("cf-connecting-ip") || "unknown";
  const outcome = await limiter.limit({ key: clientIp });
  if (!outcome?.success) {
    throw new VerifyError("RATE_LIMITED", "请求过于频繁，请稍后再试。", 429);
  }
}

async function parseInput(request) {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > VERIFY_LIMITS.maxImageBytes + 200_000) {
    throw new VerifyError("REQUEST_TOO_LARGE", "请求内容超出大小限制。", 413);
  }

  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    let payload;
    try {
      payload = await request.json();
    } catch {
      throw new VerifyError("INVALID_JSON", "请求 JSON 格式无效。", 400);
    }
    return {
      inputType: payload?.type,
      content: payload?.content,
      locale: payload?.locale,
      stage: payload?.stage,
      claims: payload?.claims,
    };
  }

  if (contentType.includes("multipart/form-data")) {
    let form;
    try {
      form = await request.formData();
    } catch {
      throw new VerifyError("INVALID_FORM", "图片上传表单无法解析。", 400);
    }
    let claims;
    const serializedClaims = form.get("claims");
    if (typeof serializedClaims === "string" && serializedClaims) {
      try {
        claims = JSON.parse(serializedClaims);
      } catch {
        throw new VerifyError("CLAIMS_INVALID", "声明数据格式无效。", 400);
      }
    }
    return {
      inputType: form.get("type"),
      file: form.get("file"),
      ocrText: form.get("ocrText"),
      ocrStatus: form.get("ocrStatus"),
      locale: form.get("locale"),
      stage: form.get("stage"),
      claims,
    };
  }
  throw new VerifyError("CONTENT_TYPE_INVALID", "请使用 JSON 或 multipart/form-data 提交。", 415);
}

export async function onRequestGet(context) {
  let search = { available: true, provider: null };
  try {
    search.provider = createSearchProvider(context.env).name;
  } catch (error) {
    search = {
      available: false,
      provider: null,
      message: error instanceof VerifyError ? error.message : "联网搜索暂不可用。",
    };
  }
  return json({
    success: true,
    capabilities: {
      inputTypes: ["text", "image"],
      video: false,
      reverseImageSearch: false,
      aiDetection: false,
      ocr: "browser",
      vision: true,
      search,
    },
    limits: {
      maxTextChars: VERIFY_LIMITS.maxTextChars,
      maxImageBytes: VERIFY_LIMITS.maxImageBytes,
      maxClaims: VERIFY_LIMITS.maxClaims,
      maxSearches: VERIFY_LIMITS.maxTotalSearches,
    },
  });
}

export async function onRequestPost(context) {
  try {
    await enforceOptionalRateLimit(context);
    const input = await parseInput(context.request);
    const authorization = context.request.headers.get("authorization") || "";
    if (!authorization) throw new VerifyError("AUTH_REQUIRED", "请先登录霜蓝账号后再开始核验。", 401);
    const signal = AbortSignal.timeout(VERIFY_LIMITS.pipelineTimeoutMs);
    const pipelineInput = {
      ...input,
      env: context.env,
      authorization,
      signal,
    };
    let result;
    if (input.stage === "extract") {
      result = await extractVerificationClaims(pipelineInput);
    } else if (input.stage === "judge") {
      result = await verifyExtractedClaims(pipelineInput);
    } else if (input.stage == null || input.stage === "") {
      // 保留原有单请求契约，现有客户端不会因分阶段浏览器流程而失效。
      result = await verifyInput(pipelineInput);
    } else {
      throw new VerifyError("VERIFY_STAGE_INVALID", "核验阶段无效。", 400);
    }
    return json(result);
  } catch (error) {
    const publicError = toPublicError(error);
    return json(publicError.body, publicError.status);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      allow: "GET, POST, OPTIONS",
      "cache-control": "no-store",
    },
  });
}
