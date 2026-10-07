// Offline executable mutation gate. Copies only candidate source and synthetic tests.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = new URL('../../../', import.meta.url);
const files = ['workers/waffopay/worker.js', 'workers/waffopay/production.js', 'workers/waffopay/payment-proof.js',
  'workers/waffopay/production-rpc.js', 'workers/waffopay/production-backend/schema.sql', 'workers/waffopay/production-backend/outbox.sql',
  'tests/waffopay-payment-proof.test.mjs', 'tests/waffopay-production.test.mjs',
  'tests/fixtures/waffo-production-first-payment.json'];
const folder = mkdtempSync(join(tmpdir(), 'waffo-proof-mutations-'));
try {
  for (const dir of ['workers/waffopay/production-backend', 'tests/fixtures']) mkdirSync(join(folder, dir), { recursive: true });
  for (const file of files) copyFileSync(new URL(file, root), join(folder, file));
  writeFileSync(join(folder, 'package.json'), '{"type":"module"}');
  const run = () => spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files.filter(f => f.endsWith('.test.mjs'))],
    { cwd: folder, encoding: 'utf8', timeout: 30000 });
  if (run().status !== 0) throw new Error('Baseline tests failed; mutation result cannot be trusted.');
  const mutations = [];
  const proofFile = 'workers/waffopay/payment-proof.js';
  const proof = readFileSync(join(folder, proofFile), 'utf8');
  // Remove each complete validation call, preserving executable syntax.
  for (let start = proof.indexOf('  requireProof('); start >= 0; start = proof.indexOf('  requireProof(', start + 1)) {
    let depth = 1; let end = start + '  requireProof('.length;
    while (depth && end < proof.length) { if (proof[end] === '(') depth++; if (proof[end] === ')') depth--; end++; }
    const code = proof.slice(start, end).match(/'(proof_[a-z_]+)'\s*\)$/)?.[1];
    if (!code) throw new Error('Unrecognized validator call.');
    mutations.push([`${code}@${start}`, proofFile, proof.slice(0, start) + ';' + proof.slice(end + 1)]);
  }
  for (const [code, file, before, after] of [
    ['graphql_id_scalar', proofFile, '$id: String!, $merchant: String!', '$id: ID!, $merchant: ID!'],
    ['entitlement_gate', 'workers/waffopay/production.js', "payload.entitlement_enabled=env.WAFFO_PRODUCTION_ENTITLEMENT_ENABLED==='true';", 'payload.entitlement_enabled=true;'],
    ['refund_convergence', 'workers/waffopay/production.js', ".filter(r=>r.status==='succeeded')", '.filter(()=>false)'],
    ['refund_pending_retry', 'workers/waffopay/production.js', "if(!result&&event.eventType==='refund.succeeded')throw new ProofError('proof_refund_pending');", ';'],
    ['webhook_fingerprint_conflict', 'workers/waffopay/production.js', 'event_sha256!==fingerprint)', 'event_sha256!==fingerprint&&false)'],
    ['outbox_retry_state', 'workers/waffopay/production.js', "state='pending' AND updated_at<?", "state='delivered' AND updated_at<?"],
    ['rpc_granted_without_payment', 'workers/waffopay/production-rpc.js', "result.entitlementState === 'granted' && !result.paymentConfirmed", 'false'],
    ['rpc_anon_key_reuse', 'workers/waffopay/production-rpc.js', 'key === env.SUPABASE_ANON_KEY', 'false'],
  ]) {
    const source = readFileSync(join(folder, file), 'utf8');
    if (!source.includes(before)) throw new Error('Missing mutation anchor: ' + code);
    // replaceAll: redundant guards (pre-check + post-batch re-read) must fail together.
    mutations.push([code, file, source.replaceAll(before, after)]);
  }
  let rejected = 0;
  for (const [code, file, mutant] of mutations) {
    const path = join(folder, file); const original = readFileSync(path, 'utf8');
    writeFileSync(path, mutant);
    const outcome = run();
    writeFileSync(path, original);
    if (outcome.status === null || outcome.error) throw new Error(`Mutation ${code} did not complete.`);
    // Infrastructure/syntax failures are not valid detection evidence.
    if (/SyntaxError|ERR_MODULE_NOT_FOUND/.test(outcome.stderr + outcome.stdout)) throw new Error(`Invalid mutation: ${code}`);
    if (outcome.status === 0) throw new Error(`DANGEROUS MUTATION SURVIVED: ${code}`);
    rejected++;
  }
  console.log(`Production proof dangerous mutations rejected: ${rejected}/${mutations.length}`);
} finally { rmSync(folder, { recursive: true, force: true }); }
