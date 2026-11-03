/**
 * Read-only Cloudflare Workers health snapshot.
 *
 * Queries aggregate metrics from Workers Observability. Does not fetch
 * request bodies, messages, URLs, credentials, or modify cloud resources.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const WORKERS = Object.freeze(["ai", "afdianpay", "waffopay"]);
export const MAX_HOURS = 168;

const STATEMENT = [
  "SELECT scriptName,",
  "COUNT(*) AS invocations,",
  "SUM(CASE WHEN invocationType = 'fetch' THEN 1 ELSE 0 END) AS fetchInvocations,",
  "SUM(CASE WHEN invocationType = 'scheduled' THEN 1 ELSE 0 END) AS scheduledInvocations,",
  "SUM(CASE WHEN invocationType = 'fetch' AND httpStatus >= 500 THEN 1 ELSE 0 END) AS http5xx,",
  "SUM(CASE WHEN invocationType = 'fetch' AND httpStatus >= 400 AND httpStatus < 500 THEN 1 ELSE 0 END) AS http4xx,",
  "AVG(cpuTimeMs) AS avgCpuMs,",
  "APPROX_MAX(cpuTimeMs) AS maxCpuMs,",
  "AVG(wallTimeMs) AS avgWallMs",
  "FROM logs.workersLogs",
  "WHERE logType = 'cf-worker-event'",
  "AND scriptName IN (" + WORKERS.map(name => "'" + name + "'").join(",") + ")",
  "GROUP BY scriptName",
  "ORDER BY invocations DESC",
  "LIMIT 10",
].join(" ");

const BUSINESS_SIGNAL_STATEMENT = [
  "SELECT scriptName, attributes['event'] AS eventName, attributes['status'] AS statusName, COUNT(*) AS events",
  "FROM logs.workersLogs",
  "WHERE logType = 'cf-worker'",
  "AND scriptName IN ('afdianpay','waffopay')",
  "GROUP BY scriptName,attributes['event'],attributes['status']",
  "ORDER BY events DESC",
  "LIMIT 100",
].join(" ");

const PAYMENT_EVENTS = Object.freeze({
  afdianpay: Object.freeze({
    reconciliation_started: "started",
    payment_scan_processed: "pagesProcessed",
    scan_failed: "scanFailed",
    reconciliation_cycle_outcome: "cyclesNoObservedFailure",
  }),
  waffopay: Object.freeze({
    waffo_production_failed: "productionFailed",
    waffo_production_outbox_unavailable: "outboxUnavailable",
  }),
});

const WAFFO_CYCLE_STATUSES = Object.freeze({
  completed: "cyclesCompleted",
  incomplete: "cyclesIncomplete",
  disabled: "cyclesDisabled",
});

function requireHours(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_HOURS) {
    throw new Error("hours must be an integer between 1 and " + MAX_HOURS);
  }
  return value;
}

function requireAccountId(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{32}$/.test(value)) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID must be a 32-character lowercase hex identifier");
  }
  return value;
}

function nonnegativeNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function createHealthQuery({ accountId, hours = 24, now = new Date() }) {
  requireAccountId(accountId);
  requireHours(hours);
  const end = new Date(now);
  if (!Number.isFinite(end.getTime())) throw new Error("Invalid report timestamp");
  const start = new Date(end.getTime() - hours * 60 * 60 * 1000);
  return {
    query: STATEMENT,
    scope: { accountTag: accountId },
    time_range: { start: start.toISOString(), end: end.toISOString() },
  };
}

export function summarizeWorkerRows(rows) {
  const byName = new Map();
  if (!Array.isArray(rows)) throw new Error("Invalid Cloudflare response shape");
  for (const item of rows) {
    if (!item || !WORKERS.includes(item.scriptName)) continue;
    const invocations = nonnegativeNumber(item.invocations);
    const fetchInvocations = nonnegativeNumber(item.fetchInvocations);
    const scheduledInvocations = nonnegativeNumber(item.scheduledInvocations);
    const http5xx = nonnegativeNumber(item.http5xx);
    const http4xx = nonnegativeNumber(item.http4xx);
    if ([invocations, fetchInvocations, scheduledInvocations, http5xx, http4xx].some(value => value === null)) {
      throw new Error("Invalid Cloudflare metric values");
    }
    if (byName.has(item.scriptName)) throw new Error("Duplicate Worker metric");
    byName.set(item.scriptName, {
      name: item.scriptName,
      observed: true,
      invocations,
      fetchInvocations,
      scheduledInvocations,
      http5xx,
      http4xx,
      errorRate5xx: fetchInvocations > 0 ? http5xx / fetchInvocations : null,
      avgCpuMs: nonnegativeNumber(item.avgCpuMs),
      maxCpuMs: nonnegativeNumber(item.maxCpuMs),
      avgWallMs: nonnegativeNumber(item.avgWallMs),
    });
  }
  return WORKERS.map(name => byName.get(name) || {
    name,
    observed: false,
    invocations: null,
    fetchInvocations: null,
    scheduledInvocations: null,
    http5xx: null,
    http4xx: null,
    errorRate5xx: null,
    avgCpuMs: null,
    maxCpuMs: null,
    avgWallMs: null,
  });
}

/**
 * These are structured application event labels, not raw messages or user data.
 * No current payment Worker emits a verified end-to-end Cron success heartbeat.
 */
