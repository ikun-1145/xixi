import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createTraceContext, createTraceparent, observeTraceResponse, parseTraceparent,
  responseTraceId, traceparentFor, validateTraceparent,
} from "../ai/trace-context.js";
import {
  createSpan, finishSpan, parseTraceparent as parseEdgeTraceparent,
  publicProviderError, recordSpans, recordTrace, redactTelemetry,
} from "../supabase/functions/comment-copilot/trace.js";

test("browser and Edge agree on strict W3C trace context", () => {
  const context = createTraceContext();
  assert.match(context.traceId, /^[0-9a-f]{32}$/);
  assert.match(context.spanId, /^[0-9a-f]{16}$/);
  assert.deepEqual(parseTraceparent(context.traceparent), {
    traceId: context.traceId, spanId: context.spanId, flags: "01",
  });
  assert.deepEqual(parseEdgeTraceparent(context.traceparent), parseTraceparent(context.traceparent));
  assert.equal(validateTraceparent(context.traceparent), true);
  assert.equal(createTraceparent(context.traceId, context.spanId), context.traceparent);
  for (const invalid of [
    "00-00000000000000000000000000000000-1111111111111111-01",
    "00-11111111111111111111111111111111-0000000000000000-01",
    "01-11111111111111111111111111111111-1111111111111111-01",
    "00-11111111111111111111111111111111-1111111111111111-zz",
    "00-11111111111111111111111111111111-1111111111111111-01-extra",
    "00-1111111111111111111111111111111-1111111111111111-01",
    "00-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-1111111111111111-01",
  ]) {
    assert.equal(validateTraceparent(invalid), false, invalid);
    assert.equal(parseEdgeTraceparent(invalid), null, invalid);
  }
});

test("server response trace ID wins over the client ID only when valid", () => {
  const client = createTraceContext();
  const server = createTraceContext();
  assert.equal(responseTraceId(new Response(null, { headers: { "X-Sunland-Trace-Id": server.traceId } }), client.traceId), server.traceId);
  assert.equal(responseTraceId(new Response(null, { headers: { "X-Sunland-Trace-Id": "invalid" } }), client.traceId), client.traceId);
  assert.equal(responseTraceId(new Response(), client.traceId), client.traceId);
});

test("browser waits for an exposed server trace ID before sending a CORS-sensitive header", () => {
  const client = createTraceContext();
  const server = createTraceContext();
  const service = `test-${client.traceId}`;
  assert.equal(traceparentFor(service, client), null);
  assert.equal(observeTraceResponse(service, new Response(), client.traceId), null);
  assert.equal(traceparentFor(service, client), null);
  assert.equal(observeTraceResponse(service, new Response(null, {
    headers: { "X-Sunland-Trace-Id": server.traceId },
  }), client.traceId), server.traceId);
  assert.equal(traceparentFor(service, client), client.traceparent);
});

test("telemetry uses a bounded allowlist and provider failures stay public-safe", () => {
  const sentinel = "private-prompt-jwt-email-provider-body-image-url";
  const metadata = redactTelemetry({
    attempt: 2, model_key: "sonnet", provider_status: 502,
    prompt: sentinel, response: sentinel, message: sentinel, content: sentinel,
    Authorization: sentinel, Cookie: sentinel, JWT: sentinel, email: sentinel,
    image_url: sentinel, provider_body: sentinel, stack: sentinel,
    error_category: sentinel,
  });
  assert.deepEqual(metadata, { attempt: 2, model_key: "sonnet", provider_status: 502 });
  assert.ok(new TextEncoder().encode(JSON.stringify(metadata)).length <= 1024);
  assert.deepEqual(redactTelemetry({ model_key: "x".repeat(1000) }), {});
  assert.ok(new TextEncoder().encode(JSON.stringify(redactTelemetry({ attempt: 1 }, 2))).length <= 2);
  assert.deepEqual(publicProviderError("a".repeat(32)), {
    error: "AI 服务暂时不可用，请稍后再试", code: "provider_error", trace_id: "a".repeat(32),
  });
  assert.doesNotMatch(JSON.stringify(publicProviderError("a".repeat(32))), /provider_status|detail|model|private/i);
});

test("Edge spans keep remote parents and integer durations without user content", () => {
  const traceId = createTraceContext().traceId;
  const span = createSpan(traceId, "f".repeat(16), "AI_UPSTREAM");
  const row = finishSpan(span, "ERROR", "AI_UPSTREAM_ERROR", {
    prompt: "private prompt", provider_status: 502, error_category: "stream_failed",
  });
  assert.equal(row.parent_span_id, "f".repeat(16));
  assert.equal(row.service, "comment-copilot");
  assert.ok(Number.isInteger(row.duration_ms) && row.duration_ms >= 0);
  assert.equal(row.error_code, "AI_UPSTREAM_ERROR");
  assert.deepEqual(row.metadata, {
    report_source: "server", trust_level: "server_observed",
    provider_status: 502, error_category: "stream_failed",
  });
});

test("trace and batch spans fail independently and never throw into business flow", async () => {
  const captured = [];
  const admin = {
    from(table) {
      return {
        async upsert(rows, options) {
          captured.push({ table, rows, options });
          if (table === "observability_spans") throw new Error("database down; secret body");
          return { error: null };
        },
      };
    },
  };
  const traceId = createTraceContext().traceId;
  const spans = Array.from({ length: 40 }, () => finishSpan(createSpan(traceId, null, "AI_UPSTREAM")));
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    assert.equal(await recordSpans(admin, spans), false);
    assert.equal(await recordTrace(admin, { trace_id: traceId }), true);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(captured[0].rows.length, 32);
  assert.equal(captured[1].table, "observability_traces");
  assert.equal(captured[0].options.ignoreDuplicates, true);
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(JSON.stringify(warnings), /database down|secret body/);
});

test("web paths propagate headers and copilot source never reads or returns raw provider failures", () => {
  const app = readFileSync(new URL("../ai/app.js", import.meta.url), "utf8");
  const provider = readFileSync(new URL("../ai/providers/SunlandProvider.js", import.meta.url), "utf8");
  const copilot = readFileSync(new URL("../copilot.html", import.meta.url), "utf8");
  const edge = readFileSync(new URL("../supabase/functions/comment-copilot/index.ts", import.meta.url), "utf8");
  assert.match(app, /requestContext\.traceContext = createTraceContext\(\)/);
  assert.match(app, /requestContext\.controller\.signal, requestContext\.traceContext/);
  assert.match(provider, /headers\.set\("traceparent", traceparent\)/);
  assert.match(copilot, /traceparentFor\('comment-copilot', traceContext\)/);
  assert.match(copilot, /callFn\(body, true, traceContext\)/);
  assert.match(edge, /Access-Control-Expose-Headers": "X-Sunland-Trace-Id"/);
  assert.doesNotMatch(edge, /r\.err\b|res\.text\(\)|JSON\.stringify\(e\)\.slice\(/);
  assert.match(edge, /publicProviderError\(trace\.traceId\)/);
});
