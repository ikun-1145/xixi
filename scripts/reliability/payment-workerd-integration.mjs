/**
 * Workerd-level smoke/integration checks for compiled payment Workers.
 *
 * This program only runs in CI with a throwaway local Miniflare D1 database
 * and an outbound fetch mock that forbids ALL real network connections.
 * It never loads wrangler.toml or .dev.vars, or supplies production bindings.
 *
 * Setup: npm install --prefix /tmp/payment-mf --no-save miniflare@4.20260730.0
 * Invoke: PAYMENT_MINIFLARE_ROOT=/tmp/payment-mf node scripts/reliability/payment-workerd-integration.mjs /tmp/payment-bundles
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const DB_ID = "88888888-8888-4888-8888-888888888888";
const MOCK_VALUES = Object.freeze({
  WAFFO_ENVIRONMENT: "test",
  WAFFO_PRODUCTION_ENABLED: "true",
  WAFFO_PRODUCTION_ENTITLEMENT_ENABLED: "false",
  WAFFO_PROD_MERCHANT_ID: "MER_unit",
  WAFFO_PROD_STORE_ID: "STO_unit",
  WAFFO_PROD_PRODUCT_ID: "PROD_unit",
  WAFFO_WEBHOOK_PUBLIC_KEY_PROD: "unit-public-key-prod",
  WAFFO_WEBHOOK_PUBLIC_KEY_TEST: "unit-public-key-test",
});
let caseCount = 0;

function assertOutcome(result, description, shouldFail = false) {
  assert.ok(result && typeof result === "object", description + ": missing scheduled outcome");
  if (shouldFail) {
    assert.notEqual(result.outcome, "ok", description + ": failed Cron was misclassified as ok");
  } else {
    assert.equal(result.outcome, "ok", description + ": expected successful event dispatch");
  }
  caseCount++;
  process.stdout.write("PASS workerd: " + description + "\n");
}

async function importTestRuntime() {
  const base = process.env.PAYMENT_MINIFLARE_ROOT;
  if (!base || !base.startsWith("/")) throw new Error("PAYMENT_MINIFLARE_ROOT is required");
  const require = createRequire(join(base, "integration-loader.cjs"));
  const entry = require.resolve("miniflare");
  const module = await import(pathToFileURL(entry).href);
  if (typeof module.Miniflare !== "function" ||
      typeof module.convertV4MiniflareOptions !== "function") {
    throw new Error("Miniflare integration API unavailable");
  }
  return module;
}

function createIsolatedWorker(Miniflare, convertV4MiniflareOptions, scriptPath, bindings = {}, includeD1 = false) {
  const outbound = { attempts: 0 };
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: "payment-isolated-worker",
    modules: [{
      type: "ESModule",
      path: "worker.js",
      contents: readFileSync(scriptPath, "utf8"),
    }],
    compatibilityDate: "2026-09-05",
    bindings,
    ...(includeD1 ? { d1Databases: { WAFFO_PRODUCTION_LEDGER: DB_ID } } : {}),
    // Miniflare 5 removed fetchMock. This local mock service intercepts
    // every global outbound request and NEVER forwards it to the network.
    outboundService: async () => {
      outbound.attempts++;
      return new Response("NO_OUTBOUND_NETWORK", { status: 503 });
    },
    // No persistence, remote bindings, real secrets, or service bindings.
  }));
  return { mf, outbound };
}

async function waffoCronCase({ Miniflare, convertV4MiniflareOptions, waffoPath, enabled, payload, expectation }) {
  const { mf, outbound } = createIsolatedWorker(Miniflare, convertV4MiniflareOptions, waffoPath,
    enabled ? MOCK_VALUES : {}, true);
  try {
    const db = await mf.getD1Database("WAFFO_PRODUCTION_LEDGER");
    await db.exec(
      "CREATE TABLE production_outbox (payload TEXT NOT NULL, state TEXT NOT NULL, updated_at INTEGER NOT NULL)"
    );
    if (payload !== undefined) {
      await db.prepare("INSERT INTO production_outbox(payload,state,updated_at) VALUES(?,'pending',?)")
        .bind(payload, 0).run();
    }
    const before = await db.prepare("SELECT COUNT(*) AS n FROM production_outbox").first();
    const worker = await mf.getWorker();
    const result = await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: new Date(0) });
    assertOutcome(result, expectation);
    const after = await db.prepare("SELECT COUNT(*) AS n FROM production_outbox").first();
    assert.equal(after.n, before.n, expectation + ": unexpected production outbox mutation");
    assert.equal(outbound.attempts, 0, expectation + ": unexpectedly attempted external network");
  } finally {
    await mf.dispose();
  }
}

async function afdianFailClosedCase({ Miniflare, convertV4MiniflareOptions, afdianPath }) {
  const { mf, outbound } = createIsolatedWorker(Miniflare, convertV4MiniflareOptions, afdianPath, {
    AFDIAN_ROLLOUT_DIAGNOSTICS_ONLY: "false",
    SUPABASE_URL: "https://supabase.unit.invalid",
    SUPABASE_KEY: "fake-test-token-only",
    TOKEN: "fake-test-api-token-only",
    USER_ID: "unit-test",
  });
  try {
    const worker = await mf.getWorker();
    // No outbound responses are registered. Every RPC/provider request fails
    // before reaching the Internet. A failed claim must surface as failed Cron.
    let observed;
    try {
      observed = await worker.scheduled({ cron: "*/2 * * * *", scheduledTime: new Date(0) });
    } catch {
      observed = { outcome: "exception" };
    }
    assertOutcome(observed, "afdian: unreachable RPC rejects Cron", true);
    assert.ok(outbound.attempts >= 1, "Afdian test must exercise the simulated upstream outage");
  } finally {
    await mf.dispose();
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || typeof argv[0] !== "string" || !argv[0].startsWith("/")) {
    throw new Error("Expected absolute offline compiled Worker output root");
  }
  const root = resolve(argv[0]);
  const afdianPath = join(root, "afdianpay", "candidate", "worker.js");
  const waffoPath = join(root, "waffopay", "candidate", "worker.js");
  for (const file of [afdianPath, waffoPath]) {
    if (readFileSync(file).length < 1000) throw new Error("Missing compiled candidate Worker");
  }
  const runtime = await importTestRuntime();
  await waffoCronCase({
    ...runtime, waffoPath, enabled: false, expectation: "waffo: disabled safely",
  });
  await waffoCronCase({
    ...runtime, waffoPath, enabled: true, expectation: "waffo: empty outbox completes",
  });
  await waffoCronCase({
    ...runtime, waffoPath, enabled: true,
    payload: JSON.stringify({ order: { reference: "fake-unmatched-reference" } }),
    expectation: "waffo: missing intent is contained",
  });
  await waffoCronCase({
    ...runtime, waffoPath, enabled: true,
    payload: "{MALFORMED_FAKE_EVENT",
    expectation: "waffo: malformed payload is contained",
  });
  await afdianFailClosedCase({ ...runtime, afdianPath });
  process.stdout.write("PASS: " + caseCount + " isolated workerd scenarios; all outbound fetch denied.\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    // This CI intentionally has no production credentials or network access.
    // Emit only bounded diagnostic text; never echo stack traces or raw bundles.
    const kind = /^[A-Za-z]+Error$/.test(error?.name || "") ? error.name : "Error";
    const detail = String(error?.message || "unknown failure")
      .split("\n")[0].replace(/https?:\/\/\S+/g, "[endpoint]")
      .replace(/fake-test-[A-Za-z0-9-]+/g, "[redacted]")
      .replace(/[A-Za-z0-9+_\/-]{65,}/g, "[redacted]")
      .slice(0, 140);
    process.stderr.write("[BLOCKED] Isolated workerd integration failed: " + kind + " " + detail + "\n");
    process.exitCode = 2;
  });
}
