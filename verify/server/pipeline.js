import { VERIFY_LIMITS } from "./constants.js";
import { VerifyError } from "./errors.js";
import { cleanText } from "./json-utils.js";
import { callDeepSeek } from "./model-adapter.js";
import { extractClaims, normalizeClaims } from "./claim-extractor.js";
import { createSearchProvider, deduplicateResults } from "./search-provider.js";
import { attachSourceEvaluation } from "./source-evaluator.js";
import { judgeEvidence } from "./evidence-judge.js";
import { calculateCredibilityScore, calculateOverallScore, scoreLabel } from "./credibility-score.js";
import { detectAIContent } from "./ai-detector.js";
import { analyzeMedia } from "./image-analyzer.js";

function validateText(content) {
  if (typeof content !== "string") {
    throw new VerifyError("CONTENT_REQUIRED", "请输入需要核验的文字内容。", 400);
  }
  const value = String(content ?? "").trim();
  if (!value) throw new VerifyError("CONTENT_REQUIRED", "请输入需要核验的内容。", 400);
  if (value.length > VERIFY_LIMITS.maxTextChars) {
    throw new VerifyError("CONTENT_TOO_LONG", `文字内容不能超过 ${VERIFY_LIMITS.maxTextChars} 个字符。`, 413);
  }
  return value;
}

function unavailableImageReport(imageInput) {
  return {
    success: true,
    inputType: "image",
    overallScore: null,
    scoreLabel: "不足以判断",
    outcome: "insufficient_input",
    summary: "图片 OCR 未提取到足够文字，不足以判断其中的事实内容。",
    claims: [],
    sources: [],
    searches: [],
    process: {
      claimsExtracted: 0,
      queriesRun: 0,
      pagesFound: 0,
      duplicatesRemoved: 0,
      provider: null,
    },
    inputMetadata: imageInput.metadata,
    aiDetection: {
      status: "unknown",
      methods: [],
      limitations: ["当前版本尚未接入可靠的 AI 生成检测器。"],
    },
    limitations: imageInput.limitations,
  };
}

function emptyClaimsReport(inputType, inputMetadata, limitations = []) {
  return {
    success: true,
    inputType,
    overallScore: null,
    scoreLabel: "无可核验声明",
    outcome: "no_claims",
    summary: "没有发现适合进行事实核验的客观声明。",
    claims: [],
    sources: [],
    searches: [],
    process: {
      claimsExtracted: 0,
      queriesRun: 0,
      pagesFound: 0,
      duplicatesRemoved: 0,
      provider: null,
    },
    ...(inputMetadata ? { inputMetadata } : {}),
    aiDetection: {
      status: "unknown",
      methods: [],
      limitations: ["当前版本尚未接入可靠的 AI 生成检测器。"],
    },
    limitations,
  };
}

function deterministicSummary(score, claims) {
  const label = scoreLabel(score);
  const hasLimitations = claims.some((claim) => claim.limitations.length > 0);
  return `公开证据的综合评估为“${label}”。${hasLimitations ? "部分结论仍受现有证据范围限制。" : "请结合各项证据和来源等级阅读。"}`;
}

async function prepareInput({ inputType, content, file, ocrText, ocrStatus }) {
  if (!["text", "image"].includes(inputType)) {
    throw new VerifyError("INPUT_TYPE_INVALID", "仅支持文字或图片核验。", 400);
  }

  if (inputType === "image") {
    const imageInput = await analyzeMedia("image", { file, ocrText, ocrStatus });
    return {
      inputType,
      normalizedContent: imageInput.content,
      inputMetadata: imageInput.metadata,
      initialLimitations: imageInput.limitations,
      insufficientReport: imageInput.content.length < 3 ? unavailableImageReport(imageInput) : null,
    };
  }

  return {
    inputType,
    normalizedContent: validateText(content),
    inputMetadata: undefined,
    initialLimitations: [],
    insufficientReport: null,
  };
}

function createModelUsageState() {
  return { value: null };
}

function usagePayload(usageState) {
  return usageState?.value ? { usage: usageState.value } : {};
}

