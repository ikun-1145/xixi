const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const SAFE_VALUES = {
  attempt: value => Number.isInteger(value) && value >= 1 && value <= 4,
  provider_status: value => Number.isInteger(value) && value >= 100 && value <= 599,
  error_category: value => ["http_status", "stream_failed", "network_or_timeout", "none"].includes(value),
  model_key: value => ["sonnet", "grok"].includes(value),
  dropped_span_count: value => Number.isInteger(value) && value >= 0 && value <= 1000,
  report_source: value => ["server", "client"].includes(value),
  trust_level: value => ["server_observed", "client_reported"].includes(value),
};
export const MAX_SPANS_PER_TRACE = 32;

function randomHex(bytes) {
  const values = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(values);
  return Array.from(values, value => value.toString(16).padStart(2, "0")).join("");
}

export function generateTraceId() {
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = randomHex(16);
    if (!/^0+$/.test(id)) return id;
  }
  throw new Error("Secure trace ID unavailable");
}

export function generateSpanId() {
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = randomHex(8);
    if (!/^0+$/.test(id)) return id;
  }
  throw new Error("Secure span ID unavailable");
}

export function parseTraceparent(value) {
  const match = typeof value === "string" ? TRACEPARENT.exec(value) : null;
  if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2])) return null;
  return { traceId: match[1], spanId: match[2], flags: match[3] };
}

export function validateTraceparent(value) {
  return parseTraceparent(value) !== null;
}

export function createTraceparent(traceId, spanId, flags = "01") {
  if (!TRACE_ID.test(traceId) || /^0+$/.test(traceId) || !SPAN_ID.test(spanId) ||
      /^0+$/.test(spanId) || !/^[0-9a-f]{2}$/.test(flags)) return null;
  return `00-${traceId}-${spanId}-${flags}`;
}

export function redactTelemetry(value, maxBytes = 1024) {
  const safe = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return safe;
  for (const [key, item] of Object.entries(value)) {
    if (!Object.hasOwn(SAFE_VALUES, key) || !SAFE_VALUES[key](item)) continue;
    const next = { ...safe, [key]: item };
    if (new TextEncoder().encode(JSON.stringify(next)).length > maxBytes) break;
    safe[key] = item;
  }
  return safe;
}

export function createSpan(traceId, parentSpanId, name) {
  return {
    trace_id: traceId,
    span_id: generateSpanId(),
    parent_span_id: parentSpanId,
    service: "comment-copilot",
    name,
    started_at: new Date().toISOString(),
    startedTick: performance.now(),
  };
}

export function finishSpan(span, status = "OK", errorCode = null, metadata = {}) {
  const { startedTick, ...stored } = span;
  return {
    ...stored,
    duration_ms: Math.max(0, Math.round(performance.now() - startedTick)),
    status,
    error_code: errorCode,
    service_version: "UNVERIFIED",
    metadata: redactTelemetry({ report_source: "server", trust_level: "server_observed", ...metadata }),
    expires_at: new Date(Date.now() + (status === "OK" ? 7 : 30) * 86400000).toISOString(),
  };
}

export function publicProviderError(traceId) {
  return { error: "AI 服务暂时不可用，请稍后再试", code: "provider_error", trace_id: traceId };
}

export async function recordTrace(admin, trace) {
  try {
    const { error } = await admin.from("observability_traces").upsert(trace, {
      onConflict: "trace_id", ignoreDuplicates: true,
    });
    if (error) {
      console.warn("[OBSERVABILITY_WRITE_FAILED] trace", trace.trace_id);
      return false;
    }
    return true;
  } catch {
    console.warn("[OBSERVABILITY_WRITE_FAILED] trace", trace.trace_id);
    return false;
  }
}

export async function recordSpans(admin, spans) {
  if (!spans.length) return true;
  try {
    const { error } = await admin.from("observability_spans").upsert(spans.slice(0, MAX_SPANS_PER_TRACE), {
      onConflict: "trace_id,span_id", ignoreDuplicates: true,
    });
    if (error) {
      console.warn("[OBSERVABILITY_WRITE_FAILED] spans", spans[0].trace_id);
      return false;
    }
    return true;
  } catch {
    console.warn("[OBSERVABILITY_WRITE_FAILED] spans", spans[0].trace_id);
    return false;
  }
}
