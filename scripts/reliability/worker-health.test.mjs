import test from "node:test";
import assert from "node:assert/strict";
import {
  WORKERS,
  MAX_HOURS,
  createHealthQuery,
  summarizeWorkerRows,
  summarizePaymentBusinessSignals,
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
    fetchInvocations: 240,
    scheduledInvocations: 160,
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
  assert.match(req.query, /invocationType = 'fetch'/);
  assert.match(req.query, /invocationType = 'scheduled'/);
  assert.match(req.query, /ORDER BY invocations DESC LIMIT 10$/);
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
  assert.equal(summary[0].fetchInvocations, 240);
  assert.equal(summary[0].scheduledInvocations, 160);
  assert.equal(summary[0].errorRate5xx, 12 / 240);
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
    "name", "observed", "invocations", "fetchInvocations", "scheduledInvocations", "http5xx", "http4xx",
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
      return Response.json({ data: calls.length === 1
        ? [sampleRow()]
        : [
            { scriptName: "afdianpay", eventName: "reconciliation_started", events: 730 },
            { scriptName: "afdianpay", eventName: "scan_failed", events: 2 },
          ] });
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://api.cloudflare.com/client/v4/accounts/" + accountId + "/analytics/sql");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, "Bearer " + secret);
  const payload = JSON.parse(calls[0].init.body);
  assert.match(payload.query, /^SELECT /);
  assert.deepEqual(payload.scope, { accountTag: accountId });
  const businessPayload = JSON.parse(calls[1].init.body);
  assert.deepEqual(businessPayload.scope, payload.scope);
  assert.deepEqual(businessPayload.time_range, payload.time_range);
  assert.match(businessPayload.query, /attributes\['event'\] AS eventName/);
  assert.match(businessPayload.query, /GROUP BY scriptName,attributes\['event'\],attributes\['status'\]/);
  assert.match(businessPayload.query, /LIMIT 100$/);
  assert.doesNotMatch(businessPayload.query, /\bmessage\b|\burl\b|\btrace_id\b|\border_id\b/i);
  assert.equal(report.workers[0].http5xx, 12);
  assert.equal(report.workers[0].fetchInvocations, 240);
  assert.equal(report.workers[0].scheduledInvocations, 160);
  assert.equal(report.paymentSignals[0].scanFailed, 2);
  assert.equal(report.paymentSignals[0].started, 730);
  assert.equal(report.paymentSignals[0].cyclesNoObservedFailure, null);
  assert.equal(report.paymentSignals[0].successVerified, false);
  assert.equal(report.paymentSignals[1].observed, false);
  assert.equal(report.paymentSignals[1].productionFailed, null);
  assert.match(formatWorkerHealth(report), /outcome unknown/);
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

test("payment business counts use only allowlisted structured event codes", () => {
  const report = summarizePaymentBusinessSignals([
    { scriptName: "afdianpay", eventName: "reconciliation_started", events: 726 },
    { scriptName: "afdianpay", eventName: "payment_scan_processed", events: 1438 },
    { scriptName: "afdianpay", eventName: "scan_failed", events: 2 },
    { scriptName: "afdianpay", eventName: "payment_persisted", events: 772 },
    { scriptName: "afdianpay", eventName: "unknown_event_with_private_details", events: 11 },
    { scriptName: "afdianpay", eventName: "__proto__", events: 3 },
    { scriptName: "constructor", eventName: "scan_failed", events: 99 },
    { scriptName: "waffopay", eventName: null, events: 1 },
  ]);
  assert.deepEqual(report[0], {
    name: "afdianpay", observed: true, successVerified: false,
    started: 726, pagesProcessed: 1438, scanFailed: 2,
    cyclesNoObservedFailure: null, cyclesPartialFailure: null,
    cyclesDeferred: null, cyclesFailed: null,
  });
  assert.deepEqual(report[1], {
    name: "waffopay", observed: false, successVerified: false,
    productionFailed: null, outboxUnavailable: null,
    cyclesCompleted: null, cyclesIncomplete: null, cyclesDisabled: null,
  });
  assert.doesNotMatch(JSON.stringify(report), /unknown_event_with_private_details|payment_persisted/);
});

test("absence of a Waffo success heartbeat is never reported as successful Cron", () => {
  const report = summarizePaymentBusinessSignals([
    { scriptName: "waffopay", eventName: "waffo_production_failed", events: 3 },
    { scriptName: "waffopay", eventName: "waffo_production_outbox_unavailable", events: 1 },
  ]);
  assert.equal(report[1].observed, true);
  assert.equal(report[1].successVerified, false);
  assert.equal(report[1].productionFailed, 3);
  assert.equal(report[1].outboxUnavailable, 1);
  const output = formatWorkerHealth({
    period: { start: "2026-11-02", end: "2026-11-03" },
    workers: summarizeWorkerRows([]),
    paymentSignals: report,
  });
  assert.match(output, /waffopay: production_failed=3 outbox_unavailable=1/);
  assert.match(output, /cycles_completed=NOT_OBSERVED/);
});

test("business event schema failures fail closed instead of claiming zero incidents", () => {
  assert.throws(() => summarizePaymentBusinessSignals(null), /Incomplete/);
  assert.throws(() => summarizePaymentBusinessSignals(Array.from({length:100}, () => ({}))), /Incomplete/);
  assert.throws(() => summarizePaymentBusinessSignals([
    { scriptName: "afdianpay", eventName: "scan_failed", events: "invalid" },
  ]), /Invalid business event count/);
  assert.throws(() => summarizePaymentBusinessSignals([
    { scriptName: "afdianpay", eventName: "scan_failed", events: 1 },
    { scriptName: "afdianpay", eventName: "scan_failed", events: 2 },
  ]), /Duplicate/);
});

test("a failed second analytics query does not give a misleading healthy report", async () => {
  let number = 0;
  await assert.rejects(fetchWorkerHealth({
    accountId, apiToken: secret,
    fetchImpl: async () => {
      number++;
      return number === 1 ? Response.json({ data: [sampleRow()] })
        : new Response("private error: " + secret, { status: 403 });
    },
  }), error => error.message === "Cloudflare business metric query failed (HTTP 403)" &&
    !error.message.includes(secret));
  assert.equal(number, 2);
});

test("future payment Cron heartbeat statuses are classified without trusting arbitrary event fields", () => {
  const signals = summarizePaymentBusinessSignals([
    { scriptName: "afdianpay", eventName: "reconciliation_cycle_outcome", statusName: "no_observed_failure", events: 44 },
    { scriptName: "afdianpay", eventName: "reconciliation_cycle_outcome", statusName: "partial_failure", events: 3 },
    { scriptName: "afdianpay", eventName: "reconciliation_cycle_outcome", statusName: "deferred", events: 2 },
    { scriptName: "afdianpay", eventName: "reconciliation_cycle_outcome", statusName: "failed", events: 1 },
    { scriptName: "afdianpay", eventName: "reconciliation_cycle_outcome", statusName: "__proto__", events: 99 },
    { scriptName: "waffopay", eventName: "waffo_production_outbox_cycle", statusName: "completed", events: 30 },
    { scriptName: "waffopay", eventName: "waffo_production_outbox_cycle", statusName: "incomplete", events: 4 },
    { scriptName: "waffopay", eventName: "waffo_production_outbox_cycle", statusName: "disabled", events: 2 },
    { scriptName: "waffopay", eventName: "waffo_production_outbox_cycle", statusName: "__proto__", events: 100 },
    { scriptName: "waffopay", eventName: "waffo_production_outbox_cycle", statusName: "constructor", events: 200 },
  ]);
  assert.equal(signals[0].cyclesNoObservedFailure, 44);
  assert.equal(signals[0].cyclesPartialFailure, 3);
  assert.equal(signals[0].cyclesDeferred, 2);
  assert.equal(signals[0].cyclesFailed, 1);
  assert.equal(signals[1].cyclesCompleted, 30);
  assert.equal(signals[1].cyclesIncomplete, 4);
  assert.equal(signals[1].cyclesDisabled, 2);
  assert.equal(signals[1].successVerified, false);
  const rendered = formatWorkerHealth({
    period: {start: "2026-11-02", end: "2026-11-03"},
    workers: summarizeWorkerRows([]),
    paymentSignals: signals,
  });
  assert.match(rendered, /cycles_completed=30 cycles_incomplete=4 cycles_disabled=2/);
  assert.doesNotMatch(rendered, /constructor|__proto__/);
});

test("business heartbeat counts remain unknown before logging code is deployed", () => {
  const signals = summarizePaymentBusinessSignals([
    { scriptName: "afdianpay", eventName: "reconciliation_started", events: 8 },
  ]);
  assert.equal(signals[0].cyclesNoObservedFailure, null);
  assert.equal(signals[1].cyclesCompleted, null);
  assert.equal(signals[1].observed, false);
  const rendered = formatWorkerHealth({
    period: {start: "2026-11-02", end: "2026-11-03"},
    workers: summarizeWorkerRows([]),
    paymentSignals: signals,
  });
  assert.match(rendered, /afdianpay:.*no_observed_failure=NOT_OBSERVED/u);
  assert.match(rendered, /waffopay: NO OBSERVED STRUCTURED BUSINESS EVENTS/u);
});
