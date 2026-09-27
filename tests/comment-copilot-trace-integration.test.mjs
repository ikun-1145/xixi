import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createTraceContext } from "../ai/trace-context.js";

test("comment-copilot redacts provider failures and keeps successful requests alive when telemetry fails", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "sunland-copilot-trace-"));
  const original = { Deno: globalThis.Deno, EdgeRuntime: globalThis.EdgeRuntime, fetch: globalThis.fetch, admin: globalThis.__traceTestAdmin };
  const originalError = console.error;
  const originalWarn = console.warn;
  try {
    let source = await readFile(new URL("../supabase/functions/comment-copilot/index.ts", import.meta.url), "utf8");
    source = source.replace('from "https://esm.sh/@supabase/supabase-js@2"', 'from "./supabase-client.mjs"');
    await writeFile(path.join(temp, "index.ts"), source);
    await cp(new URL("../supabase/functions/comment-copilot/trace.js", import.meta.url), path.join(temp, "trace.js"));
    await writeFile(path.join(temp, "package.json"), '{"type":"module"}');
    await writeFile(path.join(temp, "supabase-client.mjs"), "export const createClient = () => globalThis.__traceTestAdmin;");
    await writeFile(path.join(temp, "internet_context.ts"), "export const buildContextBlock = () => '';\n");
    await writeFile(path.join(temp, "verified-identity.js"), "export const verifiedActiveUserId = async () => ({ userId: 'test-user', status: 200 });\n");

    let handler;
    const tasks = [];
    globalThis.Deno = { env: { get: key => ({ SUPABASE_URL: "https://example.test", SUPABASE_SERVICE_ROLE_KEY: "server-only-key", OPENAI_API_KEY: "test-key" })[key] ?? null }, serve: callback => { handler = callback; } };
    globalThis.EdgeRuntime = { waitUntil: promise => tasks.push(promise) };
    await import(pathToFileURL(path.join(temp, "index.ts")).href);
    assert.equal(typeof handler, "function");

    const logs = [];
    console.error = (...args) => logs.push(args);
    console.warn = (...args) => logs.push(args);
    const records = [];
    let telemetryFails = false;
    globalThis.__traceTestAdmin = {
      from(table) {
        return {
          select() { return ["comment_copilot_config", "comment_copilot_secrets"].includes(table) ? Promise.resolve({ data: [] }) : this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: table === "user_profiles" ? { pro: false } : null }),
          upsert: async (rows) => {
            if (table.startsWith("observability_") && telemetryFails) throw new Error("DB error with private provider body");
            records.push({ table, rows });
            return { error: null };
          },
        };
      },
      rpc: async () => ({ data: 1, error: null }),
    };
    const secret = "private prompt JWT abc@example.com https://image.test/path";
    globalThis.fetch = async () => new Response(secret, { status: 502 });
    const client = createTraceContext();
    const request = () => new Request("https://example.test/functions/v1/comment-copilot", {
      method: "POST",
      headers: { Authorization: "Bearer test-token", "Content-Type": "application/json", traceparent: client.traceparent },
      body: JSON.stringify({ action: "generate", comment: "用户评论仅作为模型输入", tone: "rational" }),
    });

    const failure = await handler(request());
    await Promise.all(tasks.splice(0));
    assert.equal(failure.status, 502);
    assert.equal(failure.headers.get("X-Sunland-Trace-Id"), client.traceId);
    assert.match(failure.headers.get("Access-Control-Expose-Headers"), /X-Sunland-Trace-Id/);
    const publicError = await failure.json();
    assert.deepEqual(Object.keys(publicError).sort(), ["code", "error", "trace_id"]);
    assert.equal(publicError.code, "provider_error");
    assert.equal(publicError.trace_id, client.traceId);
    assert.doesNotMatch(JSON.stringify({ publicError, logs, records }), /private prompt|abc@example\.com|image\.test|JWT/);
    const storedSpans = records.find(record => record.table === "observability_spans").rows;
    assert.equal(storedSpans[0].parent_span_id, client.spanId);
    assert.ok(storedSpans.some(span => span.name === "AI_UPSTREAM" && span.status === "ERROR"));

    telemetryFails = true;
    globalThis.fetch = async () => new Response(
      'data: {"type":"response.output_text.delta","delta":"{\\"analysis\\":{},\\"advice\\":{},\\"reply\\":{}}"}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
    const success = await handler(request());
    await Promise.all(tasks.splice(0));
    assert.equal(success.status, 200);
    assert.ok((await success.json()).result);
    assert.equal(success.headers.get("X-Sunland-Trace-Id"), client.traceId);
    assert.doesNotMatch(JSON.stringify(logs), /DB error with private provider body/);
  } finally {
    globalThis.Deno = original.Deno;
    globalThis.EdgeRuntime = original.EdgeRuntime;
    globalThis.fetch = original.fetch;
    globalThis.__traceTestAdmin = original.admin;
    console.error = originalError;
    console.warn = originalWarn;
    await rm(temp, { recursive: true, force: true });
  }
});