function createModelCaller({ env, authorization, fetchImpl, signal, usageState }) {
  return (messages, options) => callDeepSeek({
    env,
    authorization,
    messages,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    fetchImpl,
    signal,
    onUsage(usage) {
      if (usageState) usageState.value = usage;
    },
  });
}

async function runSearches(claims, provider) {
  const tasks = [];
  for (let queryIndex = 0; queryIndex < VERIFY_LIMITS.maxQueriesPerClaim; queryIndex += 1) {
    for (const claim of claims) {
      const query = claim.search_queries[queryIndex];
      if (!query) continue;
      if (tasks.length >= VERIFY_LIMITS.maxTotalSearches) break;
      tasks.push({ claimId: claim.id, query });
    }
    if (tasks.length >= VERIFY_LIMITS.maxTotalSearches) break;
  }

  const settled = await Promise.allSettled(tasks.map((task) => provider.search(task.query, {
    limit: VERIFY_LIMITS.maxResultsPerQuery,
    timeoutMs: VERIFY_LIMITS.searchTimeoutMs,
  })));
  const searches = [];
  const rawByClaim = new Map(claims.map((claim) => [claim.id, []]));
  let successfulSearches = 0;

  settled.forEach((outcome, index) => {
    const task = tasks[index];
    if (outcome.status === "fulfilled") {
      successfulSearches += 1;
      rawByClaim.get(task.claimId).push(...outcome.value);
      searches.push({
        claimId: task.claimId,
        query: task.query,
        status: "success",
        resultCount: outcome.value.length,
      });
    } else {
      const error = outcome.reason instanceof VerifyError
        ? outcome.reason
        : new VerifyError("SEARCH_PROVIDER_ERROR", "联网搜索服务请求失败。", 502);
      searches.push({
        claimId: task.claimId,
        query: task.query,
        status: "failed",
        resultCount: 0,
        errorCode: error.code,
      });
    }
  });

  if (tasks.length > 0 && successfulSearches === 0) {
    const providerError = settled.find((outcome) => (
      outcome.status === "rejected" && outcome.reason instanceof VerifyError
    ));
    if (providerError) throw providerError.reason;
    throw new VerifyError("SEARCH_UNAVAILABLE", "联网搜索暂不可用，请稍后重试。", 503);
  }

  const resultsByClaim = new Map();
  let duplicatesRemoved = 0;
  for (const claim of claims) {
    const deduplicated = deduplicateResults(rawByClaim.get(claim.id));
    duplicatesRemoved += deduplicated.duplicatesRemoved;
    resultsByClaim.set(claim.id, attachSourceEvaluation(
      deduplicated.results.slice(0, VERIFY_LIMITS.maxEvidenceResults),
      { subject: claim.subject },
    ));
  }

  return { searches, resultsByClaim, duplicatesRemoved };
}

