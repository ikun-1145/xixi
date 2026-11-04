import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  WORKERS, bundleFingerprint, comparePaymentBundles, evaluateLocalBuildDirectories,
} from "./compare-payment-worker-builds.mjs";

function fixtures() {
  const expected = { workers: [] };
  const builds = {};
  for (const [index, worker] of WORKERS.entries()) {
    const baseline = Buffer.alloc(1800 + index, 0x61 + index);
    const marker = worker === "afdianpay"
      ? "reconciliation_cycle_outcome" : "waffo_production_outbox_cycle";
    const candidateA = Buffer.concat([Buffer.alloc(1900 + index, 0x72), Buffer.from(marker)]);
    const candidateB = Buffer.from(candidateA);
    expected.workers.push({
      name: worker, bundle_sha256: createHash("sha256").update(baseline).digest("hex"),
    });
    builds[worker] = { baseline, candidateA, candidateB };
  }
  return { expected, builds };
}

test("a previously reviewed baseline and identical candidate builds pass offline", () => {
  const { expected, builds } = fixtures();
  const result = comparePaymentBundles(expected, builds);
  assert.equal(result.passed, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.results.length, 2);
  for (const worker of result.results) {
    assert.equal(worker.baselineReproduced, true);
    assert.equal(worker.candidateDeterministic, true);
    assert.equal(worker.candidateChangePresent, true);
    assert.equal(worker.candidateHasMarker, true);
    assert.equal(worker.baselineHasNoMarker, true);
    assert.match(worker.productionHash, /^[a-f0-9]{64}$/);
  }
});

test("a successful build is still blocked when its historical hash differs", () => {
  const { expected, builds } = fixtures();
  expected.workers[0].bundle_sha256 = "f".repeat(64);
  const result = comparePaymentBundles(expected, builds);
  assert.equal(result.passed, false);
  assert.match(result.blockers.join(";"), /afdianpay: baseline does not reproduce production/);
});

test("non-byte-identical candidates are blocked, even when both build", () => {
  const { expected, builds } = fixtures();
  builds.waffopay.candidateB = Buffer.concat([builds.waffopay.candidateB, Buffer.from(" ")]);
  const result = comparePaymentBundles(expected, builds);
  assert.equal(result.passed, false);
  assert.ok(result.blockers.some(x => x.includes("waffopay: candidate builds")));
});

test("missing heartbeat or old baseline containing new code blocks release", () => {
  const { expected, builds } = fixtures();
  builds.afdianpay.candidateA = Buffer.alloc(1900, 0x78);
  builds.afdianpay.candidateB = Buffer.from(builds.afdianpay.candidateA);
  assert.equal(comparePaymentBundles(expected, builds).passed, false);
  builds.afdianpay.candidateA = Buffer.from(builds.afdianpay.baseline);
  builds.afdianpay.candidateB = Buffer.from(builds.afdianpay.baseline);
  assert.equal(comparePaymentBundles(expected, builds).passed, false);
});

test("missing, oversized, malformed, or extra Worker baselines are rejected", () => {
  const { expected, builds } = fixtures();
  assert.throws(() => bundleFingerprint(Buffer.alloc(999)), /Invalid/);
  assert.throws(() => bundleFingerprint(Buffer.alloc(2_000_001)), /Invalid/);
  assert.throws(() => bundleFingerprint("not-a-buffer"), /Invalid/);
  assert.equal(comparePaymentBundles(null, builds).passed, false);
  assert.equal(comparePaymentBundles({ workers: [] }, builds).passed, false);
  builds.waffopay.candidateA = null;
  assert.equal(comparePaymentBundles(expected, builds).passed, false);
});

test("the actual CLI directory helper only reads the expected local worker.js files", () => {
  const scratch = mkdtempSync(join(tmpdir(), "payment-build-"));
  try {
    const { expected, builds } = fixtures();
    const rootDirs = ["baseline", "candidate-a", "candidate-b"];
    for (const dir of rootDirs) {
      for (const worker of WORKERS) mkdirSync(join(scratch, dir, worker), { recursive: true });
    }
    for (const worker of WORKERS) {
      writeFileSync(join(scratch, "baseline", worker, "worker.js"), builds[worker].baseline);
      writeFileSync(join(scratch, "candidate-a", worker, "worker.js"), builds[worker].candidateA);
      writeFileSync(join(scratch, "candidate-b", worker, "worker.js"), builds[worker].candidateB);
    }
    const manifest = join(scratch, "baseline.json");
    writeFileSync(manifest, JSON.stringify(expected));
    const result = evaluateLocalBuildDirectories({
      baselineRoot: join(scratch, "baseline"),
      candidateRootA: join(scratch, "candidate-a"),
      candidateRootB: join(scratch, "candidate-b"),
      manifestPath: manifest,
    });
    assert.equal(result.passed, true);
    assert.ok(result.results.every(x => x.candidateDeterministic));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("comparison never returns source code or any private Worker data", () => {
  const { expected, builds } = fixtures();
  const result = comparePaymentBundles(expected, builds);
  const output = JSON.stringify(result);
  assert.doesNotMatch(output, /secret|token|sourceCode|credentials/i);
  assert.deepEqual(Object.keys(result), ["passed","results","blockers"]);
});
