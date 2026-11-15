import test from "node:test";
import assert from "node:assert/strict";
import {
  sha256,
  assessCompiledPaymentWorker,
  inspectCompiledPaymentBuilds,
  formatBuildCheck,
} from "./verify-payment-bundle-build.mjs";

const mainAfd = Buffer.from("export default {scheduled() { return true; }};\n");
const candAfd = Buffer.from("export default {scheduled() { const event='reconciliation_cycle_outcome'; return true; }};\n");
const mainWaffo = Buffer.from("export default {scheduled() { return 1; }};\n");
const candWaffo = Buffer.from("export default {scheduled() { const event='waffo_production_outbox_cycle'; return 1; }};\n");
const afdian = {name:"afdianpay",bundle_sha256:sha256(mainAfd)};
const waffo = {name:"waffopay",bundle_sha256:sha256(mainWaffo)};

test("correctly classifies a reproducible main and changed heartbeat candidate", () => {
  const checks = inspectCompiledPaymentBuilds(
    {workers:[afdian,waffo]},
    {
      afdianpay:{main:mainAfd,candidate:candAfd},
      waffopay:{main:mainWaffo,candidate:candWaffo},
    },
  );
  assert.equal(checks.length,2);
  assert.ok(checks.every(c=>c.accepted && c.baselineMatch && c.candidateChanged && c.markerPresent));
  for (const c of checks) assert.match(formatBuildCheck(c), /^PASS /);
});

test("rejects main bundle that cannot reproduce the reviewed production SHA", () => {
  const changed = Buffer.from("different main even if candidate builds");
  const check = assessCompiledPaymentWorker(afdian,changed,candAfd);
  assert.equal(check.baselineMatch,false);
  assert.equal(check.accepted,false);
  assert.match(formatBuildCheck(check),/^BLOCKED /);
});

test("rejects a candidate identical to baseline or lacking the heartbeat", () => {
  const same = assessCompiledPaymentWorker(afdian,mainAfd,mainAfd);
  assert.equal(same.candidateChanged,false);
  assert.equal(same.accepted,false);
  const missing = assessCompiledPaymentWorker(afdian,mainAfd,Buffer.from("no heartbeat here"));
  assert.equal(missing.markerPresent,false);
  assert.equal(missing.accepted,false);
});

test("rejects unknown names, invalid hashes, empty builds and incomplete baseline", () => {
  assert.throws(()=>assessCompiledPaymentWorker({name:"other",bundle_sha256:sha256(mainAfd)},mainAfd,candAfd),/baseline/);
  assert.throws(()=>assessCompiledPaymentWorker({name:"afdianpay",bundle_sha256:"bad"},mainAfd,candAfd),/baseline/);
  assert.throws(()=>assessCompiledPaymentWorker(afdian,Buffer.alloc(0),candAfd),/missing/);
  assert.throws(()=>inspectCompiledPaymentBuilds({workers:[afdian]},{}),/baseline/);
  assert.throws(()=>inspectCompiledPaymentBuilds({workers:[afdian,waffo]},{}),/missing/);
});

test("reports only fixed diagnostic names and SHA hashes, never compiled source", () => {
  const secretMarker="PRIVATE_PLACEHOLDER_THAT_MUST_NOT_APPEAR_IN_REPORT";
  const secretMain=Buffer.from(secretMarker);
  const expected={...afdian,bundle_sha256:sha256(secretMain)};
  const result=assessCompiledPaymentWorker(
    expected,
    secretMain,
    Buffer.from("reconciliation_cycle_outcome "+secretMarker),
  );
  assert.doesNotMatch(formatBuildCheck(result),new RegExp(secretMarker));
  assert.match(formatBuildCheck(result),/[0-9a-f]{64}/);
});
