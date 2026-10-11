// Explicit local-only PostgreSQL multi-connection lab. No provider/production traffic.
// Run: AFDIAN_DOCKER_PG=true node tests/afdianpay-concurrency-lab.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

if (process.env.AFDIAN_DOCKER_PG !== 'true') throw new Error('Set AFDIAN_DOCKER_PG=true to authorize this isolated local lab');
const runId = randomUUID();
const name = `afdian-admission-lab-${runId}`;
const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
function command(args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(errors.trim() || `Docker exited ${code}`)));
    child.stdin.end(input);
  });
}
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const trace = randomUUID();
const references = new Map();
const proof = (id, patch = {}) => ({ provider: 'afdian', order_id: id, payment_status: 'paid',
  plan_id: '16b23966c0a711f183dc5254001e7c00', product_type: 1, amount_cents: 1500,
  total_amount: '15.00', currency: 'CNY', binding_reference: references.get(id), binding_source: 'intent', paid_at: null,
  sku_detail: [{ sku_id: '16b98478c0a711f1bb735254001e7c00', count: 1 }], ...patch });
let container; let checks = 0;
const sql = statement => command(['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1'],
  `set statement_timeout='15s'; set lock_timeout='10s'; ${statement}`);
const result = async statement => JSON.parse((await sql(statement)).split('\n').filter(Boolean).at(-1));
const batchSql = (orders, source = 'cron_recent') => `select sunland_process_pro_payment_scan_orders(${quote(JSON.stringify(orders))}::jsonb,${quote(source)},${quote(trace)}::uuid);`;
const claimSql = id => `select sunland_claim_pro_payment_order_query(${quote(id)});`;
const finishSql = (id, token) => `select sunland_finish_pro_payment_order_query(${quote(JSON.stringify(proof(id)))}::jsonb,'webhook',${quote(trace)}::uuid,${quote(token)}::uuid);`;
const failSql = (id, token) => `select sunland_fail_pro_payment_order_query(${quote(id)},'PROVIDER_QUERY_FAILED','webhook',${quote(trace)}::uuid,${quote(token)}::uuid);`;
const fixture = async id => {
  const reference = randomUUID(); references.set(id, reference);
  await sql(`insert into user_profiles(user_id) values(${quote(id)});
    insert into pro_payment_intents(payment_reference,user_id) values(${quote(reference)}::uuid,${quote(id)});
    select sunland_record_pro_payment_hints(array[${quote(id)}],'cron_recent',${quote(trace)}::uuid);`);
};
const count = async (table, id) => Number(await sql(`select count(*) from ${table} where order_id=${quote(id)};`));
const check = (condition, message) => { assert.ok(condition, message); checks++; };
try {
  container = await command(['run', '-d', '--name', name, '--label', `afdian-admission-owner=${runId}`,
    '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
    'public.ecr.aws/docker/library/postgres:16-alpine']);
  let ready = false;
  for (let i = 0; i < 40; i++) {
    // The image's bootstrap server uses only a Unix socket and is restarted.
    // Wait for the final server's loopback listener before opening test sessions.
    try { await command(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); ready = true; break; }
    catch { await delay(100); }
  }
  assert.ok(ready, 'Owned PostgreSQL container did not become ready');
  const base = await read('supabase/migrations/20260905014430_pro_payment_activation_reliability.sql');
  await sql(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema extensions; create function extensions.gen_random_uuid() returns uuid language sql as $$select gen_random_uuid()$$;
    create schema auth; create function auth.jwt() returns jsonb language sql as $$select '{}'::jsonb$$;
    create table public.user_profiles(user_id text primary key,pro boolean default false,
      identity_status text default 'active',is_banned boolean default false,updated_at timestamptz default now());
    create table public.pro_activations(id uuid default gen_random_uuid(),user_id text,source text,order_id text unique,
      activated_at timestamptz default now(),created_at timestamptz default now());
    grant select,insert,update on public.user_profiles,public.pro_activations to service_role;
    ${base.slice(base.indexOf('create table'), base.indexOf('create or replace function'))}
    ${await read('tests/fixtures/waffo-legacy-payment-rpc.sql')}
    ${await read('workers/afdianpay/merchandise-backend/live-rpc-baseline.sql')}
    ${await read('workers/afdianpay/merchandise-backend/live-deletion-baseline.sql')}
    create trigger pro_payment_orders_serialize_insert before insert on public.pro_payment_orders
      for each row execute function public.sunland_serialize_pro_payment_order_insert();
    begin;
    ${await read('supabase/migrations/20261002071010_waffo_production_entitlement_sources.sql')}
    commit;
    ${await read('supabase/migrations/20261005122300_afdian_merchandise_verified_reconciliation.sql')}
    ${await read('supabase/migrations/20261011030000_afdian_scan_admission.sql')}`);

  const overlap = 'concurrency-overlap-1'; await fixture(overlap);
  // Hold the shared lock in one transaction while the second independently waits.
  const first = result(`begin; select pg_advisory_xact_lock(20261011,30000);
    select pg_advisory_xact_lock(hashtext(${quote(overlap)}));
    select pg_sleep(0.8); ${batchSql([proof(overlap)])} commit;`);
  await delay(100);
  const second = result(batchSql([proof(overlap)], 'cron_history'));
  await delay(100);
  check(Number(await sql("select count(*) from pg_stat_activity where wait_event='advisory';")) >= 1,
    'Independent transaction was observed waiting for the shared advisory lock');
  const overlapResults = await Promise.all([first, second]);
  check(overlapResults.reduce((n, r) => n + r.processed, 0) === 1, 'Overlapping recent/history scans processed once');
  check(await count('pro_activations', overlap) === 1, 'Contended payment authorized once');

  const claimed = 'concurrency-claimed-2'; await fixture(claimed);
  const claims = await Promise.all(Array.from({ length: 10 }, () => result(claimSql(claimed))));
  check(claims.filter(r => r.acquired).length === 1, 'Ten independent query claims produce one owner');
  const owner = claims.find(r => r.acquired);
  check((await result(batchSql([proof(claimed)]))).processed === 0, 'Scan respects concurrent query lease');
  check((await result(finishSql(claimed, owner.lease_token))).status === 'activated', 'Query owner safely activates');

  for (let i = 0; i < 8; i++) {
    const id = `concurrency-query-scan-${i}`; await fixture(id);
    const [scan, lease] = await Promise.all([result(batchSql([proof(id)])), result(claimSql(id))]);
    if (lease.acquired) await result(finishSql(id, lease.lease_token));
    check(scan.processed === 1 || lease.acquired, 'Scan/query race retains a successful processor');
    check(await count('pro_activations', id) === 1, 'Scan/query race does not duplicate authority');
  }

  for (const key of ['recent', 'history', 'retry']) {
    const leases = await Promise.all(Array.from({ length: 6 }, () => result(`select sunland_claim_pro_payment_scan(${quote(key)});`)));
    check(leases.filter(r => r.acquired).length === 1, `${key} lane has one owner across six connections`);
  }

  const stale = 'concurrency-stale-3'; await fixture(stale); const old = await result(claimSql(stale));
  await sql(`update pro_payment_order_query_leases set lease_until=now()-interval '1 second' where order_id=${quote(stale)};
    update pro_payment_orders set next_retry_at=now()-interval '1 second' where order_id=${quote(stale)};`);
  const replacement = await result(claimSql(stale));
  const fenced = await Promise.all([result(finishSql(stale, old.lease_token)), result(failSql(stale, old.lease_token))]);
  check(fenced.every(r => r.reason_code === 'LEASE_FENCED'), 'Old finish/fail tokens cannot touch replacement lease');
  check((await result(finishSql(stale, replacement.lease_token))).status === 'activated', 'Replacement retains its authority');
  check(await count('pro_activations', stale) === 1, 'Fenced lease replacement activates once');

  const reversed = [];
  for (let i = 0; i < 12; i++) { const id = `concurrency-reversed-${i}`; await fixture(id); reversed.push(proof(id)); }
  const batches = await Promise.all([result(batchSql(reversed)), result(batchSql([...reversed].reverse(), 'cron_history'))]);
  check(batches.reduce((n, r) => n + r.processed, 0) === 12, 'Reverse page order has no deadlock and processes all twelve');
  for (const o of reversed) check(await count('pro_activations', o.order_id) === 1, 'Reverse order batch grant is unique');

  // Disjoint order sets can still share user/profile locks in reverse order.
  // Slow the first grant in each batch to make the potential lock cycle observable.
  await fixture('concurrency-owner-A'); await fixture('concurrency-owner-B');
  const userA = references.get('concurrency-owner-A'); const userB = references.get('concurrency-owner-B');
  const userOrders = ['concurrency-user-a1', 'concurrency-user-a2', 'concurrency-user-b1', 'concurrency-user-b2'];
  for (const [i, id] of userOrders.entries()) {
    references.set(id, [userA, userB, userB, userA][i]);
    await sql(`select sunland_record_pro_payment_hints(array[${quote(id)}],'cron_recent',${quote(trace)}::uuid);`);
  }
  await sql(`create function public.admission_slow_grant() returns trigger language plpgsql as $$begin
    if new.order_id in ('concurrency-user-a1','concurrency-user-b1') and new.status='activated' then
      perform pg_sleep(0.6); end if; return new; end;$$;
    create trigger admission_slow_grant before update on pro_payment_orders for each row execute function public.admission_slow_grant();`);
  const userFirst = result(batchSql(userOrders.slice(0, 2).map(id => proof(id))));
  await delay(100);
  const userSecond = result(batchSql(userOrders.slice(2).map(id => proof(id)), 'cron_history'));
  await delay(100);
  check(Number(await sql("select count(*) from pg_locks where locktype='advisory' and classid=20261011 and objid=30000 and objsubid=2 and not granted;")) >= 1,
    'Disjoint reverse-user batch waits for the database batch lock before taking any order/user lock');
  const userBatches = await Promise.all([userFirst, userSecond]);
  check(userBatches.every(r => r.processed === 2), 'Reverse user binding batches complete without a deadlock');
  // already_pro records the payment source without another profile activation log.
  for (const id of userOrders) check(Number(await sql(`select count(*) from waffo_prod.entitlement_sources
    where provider='other' and source_id=${quote(`payment:${id}`)} and active;`)) === 1,
  'Shared-user distinct orders each retain one active payment source');
  await sql('drop trigger admission_slow_grant on pro_payment_orders; drop function public.admission_slow_grant();');
  console.log(`Afdian isolated PostgreSQL 16 concurrency: ${checks} checks passed across independent connections.`);
} finally {
  if (container) {
    const ownership = await command(['inspect', '--format', '{{index .Config.Labels "afdian-admission-owner"}}', container]);
    if (ownership !== runId) throw new Error('Refusing to remove a container not owned by this test run');
    await command(['rm', '-f', container]);
    console.log('Owned temporary PostgreSQL container removed. Existing containers untouched.');
  }
}
