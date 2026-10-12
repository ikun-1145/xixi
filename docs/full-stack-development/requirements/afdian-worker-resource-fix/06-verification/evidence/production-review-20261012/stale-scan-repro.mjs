import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(process.env.AFDIAN_PGLITE_PATH
  ? pathToFileURL(process.env.AFDIAN_PGLITE_PATH).href : '@electric-sql/pglite');
const db = new PGlite();
const read = p => readFile(p, 'utf8');
try {
  const src = await read('tests/afdianpay-admission-db.test.mjs');
  const base = await read('supabase/migrations/20260905014430_pro_payment_activation_reliability.sql');
  const setup = src.slice(src.indexOf('await db.exec(`'), src.indexOf('const protectedSql ='));
  await new (Object.getPrototypeOf(async()=>{}).constructor)('db', 'read', 'base', setup)(db, read, base);
  await db.exec(await read('supabase/migrations/20261011030000_afdian_scan_admission.sql'));
  const ref = '00000000-0000-4000-8000-000000001001';
  const trace = '00000000-0000-4000-8000-000000009999';
  const id = 'isolated-stale-scan-order';
  await db.query('insert into user_profiles(user_id) values($1)', ['synthetic-stale-scan']);
  await db.query('insert into pro_payment_intents(payment_reference,user_id) values($1,$2)', [ref, 'synthetic-stale-scan']);
  await db.query("select sunland_record_pro_payment_hints(array[$1],'cron_recent',$2)", [id, trace]);
  const old = (await db.query("select sunland_claim_pro_payment_scan('recent') r")).rows[0].r;
  const paid = { provider: 'afdian', order_id: id, payment_status: 'paid', plan_id: '16b23966c0a711f183dc5254001e7c00', product_type: 1, amount_cents: 1500, total_amount: '15.00', currency: 'CNY', binding_reference: ref, binding_source: 'intent', paid_at: null, sku_detail: [{ sku_id: '16b98478c0a711f1bb735254001e7c00', count: 1 }] };
  const scan = o => db.query("select sunland_process_pro_payment_scan_orders($1::jsonb,'cron_recent',$2::uuid) r", [JSON.stringify([o]), trace]).then(x=>x.rows[0].r);
  await db.exec("update pro_payment_reconciliation_state set lease_until=now()-interval '1 second' where state_key='recent'");
  const fresh = (await db.query("select sunland_claim_pro_payment_scan('recent') r")).rows[0].r;
  const newer = await scan({ ...paid, payment_status: 'unknown' });
  await db.query("update pro_payment_orders set next_retry_at=now()-interval '1 second' where order_id=$1", [id]);
  const stale = await scan(paid);
  const completed = (await db.query("select sunland_complete_pro_payment_scan('recent',$1::uuid,$2::bigint,1,1,array[$3]) r", [old.lease_token, old.generation, id])).rows[0].r;
  const final = (await db.query("select payment_status,status,(select pro from user_profiles where user_id='synthetic-stale-scan') pro from pro_payment_orders where order_id=$1", [id])).rows[0];
  assert.equal(newer.results[0].status, 'unresolved');
  assert.equal(stale.results[0].status, 'activated');
  assert.equal(completed.reason_code, 'LEASE_FENCED');
  assert.equal(final.pro, true);
  console.log(JSON.stringify({ scope: 'isolated SQL only; timestamp updates simulate elapsed lease and retry time', oldGeneration: old.generation, newGeneration: fresh.generation, newer, stale, completed, final, finding: 'P1 reproduced; no production access' }, null, 2));
} finally { await db.close(); }