export function summarizePaymentBusinessSignals(rows) {
  if (!Array.isArray(rows) || rows.length >= 100) {
    throw new Error("Incomplete Cloudflare business event metrics");
  }
  const groups = {
    afdianpay: {
      name: "afdianpay",
      observed: false,
      successVerified: false,
      started: null,
      pagesProcessed: null,
      scanFailed: null,
      cyclesCompleted: null,
    },
    waffopay: {
      name: "waffopay",
      observed: false,
      successVerified: false,
      productionFailed: null,
      outboxUnavailable: null,
      cyclesCompleted: null,
      cyclesIncomplete: null,
      cyclesDisabled: null,
    },
  };
  const seen = new Set();
  for (const item of rows) {
    const name = item?.scriptName;
    const eventName = item?.eventName;
    const statusName = item?.statusName;
    if (!Object.hasOwn(PAYMENT_EVENTS, name)) continue;
    let category;
    if (name === "waffopay" && eventName === "waffo_production_outbox_cycle") {
      if (!Object.hasOwn(WAFFO_CYCLE_STATUSES, statusName)) continue;
      category = WAFFO_CYCLE_STATUSES[statusName];
    } else {
      if (!Object.hasOwn(PAYMENT_EVENTS[name], eventName)) continue;
      category = PAYMENT_EVENTS[name][eventName];
    }
    const count = nonnegativeNumber(item.events);
    if (count === null) throw new Error("Invalid business event count");
    const key = name + ":" + category;
    if (seen.has(key)) throw new Error("Duplicate business event count");
    seen.add(key);
    groups[name].observed = true;
    groups[name][category] = count;
  }
  for (const group of Object.values(groups)) {
    if (!group.observed) continue;
    for (const key of Object.values(PAYMENT_EVENTS[group.name])) {
      // Heartbeats may not yet be deployed. Missing one is NOT OBSERVED,
      // not confirmed zero completed cycles.
      if (key === "cyclesCompleted") continue;
      if (group[key] === null) group[key] = 0; // Zero observed, not business success.
    }
  }
  return [groups.afdianpay, groups.waffopay];
}

