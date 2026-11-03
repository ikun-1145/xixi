import test from "node:test";
import assert from "node:assert/strict";
import {
  WORKERS,
  MAX_HOURS,
  createHealthQuery,
  summarizeWorkerRows,
  fetchWorkerHealth,
  formatWorkerHealth,
  hoursFromArgs,
} from "./worker-health.mjs";

const accountId = "a".repeat(32);
const secret = "test-token-do-not-print";

function sampleRow(name = "ai") {
  return {
    scriptName: name,
    invocations: 400,
    http5xx: 12,
    http4xx: 30,
    avgCpuMs: 3.5,
    maxCpuMs: 60,
    avgWallMs: 900,
    message: "private log message that must never surface",
    url: "https://example.com/?token=private",
  };
}

test("builds a scoped read-only aggregate query for supported Workers", () => {
  const req = createHealthQuery({
    accountId,
    hours: 24,
    now: new Date("2026-11-03T04:00:00Z"),
  });
  assert.deepEqual(req.scope, { accountTag: accountId });
  assert.deepEqual(req.time_range, {
    start: "2026-11-02T04:00:00.000Z",
    end: "2026-11-03T04:00:00.000Z",
  });
  assert.match(req.query, /^SELECT /);
  assert.match(req.query, /FROM logs\.workersLogs/);
  assert.match(req.query, /APPROX_MAX\(cpuTimeMs\)/);
  assert.doesNotMatch(req.query, /(^|[^a-z])(?:UPDATE|DELETE|INSERT|ALTER|DROP|CREATE)([^a-z]|$)/i);
  assert.doesNotMatch(req.query, /\b(?:message|url|requestId|userId|authorization)\b/i);
  for (const worker of WORKERS) assert.ok(req.query.includes("'" + worker + "'"));
  assert.ok(!req.query.includes("phone-auth"));
});

test("rejects invalid accounts, dates and out-of-bounds history windows", () => {
  assert.throws(() => createHealthQuery({ accountId: "bad" }), /ACCOUNT_ID/);
  assert.throws(() => createHealthQuery({ accountId, hours: 0 }), /hours/);
  assert.throws(() => createHealthQuery({ accountId, hours: MAX_HOURS + 1 }), /hours/);
  assert.throws(() => createHealthQuery({ accountId, hours: 1.5 }), /hours/);
  assert.throws(() => createHealthQuery({ accountId, now: "not-a-date" }), /timestamp/);
});

test("missing Workers are marked unobserved, never as zero incidents", () => {
  const summary = summarizeWorkerRows([sampleRow()]);
  assert.equal(summary.length, 3);
  assert.equal(summary[0].name, "ai");
  assert.equal(summary[0].observed, true);
  assert.equal(summary[0].errorRate5xx, 12 / 400);
  for (const worker of summary.slice(1)) {
    assert.equal(worker.observed, false);
    assert.equal(worker.invocations, null);
    assert.equal(worker.http5xx, null);
  }
  const text = formatWorkerHealth({
    period: { start: "2026-11-02", end: "2026-11-03" },
    workers: summary,
  });
  assert.match(text, /NO OBSERVED LOG DATA/);
  assert.doesNotMatch(text, /private log message|token=private/);
});

test("summaries omit raw logs, URLs and other unexpected columns", () => {
  const data = summarizeWorkerRows([sampleRow()]);
  assert.deepEqual(Object.keys(data[0]), [
    "name", "observed", "invocations", "http5xx", "http4xx",
    "errorRate5xx", "avgCpuMs", "maxCpuMs", "avgWallMs",
  ]);
  assert.doesNotMatch(JSON.stringify(data), /private log message|example\.com/);
  assert.throws(() => summarizeWorkerRows([sampleRow(), sampleRow()]), /Duplicate/);
  assert.throws(() => summarizeWorkerRows([{ ...sampleRow(), http5xx: -1 }]), /metric/);
  assert.throws(() => summarizeWorkerRows(null), /shape/);
});

test("missing CPU metrics are represented as unavailable, not measured zeros", () => {
  const result = summarizeWorkerRows([{
    ...sampleRow(), avgCpuMs: null, maxCpuMs: null, avgWallMs: null,
  }]);
  assert.equal(result[0].avgCpuMs, null);
  assert.equal(result[0].maxCpuMs, null);
  assert.equal(result[0].avgWallMs, null);
});

test("uses only the analytics SQL endpoint with a scoped bearer token", async () => {
  const calls = [];
  const report = await fetchWorkerHealth({
    accountId,
    apiToken: secret,
    now: "2026-11-03T04:00:00Z",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return Response.json({ data: [sampleRow()] });
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.cloudflare.com/client/v4/accounts/" + accountId + "/analytics/sql");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, "Bearer " + secret);
  const payload = JSON.parse(calls[0].init.body);
  assert.match(payload.query, /^SELECT /);
  assert.deepEqual(payload.scope, { accountTag: accountId });
  assert.equal(report.workers[0].http5xx, 12);
  assert.doesNotMatch(JSON.stringify(report), /private log message|token=private|test-token-do-not-print/);
});

test("API errors, malformed data and network failures never expose secrets", async () => {
  await assert.rejects(fetchWorkerHealth({
    accountId, apiToken: secret,
    fetchImpl: async () => new Response("upstream secret " + secret, { status: 403 }),
  }), e => e.message === "Cloudflare analytics query failed (HTTP 403)" && !e.message.includes(secret));
  await assert.rejects(fetchWorkerHealth({
    accountId, apiToken: secret,
    fetchImpl: async () => { throw new Error("connection leaked " + secret); },
  }), e => e.message === "Cloudflare analytics network request failed");
  await assert.rejects(fetchWorkerHealth({
    accountId, apiToken: secret,
    fetchImpl: async () => Response.json({ secret: "should-not-be-used" }),
  }), /invalid data/);
  await assert.rejects(fetchWorkerHealth({ accountId, apiToken: "" }), /API_TOKEN/);
});

test("CLI options default to one day and reject invalid windows", () => {
  assert.equal(hoursFromArgs([]), 24);
  assert.equal(hoursFromArgs(["--hours", "1"]), 1);
  assert.equal(hoursFromArgs(["--hours", String(MAX_HOURS)]), MAX_HOURS);
  for (const args of [["--hours", "0"], ["--hours", "169"], ["--hours", "1.5"], ["--token", secret]]) {
    assert.throws(() => hoursFromArgs(args), /Usage|hours/);
  }
});