async function completeVerification({
  prepared,
  claims,
  locale,
  env,
  authorization,
  fetchImpl,
  signal,
  usageState = createModelUsageState(),
}) {
  const model = createModelCaller({ env, authorization, fetchImpl, signal, usageState });
  const searchProvider = createSearchProvider(env, fetchImpl);
  const searchRun = await runSearches(claims, searchProvider);
  const normalizedLocale = ["zh", "zh-Hant", "en", "ja", "ko", "es"].includes(locale) ? locale : "zh";
  const judgment = await judgeEvidence(claims, searchRun.resultsByClaim, model, normalizedLocale);
  const scoredClaims = judgment.claims.map((claim) => {
    const scored = calculateCredibilityScore(claim);
    return { ...claim, credibilityScore: scored.score, scoreLabel: scored.label };
  });
  const overallScore = calculateOverallScore(scoredClaims);
  const allSourcesRun = deduplicateResults(
    [...searchRun.resultsByClaim.values()].flat(),
  );
  const allSources = allSourcesRun.results;
  const failedSearches = searchRun.searches.filter((item) => item.status === "failed").length;
  const noEvidenceClaims = scoredClaims.filter((claim) => (
    claim.supporting_evidence.length === 0 && claim.contradicting_evidence.length === 0
  )).length;
  const limitations = [
    ...prepared.initialLimitations,
    "当前版本仅分析搜索结果的标题与摘要，未抓取网页正文。",
  ];
  if (failedSearches) limitations.push(`${failedSearches} 次搜索请求失败，其余结果仍已继续分析。`);
  if (noEvidenceClaims) limitations.push(`${noEvidenceClaims} 个声明未找到可直接引用的支持或反对证据；搜不到不代表虚假。`);

  return {
    success: true,
    inputType: prepared.inputType,
    overallScore,
    scoreLabel: scoreLabel(overallScore),
    outcome: "verified",
    summary: cleanText(judgment.summary, 1_500) || deterministicSummary(overallScore, scoredClaims),
    claims: scoredClaims,
    sources: allSources,
    searches: searchRun.searches,
    ...usagePayload(usageState),
    process: {
      claimsExtracted: claims.length,
      queriesRun: searchRun.searches.length,
      pagesFound: allSources.length,
      duplicatesRemoved: searchRun.duplicatesRemoved + allSourcesRun.duplicatesRemoved,
      provider: searchProvider.name,
    },
    ...(prepared.inputMetadata ? { inputMetadata: prepared.inputMetadata } : {}),
    aiDetection: await detectAIContent({
      inputType: prepared.inputType,
      content: prepared.normalizedContent,
      metadata: prepared.inputMetadata,
    }),
    limitations,
  };
}

export async function extractVerificationClaims({
  inputType,
  content,
  file,
  ocrText,
  ocrStatus,
  env = {},
  authorization,
  fetchImpl = fetch,
  signal,
}) {
  const prepared = await prepareInput({ inputType, content, file, ocrText, ocrStatus });
  if (prepared.insufficientReport) return prepared.insufficientReport;

  const usageState = createModelUsageState();
  const model = createModelCaller({ env, authorization, fetchImpl, signal, usageState });
  const claims = await extractClaims(prepared.normalizedContent, model);
  if (claims.length === 0) {
    return {
      ...emptyClaimsReport(inputType, prepared.inputMetadata, prepared.initialLimitations),
      ...usagePayload(usageState),
    };
  }

  return {
    success: true,
    stage: "claims_extracted",
    inputType,
    claims,
    ...usagePayload(usageState),
  };
}

export async function verifyExtractedClaims({
  inputType,
  content,
  file,
  ocrText,
  ocrStatus,
  claims,
  locale = "zh",
  env = {},
  authorization,
  fetchImpl = fetch,
  signal,
}) {
  const prepared = await prepareInput({ inputType, content, file, ocrText, ocrStatus });
  if (prepared.insufficientReport) return prepared.insufficientReport;

  const normalizedClaims = normalizeClaims({ claims });
  if (normalizedClaims.length === 0) {
    throw new VerifyError("CLAIMS_REQUIRED", "没有可用于证据搜索的声明。", 400);
  }

  return completeVerification({
    prepared,
    claims: normalizedClaims,
    locale,
    env,
    authorization,
    fetchImpl,
    signal,
  });
}

export async function verifyInput({
  inputType,
  content,
  file,
  ocrText,
  ocrStatus,
  locale = "zh",
  env = {},
  authorization,
  fetchImpl = fetch,
  signal,
}) {
  const prepared = await prepareInput({ inputType, content, file, ocrText, ocrStatus });
  if (prepared.insufficientReport) return prepared.insufficientReport;

  const usageState = createModelUsageState();
  const model = createModelCaller({ env, authorization, fetchImpl, signal, usageState });
  const claims = await extractClaims(prepared.normalizedContent, model);
  if (claims.length === 0) {
    return {
      ...emptyClaimsReport(inputType, prepared.inputMetadata, prepared.initialLimitations),
      ...usagePayload(usageState),
    };
  }

  return completeVerification({
    prepared,
    claims,
    locale,
    env,
    authorization,
    fetchImpl,
    signal,
    usageState,
  });
}