export async function fetchWorkerHealth({
  accountId,
  apiToken,
  hours = 24,
  now = new Date(),
  fetchImpl = globalThis.fetch,
}) {
  const request = createHealthQuery({ accountId, hours, now });
  if (typeof apiToken !== "string" || !apiToken.trim()) {
    throw new Error("CLOUDFLARE_API_TOKEN is required");
  }
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");

  let response;
  try {
    // POST submits a SELECT query to the Analytics SQL API. It does not
    // deploy or change a Worker.
    response = await fetchImpl(
      "https://api.cloudflare.com/client/v4/accounts/" + accountId + "/analytics/sql",
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + apiToken,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch {
    throw new Error("Cloudflare analytics network request failed");
  }

  if (!response?.ok) {
    throw new Error("Cloudflare analytics query failed (HTTP " + (response?.status ?? "unknown") + ")");
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("Cloudflare analytics returned invalid JSON");
  }
  if (!result || !Array.isArray(result.data)) {
    throw new Error("Cloudflare analytics returned invalid data");
  }

  // Separate SELECT: structured application events are in attributes['event'],
  // not in message. Never query arbitrary attribute fields or log bodies.
  let businessResponse;
  try {
    businessResponse = await fetchImpl(
      "https://api.cloudflare.com/client/v4/accounts/" + accountId + "/analytics/sql",
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + apiToken,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ ...request, query: BUSINESS_SIGNAL_STATEMENT }),
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch {
    throw new Error("Cloudflare business metric query failed");
  }
  if (!businessResponse?.ok) {
    throw new Error("Cloudflare business metric query failed (HTTP " +
      (businessResponse?.status ?? "unknown") + ")");
  }
  let businessResult;
  try {
    businessResult = await businessResponse.json();
  } catch {
    throw new Error("Cloudflare business metrics returned invalid JSON");
  }
  if (!Array.isArray(businessResult?.data)) {
    throw new Error("Cloudflare business metrics returned invalid data");
  }

  return {
    period: request.time_range,
    workers: summarizeWorkerRows(result.data),
    paymentSignals: summarizePaymentBusinessSignals(businessResult.data),
    note: "Workers Logs aggregates may be sampled. Missing rows mean no observed logs, not zero errors.",
  };
}

export function formatWorkerHealth(report) {
  const fmt = value => value === null ? "N/A" : Number(value).toFixed(2);
  const eventCount = value => value === null ? "NOT_OBSERVED" : String(value);
  const lines = [
    "Cloudflare Workers health snapshot (" + report.period.start + " to " + report.period.end + ")",
    "Worker      Total*       HTTP Fetch*  Scheduled*  HTTP 5xx*  HTTP 4xx*  Avg CPU(ms)  Approx max CPU(ms)",
  ];
  for (const worker of report.workers) {
    lines.push(worker.observed
      ? worker.name.padEnd(11) + " " +
        String(worker.invocations).padEnd(12) + " " +
        String(worker.fetchInvocations).padEnd(12) + " " +
        String(worker.scheduledInvocations).padEnd(11) + " " +
        String(worker.http5xx).padEnd(10) + " " +
        String(worker.http4xx).padEnd(10) + " " +
        fmt(worker.avgCpuMs).padEnd(12) + " " + fmt(worker.maxCpuMs)
      : worker.name.padEnd(11) + " NO OBSERVED LOG DATA (not proof of zero incidents)");
  }
  lines.push("* Aggregates may be sampled/weighted; scheduled invocations are separated from HTTP fetches.");
  if (Array.isArray(report.paymentSignals)) {
    lines.push("Payment business signals (sampled logs; no verified Cron success heartbeat):");
    for (const signal of report.paymentSignals) {
      if (!signal.observed) {
        lines.push(signal.name + ": NO OBSERVED STRUCTURED BUSINESS EVENTS (outcome unknown)");
      } else if (signal.name === "afdianpay") {
        lines.push("afdianpay: started=" + signal.started +
          " pages_processed=" + signal.pagesProcessed +
          " scan_failed=" + signal.scanFailed +
          " cycles_completed=" + eventCount(signal.cyclesCompleted) +
          " (page event does not prove completed reconciliation)");
      } else {
        lines.push("waffopay: production_failed=" + signal.productionFailed +
          " outbox_unavailable=" + signal.outboxUnavailable +
          " cycles_completed=" + eventCount(signal.cyclesCompleted) +
          " cycles_incomplete=" + eventCount(signal.cyclesIncomplete) +
          " cycles_disabled=" + eventCount(signal.cyclesDisabled) +
          " (completed means outbox batch finished, not payment entitlement guaranteed)");
      }
    }
  }
  lines.push("No raw logs, request bodies, URLs, tokens, or conversation content were queried.");
  return lines.join("\n");
}

export function hoursFromArgs(argv) {
  if (argv.length === 0) return 24;
  if (argv.length !== 2 || argv[0] !== "--hours" || !/^[1-9]\d{0,2}$/.test(argv[1])) {
    throw new Error("Usage: node scripts/reliability/worker-health.mjs [--hours 1..168]");
  }
  return requireHours(Number(argv[1]));
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const hours = hoursFromArgs(argv);
  const report = await fetchWorkerHealth({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: env.CLOUDFLARE_API_TOKEN,
    hours,
  });
  process.stdout.write(formatWorkerHealth(report) + "\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    // Controlled errors only. Never print credentials, bodies or stack traces.
    process.stderr.write("Read-only Worker report failed: " + error.message + "\n");
    process.exitCode = 1;
  });
}
