export const VERIFY_LIMITS = Object.freeze({
  maxTextChars: 12_000,
  maxOcrChars: 12_000,
  maxImageBytes: 5 * 1024 * 1024,
  maxClaims: 5,
  maxQueriesPerClaim: 3,
  maxTotalSearches: 8,
  maxResultsPerQuery: 5,
  // Evidence Judge 保留足够的独立来源，同时限制模型请求体与 Pages CPU 开销。
  maxEvidenceResults: 8,
  searchTimeoutMs: 6_000,
  modelTimeoutMs: 40_000,
  pipelineTimeoutMs: 90_000,
  maxModelResponseBytes: 160_000,
});

export const ALLOWED_IMAGE_MIME_TYPES = Object.freeze([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export const VERDICTS = Object.freeze([
  "true",
  "likely_true",
  "uncertain",
  "likely_false",
  "false",
]);

export const AI_DETECTION_UNAVAILABLE = Object.freeze({
  status: "unknown",
  methods: [],
  limitations: ["当前版本尚未接入可靠的 AI 生成检测器。"],
});
