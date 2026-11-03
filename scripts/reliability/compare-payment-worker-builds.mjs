/**
 * Offline payment Worker reproducible-build gate.
 * Reads only local Wrangler dry-run artifacts, never Cloudflare/production.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const WORKERS = Object.freeze(["afdianpay", "waffopay"]);
const MARKERS = Object.freeze({
  afdianpay: "reconciliation_cycle_completed",
  waffopay: "waffo_production_outbox_cycle",
});

export function bundleFingerprint(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 1_000 || buffer.length > 2_000_000) {
    throw new Error("Invalid local Worker bundle size or type");
  }
  return createHash("sha256").update(buffer).digest("hex");
}

function readBuiltBundle(root, worker) {
  if (!WORKERS.includes(worker)) throw new Error("Unsupported Worker");
  const path = resolve(root, worker, "worker.js");
  if (!statSync(path).isFile()) throw new Error("Missing compiled Worker file");
  return readFileSync(path);
}

export function comparePaymentBundles(expected, builds) {
  if (!Array.isArray(expected?.workers) || expected.workers.length !== WORKERS.length) {
    return { passed: false, results: [], blockers: ["Invalid reviewed production baseline"] };
  }
  const results = [];
  const blockers = [];
  for (const worker of WORKERS) {
    const ref = expected.workers.find(x => x.name === worker);
    const item = builds?.[worker];
    if (!ref || !/^[a-f0-9]{64}$/.test(ref.bundle_sha256 || "") ||
        !item || !Buffer.isBuffer(item.baseline) ||
        !Buffer.isBuffer(item.candidateA) || !Buffer.isBuffer(item.candidateB)) {
      blockers.push(worker + ": missing source/bundle baseline");
      continue;
    }
    let oldHash, aHash, bHash;
    try {
      oldHash = bundleFingerprint(item.baseline);
      aHash = bundleFingerprint(item.candidateA);
      bHash = bundleFingerprint(item.candidateB);
    } catch {
      blockers.push(worker + ": invalid local build output");
      continue;
    }
    const baselineReproduced = oldHash === ref.bundle_sha256;
    const candidateDeterministic = aHash === bHash;
    const changePresent = aHash !== oldHash;
    const marker = Buffer.from(MARKERS[worker], "utf8");
    const candidateHasMarker = item.candidateA.includes(marker);
    const baselineHasNoMarker = !item.baseline.includes(marker);
    results.push({
      worker,
      productionHash: ref.bundle_sha256,
      baselineBuildHash: oldHash,
      candidateBuildHash: aHash,
      baselineReproduced,
      candidateDeterministic,
      candidateChangePresent: changePresent,
      candidateHasMarker,
      baselineHasNoMarker,
    });
    if (!baselineReproduced) blockers.push(worker + ": baseline does not reproduce production bundle");
    if (!candidateDeterministic) blockers.push(worker + ": candidate builds are not byte-identical");
    if (!changePresent || !candidateHasMarker || !baselineHasNoMarker) {
      blockers.push(worker + ": heartbeat change missing or unexpected baseline change");
    }
  }
  if (results.length !== WORKERS.length) blockers.push("Not every payment Worker was verified");
  return { passed: blockers.length === 0, results, blockers };
}

export function evaluateLocalBuildDirectories({
  baselineRoot,
  candidateRootA,
  candidateRootB,
  manifestPath = new URL(
    "../../docs/reliability/payment-worker-production-baseline-2026-11-03.json",
    import.meta.url,
  ),
}) {
  const expected = JSON.parse(readFileSync(manifestPath, "utf8"));
  const builds = {};
  for (const worker of WORKERS) {
    builds[worker] = {
      baseline: readBuiltBundle(baselineRoot, worker),
      candidateA: readBuiltBundle(candidateRootA, worker),
      candidateB: readBuiltBundle(candidateRootB, worker),
    };
  }
  return comparePaymentBundles(expected, builds);
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length !== 3 || argv.some(x => typeof x !== "string" || !x.startsWith("/"))) {
    throw new Error("Usage: compare-payment-worker-builds.mjs /absolute/baseline /absolute/candidate-a /absolute/candidate-b");
  }
  const summary = evaluateLocalBuildDirectories({
    baselineRoot: argv[0],
    candidateRootA: argv[1],
    candidateRootB: argv[2],
  });
  for (const result of summary.results) {
    process.stdout.write(result.worker +
      ": production=" + result.productionHash.slice(0, 16) +
      " baseline=" + result.baselineBuildHash.slice(0, 16) +
      " candidate=" + result.candidateBuildHash.slice(0, 16) +
      " reproduced=" + result.baselineReproduced +
      " deterministic=" + result.candidateDeterministic + "\n");
  }
  if (!summary.passed) {
    for (const reason of summary.blockers) process.stderr.write("[BLOCKED] " + reason + "\n");
    process.exitCode = 2;
  } else {
    process.stdout.write("PASS: baseline reproduces production and candidate builds are deterministic.\n");
    process.stdout.write("This does NOT authorize production deployment or prove payment business safety.\n");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch {
    process.stderr.write("[BLOCKED] Unable to inspect offline Worker build artifacts.\n");
    process.exitCode = 2;
  }
}
