// Synthetic, isolated PostgreSQL only. Never reads credentials or calls a provider.
// AFDIAN_PGLITE_PATH=/tmp/.../pglite/dist/index.js node --test this-file
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { canonicalAfdianProof, MERCHANDISE } from '../workers/afdianpay/merchandise-backend/worker-proof.DRAFT.mjs';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const migration = await read('supabase/migrations/20261011030000_afdian_scan_admission.sql');
let PGlite;
try {
  ({ PGlite } = await import(process.env.AFDIAN_PGLITE_PATH
    ? pathToFileURL(process.env.AFDIAN_PGLITE_PATH).href : '@electric-sql/pglite'));
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}

test('admission migration keeps protected grants and existing verified transaction untouched', () => {
  assert.doesNotMatch(migration, /create (?:or replace )?function public\.sunland_(?:process_verified_pro_order|activate_pro_from_payment|waffo_)/);
  assert.match(migration, /enable row level security/);
  for (const name of ['sunland_finish_pro_payment_order_query', 'sunland_fail_pro_payment_order_query', 'sunland_process_pro_payment_scan_orders']) {
    assert.match(migration, new RegExp(`revoke all on function public\\.${name}\\([^;]+from public, anon, authenticated`));
    assert.match(migration, new RegExp(`grant execute on function public\\.${name}\\([^;]+to service_role`));
  }
  assert.doesNotMatch(migration, /pro\s*=\s*false|security definer/i);
  const batch = migration.slice(migration.indexOf('create function public.sunland_process_pro_payment_scan_orders'));
  assert.ok(batch.indexOf('pg_advisory_xact_lock(20261011, 30000)') < batch.indexOf('pg_advisory_xact_lock(hashtext(v_id))'));
});

