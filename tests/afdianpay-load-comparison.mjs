// Run: node tests/afdianpay-load-comparison.mjs
// Synthetic HTTP/RPC model only. The real SQL admission/concurrency suite is separate.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

const BASELINE = '94be7928a7ba6ed4108359d21e577a1e5d905958';
const START = Date.parse('2026-10-11T00:00:00.000Z');
const RealDate = Date;
let clock = START;
const env = { SUPABASE_URL: 'https://synthetic-db.invalid', SUPABASE_KEY: 'mock', USER_ID: 'synthetic', TOKEN: 'mock' };
const facts = Array.from({ length: 12 }, (_, index) => ({
  out_trade_no: `synthetic_${String(index).padStart(2, '0')}`, plan_id: 'synthetic-plan',
  product_type: 0, total_amount: '15.00', status: 2, pay_time: START / 1000 - 3600,
  custom_order_id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
}));
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

function model(after) {
  const rows = new Map(facts.map((fact, index) => [fact.out_trade_no, {
    order_id: fact.out_trade_no, status: index < 4 ? 'activated' : 'unresolved',
    nextRetry: index >= 8 ? START - 1 : null, verifiedAt: START - 1000,
    lastSeen: START - 1000, error: index >= 4 && index < 8 ? 'INVALID_BINDING' : null,
    leaseUntil: 0, token: null, attempts: 0,
  }]));
  const scans = new Map();
  const counts = { databaseRequests: 0, rpcRequests: 0, externalCalls: 0,
    processed: 0, transitions: {}, byOrder: {}, byRpc: {}, perInvocation: [] };
  function process(observation) {
    const row = rows.get(observation.order_id);
    const transition = `${row.status} → ${row.status}`;
    counts.processed++;
    counts.transitions[transition] = (counts.transitions[transition] || 0) + 1;
    counts.byOrder[row.order_id] = (counts.byOrder[row.order_id] || 0) + 1;
    row.verifiedAt = row.lastSeen = clock;
    row.nextRetry = row.status === 'unresolved' && row.error === null ? clock + 120_000 : null;
    row.attempts++;
    return { status: row.status, state_before: row.status, state_after: row.status, attempt_count: row.attempts };
  }
  return { counts, async fetch(input, init) {
    const url = new URL(input);
    if (url.hostname === 'ifdian.net') {
      counts.externalCalls++;
      const params = JSON.parse(JSON.parse(init.body).params);
      return json({ ec: 200, data: { total_page: 1,
        list: params.out_trade_no ? facts.filter(fact => fact.out_trade_no === params.out_trade_no) : facts } });
    }
    assert.equal(url.hostname, 'synthetic-db.invalid', 'No real network access allowed');
    counts.databaseRequests++;
    if (url.pathname.endsWith('/pro_payment_orders')) {
      return json([...rows.values()].filter(row => row.status === 'unresolved' && row.nextRetry !== null && row.nextRetry <= clock)
        .sort((a, b) => a.nextRetry - b.nextRetry).slice(0, 8).map(row => ({ order_id: row.order_id })));
    }
    counts.rpcRequests++;
    const name = url.pathname.split('/').at(-1);
    counts.byRpc[name] = (counts.byRpc[name] || 0) + 1;
    const args = JSON.parse(init.body);
    switch (name) {
      case 'sunland_get_pro_payment_backoff': return json({ retry_after_seconds: 0 });
      case 'sunland_claim_pro_payment_scan': {
        const previous = scans.get(args.p_state_key);
        const cooldown = args.p_state_key === 'history' ? 0 : 20_000;
        if (previous && (previous.leaseUntil > clock || previous.success + cooldown > clock)) return json({ acquired: false });
        const state = { token: webcrypto.randomUUID(), generation: (previous?.generation || 0) + 1,
          leaseUntil: clock + (after ? 180_000 : 30_000), success: previous?.success ?? -Infinity };
        scans.set(args.p_state_key, state);
        return json({ acquired: true, next_page: 1, lease_token: state.token, generation: state.generation });
      }
      case 'sunland_complete_pro_payment_scan': {
        const state = scans.get(args.p_state_key);
        assert.equal(args.p_lease_token, state.token);
        assert.equal(args.p_generation, state.generation);
        assert.ok(state.leaseUntil > clock);
        state.leaseUntil = 0;
        state.success = clock;
        return json({ advanced: true });
      }
      case 'sunland_release_pro_payment_scan': return json({ released: true });
      case 'sunland_record_pro_payment_hints': return json({ recorded: args.p_order_ids.length });
      case 'sunland_claim_pro_payment_order_query': {
        const row = rows.get(args.p_order_id);
        const due = row.status === 'activated' ? row.lastSeen + 20_000 : row.nextRetry;
        if (row.leaseUntil > clock || row.status === 'ineligible' || row.error || due === null || due > clock) {
          return json({ acquired: false, status: row.status });
        }
        row.lastSeen = clock;
        row.nextRetry = clock + (after ? 120_000 : 20_000);
        row.token = webcrypto.randomUUID();
        row.leaseUntil = after ? clock + 120_000 : 0;
        return json({ acquired: true, status: row.status, lease_token: row.token });
      }
      case 'sunland_process_verified_pro_order': return json(process(args.p_order));
      case 'sunland_finish_pro_payment_order_query': {
        const row = rows.get(args.p_order.order_id);
        if (args.p_lease_token !== row.token || row.leaseUntil <= clock) return json({ status: row.status, reason_code: 'LEASE_FENCED' });
        const result = process(args.p_order);
        row.leaseUntil = 0;
        row.token = null;
        return json(result);
      }
      case 'sunland_process_pro_payment_scan_orders': {
        // These facts remain unchanged: activated/blocked rows recheck daily;
        // actionable unresolved rows obey their durable due date. SQL tests cover changes.
        const admitted = args.p_orders.filter(observation => {
          const row = rows.get(observation.order_id);
          return row.leaseUntil <= clock && ((row.status === 'unresolved' && row.nextRetry !== null && row.nextRetry <= clock)
            || ((row.status !== 'unresolved' || row.nextRetry === null) && row.verifiedAt <= clock - 86_400_000));
        }).slice(0, 8);
        return json({ processed: admitted.length, skipped: args.p_orders.length - admitted.length, results: admitted.map(process) });
      }
      default: throw new Error(`Unexpected mock RPC: ${name}`);
    }
  } };
}

