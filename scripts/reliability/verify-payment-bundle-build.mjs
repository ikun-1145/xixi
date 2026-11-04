import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const baselinePath = new URL("../../docs/reliability/payment-worker-production-baseline-2026-11-03.json", import.meta.url);
const WORKER_MARKERS = Object.freeze({
  afdianpay: "reconciliation_cycle_outcome",
  waffopay: "waffo_production_outbox_cycle",
});

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Classify a build without treating successful compilation as evidence of
 * production reproducibility. Only in-memory buffers and hashes are used.
 */
export function assessCompiledPaymentWorker(expected, mainBundle, candidateBundle) {
  if (!expected || !Object.hasOwn(WORKER_MARKERS, expected.name) ||
      !/^[0-9a-f]{64}$/.test(expected.bundle_sha256)) {
    throw new Error("Invalid reviewed Worker baseline");
  }
  if (!Buffer.isBuffer(mainBundle) || !Buffer.isBuffer(candidateBundle) ||
      mainBundle.length === 0 || candidateBundle.length === 0) {
    throw new Error("Worker build missing");
  }
  const mainHash = sha256(mainBundle);
  const candidateHash = sha256(candidateBundle);
  const marker = WORKER_MARKERS[expected.name];
  const markerPresent = candidateBundle.includes(Buffer.from(marker));
  const baselineMatch = mainHash === expected.bundle_sha256;
  const candidateChanged = mainHash !== candidateHash;
  return {
    name: expected.name,
    baselineMatch,
    candidateChanged,
    markerPresent,
    mainHash,
    candidateHash,
    accepted: baselineMatch && candidateChanged && markerPresent,
  };
}

export function inspectCompiledPaymentBuilds(baseline, artifacts) {
  const checks = [];
  if (!Array.isArray(baseline?.workers) || baseline.workers.length !== 2) {
    throw new Error("Invalid payment Worker baseline");
  }
  for (const worker of baseline.workers) {
    const pair = artifacts[worker.name];
    if (!pair) throw new Error("Worker build missing: " + worker.name);
    checks.push(assessCompiledPaymentWorker(worker, pair.main, pair.candidate));
  }
  return checks;
}

export function formatBuildCheck(result) {
  if (!result || typeof result.name !== "string") throw new Error("Invalid build comparison");
  const status = result.accepted ? "PASS" : "BLOCKED";
  const diagnostics = [
    "baseline_main_reproduces_live=" + result.baselineMatch,
    "candidate_differs=" + result.candidateChanged,
    "candidate_heartbeat_present=" + result.markerPresent,
    "main_sha256=" + result.mainHash,
    "candidate_sha256=" + result.candidateHash,
  ];
  return status + " " + result.name + ": " + diagnostics.join(" ");
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || typeof argv[0] !== "string") {
    throw new Error("Usage: node scripts/reliability/verify-payment-bundle-build.mjs <build-output-directory>");
  }
  const root = resolve(argv[0]);
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const artifacts = {};
  for (const { name } of baseline.workers) {
    if (!Object.hasOwn(WORKER_MARKERS, name)) throw new Error("Unexpected Worker in baseline");
    artifacts[name] = {
      main: readFileSync(resolve(root, name, "main", "worker.js")),
      candidate: readFileSync(resolve(root, name, "candidate", "worker.js")),
    };
  }
  const checks = inspectCompiledPaymentBuilds(baseline, artifacts);
  for (const check of checks) process.stdout.write(formatBuildCheck(check) + "\n");
  if (checks.some(item => !item.accepted)) {
    process.stderr.write("NOT_REPRODUCIBLE: deployment remains blocked; investigate toolchain and source differences.\n");
    process.exitCode = 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    // Avoid path content, stack traces or source code in public CI logs.
    process.stderr.write("BLOCKED: payment bundle verification failed (" +
      (error?.code || "invalid inputs") + ").\n");
    process.exitCode = 2;
  }
}