test('synthetic PostgreSQL scan admission and fenced order queries', {
  skip: PGlite ? false : 'Set AFDIAN_PGLITE_PATH to an installed PGlite runtime to run isolated SQL checks',
}, async t => {
  const db = new PGlite();
  const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const trace = uuid(99999);
  const query = async (sql, args = []) => (await db.query(sql, args)).rows;
  const call = async (name, args, casts) => (await query(`select public.${name}(${casts.map((cast, i) => `$${i + 1}::${cast}`).join(',')}) result`, args))[0].result;
  const proof = (n, patch = {}) => canonicalAfdianProof({ out_trade_no: `admission-order-${n}`, status: 2,
    product_type: 1, plan_id: MERCHANDISE.planId, total_amount: '15.00', custom_order_id: uuid(n),
    sku_detail: [{ sku_id: MERCHANDISE.skuId, count: 1 }], ...patch });
  const fixture = async n => {
    await query('insert into public.user_profiles(user_id) values($1)', [`buyer-${n}`]);
    await query('insert into public.pro_payment_intents(payment_reference,user_id) values($1::uuid,$2)', [uuid(n), `buyer-${n}`]);
  };
  const hints = orders => call('sunland_record_pro_payment_hints', [orders.map(o => o.order_id), 'cron_recent', trace], ['text[]', 'text', 'uuid']);
  const scan = (orders, source = 'cron_recent') => call('sunland_process_pro_payment_scan_orders', [JSON.stringify(orders), source, trace], ['jsonb', 'text', 'uuid']);
  const claim = id => call('sunland_claim_pro_payment_order_query', [id], ['text']);
  const finish = (o, token) => call('sunland_finish_pro_payment_order_query', [JSON.stringify(o), 'webhook', trace, token], ['jsonb', 'text', 'uuid', 'uuid']);
  const fail = (id, token) => call('sunland_fail_pro_payment_order_query', [id, 'PROVIDER_QUERY_FAILED', 'webhook', trace, token], ['text', 'text', 'text', 'uuid', 'uuid']);
  const row = async id => (await query('select * from public.pro_payment_orders where order_id=$1', [id]))[0];
  const due = id => query("update public.pro_payment_orders set next_retry_at=now()-interval '1 second' where order_id=$1", [id]);
  const periodicDue = id => query("update public.pro_payment_orders set last_verified_at=now()-interval '25 hours' where order_id=$1", [id]);
  const pro = async n => (await query('select pro from public.user_profiles where user_id=$1', [`buyer-${n}`]))[0].pro;
  try {
    const base = await read('supabase/migrations/20260905014430_pro_payment_activation_reliability.sql');
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
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
      ${await read('supabase/migrations/20261002071010_waffo_production_entitlement_sources.sql')}
      ${await read('supabase/migrations/20261005122300_afdian_merchandise_verified_reconciliation.sql')}`);
    const protectedSql = `select oid::regprocedure::text signature, pg_get_functiondef(oid) definition from pg_proc
      where pronamespace='public'::regnamespace and (proname='sunland_process_verified_pro_order'
      or proname='sunland_activate_pro_from_payment' or proname like 'sunland_waffo_%') order by 1`;
    const protectedBefore = await query(protectedSql);
    await db.exec(migration);
    assert.deepEqual(await query(protectedSql), protectedBefore);

    await t.test('new paid order activates once; duplicate recent/history batches do not write', async () => {
      await fixture(1); const o = proof(1); await hints([o]);
      assert.equal((await scan([o])).results[0].status, 'activated');
      const before = await row(o.order_id);
      for (let i = 0; i < 8; i++) assert.equal((await scan([o], i % 2 ? 'cron_history' : 'cron_recent')).processed, 0);
      assert.deepEqual(await row(o.order_id), before);
      assert.equal(await pro(1), true);
      assert.equal((await query('select count(*)::int n from pro_activations where order_id=$1', [o.order_id]))[0].n, 1);
    });
    await t.test('unresolved before due is skipped; later missing intent automatically recovers', async () => {
      const o = proof(2); await hints([o]);
      assert.equal((await scan([o])).results[0].reason_code, 'INTENT_NOT_FOUND');
      const before = await row(o.order_id); await fixture(2);
      assert.equal((await scan([o])).processed, 0); assert.deepEqual(await row(o.order_id), before);
      await due(o.order_id); assert.equal((await scan([o])).results[0].status, 'activated');
      assert.equal(await pro(2), true);
    });
    await t.test('active query lease fences both scans and duplicate claims', async () => {
      await fixture(3); const o = proof(3); await hints([o]);
      const lease = await claim(o.order_id); assert.equal(lease.acquired, true);
      const before = await row(o.order_id);
      assert.equal((await claim(o.order_id)).acquired, false);
      assert.equal((await scan([o])).processed, 0); assert.deepEqual(await row(o.order_id), before);
      assert.equal((await finish(o, lease.lease_token)).status, 'activated');
    });
    await t.test('lost success response replay reports durable status without granting or writing twice', async () => {
      await fixture(4); const o = proof(4); await hints([o]); const lease = await claim(o.order_id);
      await finish(o, lease.lease_token); const before = await row(o.order_id);
      assert.equal((await finish(o, lease.lease_token)).status, 'activated');
      assert.equal((await finish(o, lease.lease_token)).reason_code, 'LEASE_FENCED');
      assert.deepEqual(await row(o.order_id), before);
      assert.equal((await query('select count(*)::int n from pro_activations where order_id=$1', [o.order_id]))[0].n, 1);
    });
    await t.test('expired tokens cannot commit or fail a newly claimed lease', async () => {
      await fixture(5); const o = proof(5); await hints([o]); const first = await claim(o.order_id);
      await query("update pro_payment_order_query_leases set lease_until=now()-interval '1 second' where order_id=$1", [o.order_id]);
      assert.equal((await finish(o, first.lease_token)).reason_code, 'LEASE_FENCED'); await due(o.order_id);
      const second = await claim(o.order_id); assert.notEqual(second.lease_token, first.lease_token);
      assert.equal((await fail(o.order_id, first.lease_token)).recorded, false);
      assert.equal((await finish(o, first.lease_token)).reason_code, 'LEASE_FENCED');
      assert.equal((await finish(o, second.lease_token)).status, 'activated');
    });
    await t.test('provider failure releases only owned lease and preserves scheduled recovery', async () => {
      await fixture(6); const o = proof(6); await hints([o]); const lease = await claim(o.order_id);
      await fail(o.order_id, lease.lease_token);
      assert.equal((await row(o.order_id)).status, 'unresolved'); assert.equal(await pro(6), false);
      assert.equal((await scan([o])).processed, 0); await due(o.order_id);
      assert.equal((await scan([o])).results[0].status, 'activated');
    });
    await t.test('refund/cancel/unknown facts are admitted immediately and never revoke Pro', async () => {
      for (const [n, status] of [[7, 'refunded'], [8, 'cancelled'], [9, 0]]) {
        await fixture(n); const o = proof(n); await hints([o]); await scan([o]);
        const changed = proof(n, { status }); assert.equal((await scan([changed])).processed, 1);
        assert.equal((await row(o.order_id)).payment_status, changed.payment_status); assert.equal(await pro(n), true);
        const before = await row(o.order_id); assert.equal((await scan([changed])).processed, 0);
        assert.deepEqual(await row(o.order_id), before);
      }
      const refunded = proof(7); const tombstone = await row(refunded.order_id);
      assert.equal((await scan([refunded])).processed, 0);
      assert.deepEqual(await row(refunded.order_id), tombstone);
    });
    await t.test('binding/product conflicts reach verified guard once and stay blocked until periodic check', async () => {
      await fixture(10); const o = proof(10); await hints([o]); await scan([o]);
      const changed = { ...o, amount_cents: 1600, total_amount: '16.00' };
      assert.equal((await scan([changed])).results[0].reason_code, 'PROVIDER_FACT_CONFLICT');
      const before = await row(o.order_id); assert.equal((await scan([changed])).processed, 0);
      assert.deepEqual(await row(o.order_id), before); assert.equal(await pro(10), true);
      await periodicDue(o.order_id); assert.equal((await scan([changed])).processed, 1);
    });
    await t.test('all page hints remain durable; bounded eight-order batches eventually process tail', async () => {
      const orders = [];
      for (let n = 20; n < 38; n++) { await fixture(n); orders.push(proof(n)); }
      await hints(orders);
      assert.equal((await scan(orders)).processed, 8);
      const deferred = await query("select order_id from pro_payment_orders where order_id=any($1::text[]) and status='unresolved' and next_retry_at<=clock_timestamp()", [orders.map(o => o.order_id)]);
      assert.equal(deferred.length, 10);
      assert.equal((await scan(orders)).processed, 8);
      assert.equal((await scan(orders)).processed, 2); assert.equal((await scan(orders)).processed, 0);
      for (let n = 20; n < 38; n++) assert.equal(await pro(n), true);
    });
    await t.test('daily historical recheck rotates by oldest verification; equivalent timestamps do not trigger', async () => {
      const orders = Array.from({ length: 18 }, (_, i) => proof(i + 20));
      for (const o of orders) await periodicDue(o.order_id);
      const first = await scan(orders, 'cron_history'); assert.equal(first.processed, 8);
      const second = await scan(orders, 'cron_history'); assert.equal(second.processed, 8);
      assert.equal(first.results.some(a => second.results.some(b => a.order_id === b.order_id)), false);
      assert.equal((await scan(orders, 'cron_history')).processed, 2);
      await fixture(40); const timestamped = proof(40, { pay_time: 1780000000 }); await hints([timestamped]);
      await scan([timestamped]); assert.equal((await scan([timestamped])).processed, 0);
    });
    await t.test('invalid observations cannot change activated rows or write blocked hints repeatedly', async () => {
      const o = proof(1); const bad = { provider: 'afdian', order_id: o.order_id, validation_error: 'INVALID_BINDING' };
      const before = await row(o.order_id); assert.equal((await scan([bad])).processed, 0);
      assert.deepEqual(await row(o.order_id), before);
      const marker = { provider: 'afdian', order_id: 'invalid-observation-50', validation_error: 'INVALID_PRODUCT' };
      await hints([marker]); assert.equal((await scan([marker])).processed, 1);
      const blocked = await row(marker.order_id); assert.equal(blocked.next_retry_at, null);
      assert.equal((await scan([marker])).processed, 0); assert.deepEqual(await row(marker.order_id), blocked);
    });
    await t.test('database commit failures rollback ledger, lease, grant and preserve recovery', async () => {
      await fixture(51); const o = proof(51); await hints([o]); const lease = await claim(o.order_id);
      await db.exec(`create function public.admission_injected_failure() returns trigger language plpgsql as $$begin
        if new.order_id='admission-order-51' and new.status='activated' then raise exception 'INJECTED_LEDGER_FAILURE'; end if; return new; end;$$;
        create trigger admission_failure before update on pro_payment_orders for each row execute function public.admission_injected_failure();`);
      await assert.rejects(() => finish(o, lease.lease_token), /INJECTED_LEDGER_FAILURE/);
      assert.equal(await pro(51), false); assert.equal((await row(o.order_id)).status, 'unresolved');
      assert.equal((await query('select count(*)::int n from pro_payment_order_query_leases where order_id=$1', [o.order_id]))[0].n, 1);
      await db.exec('drop trigger admission_failure on pro_payment_orders; drop function public.admission_injected_failure();');
      assert.equal((await finish(o, lease.lease_token)).status, 'activated');
    });
    await t.test('scan leases fence stale completion, persist cursors and throttle duplicate retry schedulers', async () => {
      const scanClaim = key => call('sunland_claim_pro_payment_scan', [key], ['text']);
      const complete = (key, lease, page = 1, total = 1) => call('sunland_complete_pro_payment_scan',
        [key, lease.lease_token, lease.generation, page, total, []], ['text', 'uuid', 'bigint', 'integer', 'integer', 'text[]']);
      const first = await scanClaim('history'); assert.equal(first.acquired, true);
      assert.equal((await scanClaim('history')).acquired, false);
      assert.equal((await complete('history', first, 2, 3)).advanced, true);
      const second = await scanClaim('history'); assert.equal(second.next_page, 2);
      assert.equal((await complete('history', first, 2, 3)).advanced, false);
      assert.equal((await complete('history', second, 3, 3)).advanced, true);
      const retry = await scanClaim('retry'); assert.equal(retry.acquired, true);
      assert.equal((await complete('retry', retry)).advanced, true);
      assert.equal((await scanClaim('retry')).acquired, false);
      const recent = await scanClaim('recent');
      const seconds = (await query("select extract(epoch from lease_until-clock_timestamp())::int n from pro_payment_reconciliation_state where state_key='recent'"))[0].n;
      assert.ok(seconds >= 175 && seconds <= 180); assert.equal(recent.acquired, true);
    });
    await t.test('committed batch survives expired cursor lease; replacement scanner replays without writes', async () => {
      await fixture(52); const o = proof(52); await hints([o]);
      const first = await call('sunland_claim_pro_payment_scan', ['history'], ['text']);
      // The preceding case intentionally has a pending history lease.
      const oldToken = first.lease_token;
      await query("update pro_payment_reconciliation_state set lease_until=now()-interval '1 second' where state_key='history'");
      const lease = await call('sunland_claim_pro_payment_scan', ['history'], ['text']);
      assert.equal(lease.acquired, true); assert.notEqual(lease.lease_token, oldToken);
      await scan([o], 'cron_history'); const before = await row(o.order_id);
      await query("update pro_payment_reconciliation_state set lease_until=now()-interval '1 second' where state_key='history'");
      const complete = await call('sunland_complete_pro_payment_scan',
        ['history', lease.lease_token, lease.generation, lease.next_page < 3 ? lease.next_page + 1 : 1, 3, [o.order_id]],
        ['text', 'uuid', 'bigint', 'integer', 'integer', 'text[]']);
      assert.equal(complete.advanced, false); assert.equal(complete.reason_code, 'LEASE_FENCED');
      const replacement = await call('sunland_claim_pro_payment_scan', ['history'], ['text']);
      assert.equal(replacement.next_page, lease.next_page);
      assert.equal((await scan([o], 'cron_history')).processed, 0);
      assert.deepEqual(await row(o.order_id), before); assert.equal(await pro(52), true);
    });
    await t.test('Waffo and Afdian sources coexist; Afdian refund does not revoke any source', async () => {
      await fixture(60);
      const config = { mode: 'prod', merchant_id: 'MER_6mey7SY5b0KXN1W7JiZYSz', store_id: 'STO_4gmpGF9UEj1SO6vpelNcmy',
        product_id: 'PROD_5buXbrDEzQX6Nya6p1wMC5', currency: 'CNY', amount_minor: 1500 };
      await call('sunland_waffo_register_intent', [JSON.stringify({ ...config, user_id: 'buyer-60',
        payment_reference: uuid(600), request_key: uuid(601) })], ['jsonb']);
      const event = { ...config, user_id: 'buyer-60', payment_reference: uuid(600), order_id: 'ORD_admission60',
        payment_id: 'PAY_admission60', event_id: 'PAY_admission60', event_type: 'order.completed',
        event_sha256: 'a'.repeat(64), proof_sha256: 'b'.repeat(64), charged_minor: 1500,
        payment_status: 'succeeded', order_status: 'completed', entitlement_enabled: true };
      assert.equal((await call('sunland_waffo_apply_event', [JSON.stringify(event)], ['jsonb'])).entitlementState, 'granted');
      const o = proof(60); await hints([o]); await scan([o]); await scan([proof(60, { status: 'refunded' })]);
      assert.equal(await pro(60), true);
      assert.equal((await query("select count(*)::int n from waffo_prod.entitlement_sources where user_id='buyer-60' and active"))[0].n, 2);
      assert.equal((await call('sunland_waffo_apply_event', [JSON.stringify({ ...event, event_type: 'refund.succeeded',
        event_id: 'RFD_admission60', refund_status: 'succeeded', event_sha256: 'c'.repeat(64) })], ['jsonb'])).entitlementState, 'revoked');
      assert.equal(await pro(60), true);
    });
    await t.test('service-role execution works and ordinary roles cannot call admission or read leases', async () => {
      await fixture(61); const o = proof(61); await hints([o]); await db.exec('set role service_role');
      assert.equal((await scan([o])).results[0].status, 'activated'); await db.exec('reset role');
      for (const role of ['anon', 'authenticated']) {
        await db.exec(`set role ${role}`);
        await assert.rejects(() => scan([o]), /permission denied/);
        await assert.rejects(() => query('select * from pro_payment_order_query_leases'), /permission denied/);
        await assert.rejects(() => claim(o.order_id), /permission denied/);
        await assert.rejects(() => finish(o, uuid(1000)), /permission denied/);
        await assert.rejects(() => fail(o.order_id, uuid(1000)), /permission denied/);
        await db.exec('reset role');
      }
    });
    await t.test('unrecorded or duplicate scan inputs fail closed without advancing or granting', async () => {
      await assert.rejects(() => scan([proof(999)]), /PAYMENT_SCAN_HINT_NOT_DURABLE/);
      await assert.rejects(() => scan([proof(1), proof(1)]), /INVALID_PAYMENT_SCAN_ORDERS/);
    });
    await t.test('authenticated user reconcile uses shared admission and preserves periodic recovery', async () => {
      await fixture(62); const o = proof(62); await hints([o]);
      assert.equal((await scan([o], 'user_reconcile')).results[0].status, 'activated');
      assert.equal((await scan([o], 'user_reconcile')).processed, 0);
      await periodicDue(o.order_id); assert.equal((await scan([o], 'user_reconcile')).processed, 1);
    });
    await t.test('malformed observation is isolated while a transaction failure aborts the whole scan', async () => {
      await fixture(63); await fixture(64); const good = proof(63); const bad = { ...proof(64), amount_cents: 1 };
      await hints([good, bad]); const result = await scan([good, bad]);
      assert.equal(result.processed, 2); assert.equal(await pro(63), true); assert.equal(await pro(64), false);
      assert.ok(result.results.every(o => typeof o.status === 'string'));
      assert.equal((await row(bad.order_id)).last_error_code, 'PROVIDER_VERIFICATION_REQUIRED');
      await fixture(65); await fixture(66); const orders = [proof(65), proof(66)]; await hints(orders);
      await db.exec(`create function public.admission_batch_failure() returns trigger language plpgsql as $$begin
        if new.order_id='admission-order-66' and new.status='activated' then raise exception 'INJECTED_BATCH_FAILURE'; end if; return new; end;$$;
        create trigger admission_batch_failure before update on pro_payment_orders for each row execute function public.admission_batch_failure();`);
      await assert.rejects(() => scan(orders), /INJECTED_BATCH_FAILURE/);
      assert.equal(await pro(65), false); assert.equal(await pro(66), false);
      assert.equal((await row(orders[0].order_id)).status, 'unresolved');
      await db.exec('drop trigger admission_batch_failure on pro_payment_orders; drop function public.admission_batch_failure();');
      assert.equal((await scan(orders)).processed, 2);
    });
    await t.test('measured stable 12-order replay: 48 verified RPCs/96 row updates become 4 batches/0 updates', async () => {
      const orders = [];
      for (let n = 80; n < 92; n++) { await fixture(n); orders.push(proof(n)); }
      await hints(orders); await scan(orders); await scan(orders);
      await db.exec(`create table public.admission_update_metric(n integer); insert into admission_update_metric values(0);
        create function public.admission_count_update() returns trigger language plpgsql as $$begin
          update public.admission_update_metric set n=n+1; return new; end;$$;
        create trigger admission_count_update after update on pro_payment_orders for each row execute function public.admission_count_update();`);
      let beforeRequests = 0;
      for (let i = 0; i < 4; i++) for (const o of orders) {
        await call('sunland_process_verified_pro_order', [JSON.stringify(o), 'cron_recent', trace, false], ['jsonb', 'text', 'uuid', 'boolean']);
        beforeRequests++;
      }
      const beforeWrites = (await query('select n from admission_update_metric'))[0].n;
      await db.exec('update admission_update_metric set n=0'); let afterRequests = 0; let processed = 0;
      for (let i = 0; i < 4; i++) { processed += (await scan(orders)).processed; afterRequests++; }
      const afterWrites = (await query('select n from admission_update_metric'))[0].n;
      assert.deepEqual({ beforeRequests, beforeWrites, afterRequests, afterWrites, processed },
        { beforeRequests: 48, beforeWrites: 96, afterRequests: 4, afterWrites: 0, processed: 0 });
      t.diagnostic(JSON.stringify({ fixture: '4 replays of 12 stable activated orders', beforeRequests,
        beforeWrites, afterRequests, afterWrites, processed, cpu: 'not measured' }));
      await db.exec('drop trigger admission_count_update on pro_payment_orders; drop function public.admission_count_update(); drop table admission_update_metric;');
    });
  } finally { await db.close(); }
});