async function run(source, after) {
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const mock = model(after);
  globalThis.fetch = mock.fetch;
  const startCpu = process.cpuUsage();
  for (let invocation = 0; invocation < 4; invocation++) {
    clock = START + invocation * 30_000;
    const before = { databaseRequests: mock.counts.databaseRequests, rpcRequests: mock.counts.rpcRequests,
      externalCalls: mock.counts.externalCalls, processed: mock.counts.processed };
    await module.default.scheduled({ cron: '* * * * *', scheduledTime: clock }, env);
    mock.counts.perInvocation.push(Object.fromEntries(Object.keys(before).map(key => [key, mock.counts[key] - before[key]])));
  }
  const cpu = process.cpuUsage(startCpu);
  return { ...mock.counts, nodeSyntheticCpuMicroseconds: cpu.user + cpu.system };
}

const original = { fetch: globalThis.fetch, cryptoDescriptor: Object.getOwnPropertyDescriptor(globalThis, 'crypto'), Date: globalThis.Date, log: console.log };
let result;
try {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  };
  console.log = () => {};
  const beforeSource = execFileSync('git', ['show', `${BASELINE}:workers/afdianpay/worker.js`], { encoding: 'utf8' });
  const afterSource = await readFile(new URL('../workers/afdianpay/worker.js', import.meta.url), 'utf8');
  const before = await run(beforeSource, false);
  const after = await run(afterSource, true);
  assert.equal(before.processed, 68);
  assert.equal(before.databaseRequests, 112);
  assert.equal(before.externalCalls, 12);
  assert.equal(before.transitions['unresolved → unresolved'], 36);
  assert.equal(before.transitions['activated → activated'], 32);
  assert.equal(after.processed, 4);
  assert.ok(Object.values(after.byOrder).every(count => count <= 1));
  assert.equal(after.externalCalls, 4);
  assert.ok(after.databaseRequests < before.databaseRequests);
  result = { baseline: BASELINE, invocations: 4, intervalSeconds: 30, syntheticOrderCount: facts.length,
    scope: '合成 HTTP/RPC 模型；非生产测量；不证明真实 SQL 并发正确性',
    cpuScope: 'Node process.cpuUsage，包含 Mock、JSON 与 Response 成本，不能等同 Cloudflare CPU 或用于声称生产改善百分比',
    before, after };
} finally {
  globalThis.fetch = original.fetch;
  if (original.cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', original.cryptoDescriptor);
  else delete globalThis.crypto;
  globalThis.Date = original.Date;
  console.log = original.log;
}
console.log(JSON.stringify(result, null, 2));
