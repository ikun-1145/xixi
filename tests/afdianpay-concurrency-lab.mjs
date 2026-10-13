// Explicit local-only PostgreSQL multi-connection lab. No provider/production traffic.
// Run: AFDIAN_DOCKER_PG=true node tests/afdianpay-concurrency-lab.mjs
import assert from 'node:assert/strict';
import { startLocalStack, quote } from './afdianpay-local-stack.mjs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

if (process.env.AFDIAN_DOCKER_PG !== 'true') throw new Error('Set AFDIAN_DOCKER_PG=true to authorize this isolated local lab');
const trace = randomUUID();
const references = new Map();
const proof = (id, patch = {}) => ({ provider: 'afdian', order_id: id, payment_status: 'paid',
  plan_id: '16b23966c0a711f183dc5254001e7c00', product_type: 1, amount_cents: 1500,
  total_amount: '15.00', currency: 'CNY', binding_reference: references.get(id), binding_source: 'intent', paid_at: null,
  sku_detail: [{ sku_id: '16b98478c0a711f1bb735254001e7c00', count: 1 }], ...patch });
const stack = await startLocalStack(); let checks = 0;
const sql = stack.sql;
const result = async statement => JSON.parse((await sql(statement)).split('\n').filter(Boolean).at(-1));
const batchSql = (orders, source = 'cron_recent', lease = null) => {
  const key = source === 'cron_history' ? 'history' : 'recent';
  const args = lease ? `${quote(key)},${quote(lease.lease_token)}::uuid,${lease.generation}` :
    `'${key}',(v->>'lease_token')::uuid,(v->>'generation')::bigint`;
  return lease ? `select sunland_process_pro_payment_scan_orders(${quote(JSON.stringify(orders))}::jsonb,${quote(source)},${quote(trace)}::uuid,${args});` :
    `update pro_payment_reconciliation_state set lease_until=null,last_success_at=null where state_key='${key}';
     with lease as materialized (select sunland_claim_pro_payment_scan('${key}') v)
     select sunland_process_pro_payment_scan_orders(${quote(JSON.stringify(orders))}::jsonb,${quote(source)},${quote(trace)}::uuid,${args}) from lease;`;
};
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
    await sql(`update pro_payment_reconciliation_state set lease_until=null,last_success_at=null where state_key=${quote(key)};`);
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
  const claimScan = async key => {
    await sql(`update pro_payment_reconciliation_state set lease_until=null,last_success_at=null where state_key=${quote(key)};`);
    return result(`select sunland_claim_pro_payment_scan(${quote(key)});`);
  };
  const completeScan = (key, lease) => result(`select sunland_complete_pro_payment_scan(${quote(key)},${quote(lease.lease_token)}::uuid,${lease.generation},1,3,array[]::text[]);`);
  const snapshot = id => result(`select jsonb_build_object('order',(select to_jsonb(r) from pro_payment_orders r where order_id=${quote(id)}),
    'profile',(select to_jsonb(p) from user_profiles p where user_id=${quote(id)}),
    'intents',(select coalesce(jsonb_agg(i),'[]'::jsonb) from pro_payment_intents i where user_id=(select bound_user_id from pro_payment_orders where order_id=${quote(id)}) or user_id=${quote(id)}),
    'activation',(select coalesce(jsonb_agg(a),'[]'::jsonb) from pro_activations a where order_id=${quote(id)}),
    'sources',(select coalesce(jsonb_agg(e),'[]'::jsonb) from waffo_prod.entitlement_sources e where source_id=${quote(`payment:${id}`)}));`);
  const rejectBatch = async statement => {
    let rejected = false;
    try { const answer = await result(statement); rejected = answer.reason_code === 'LEASE_FENCED' && answer.processed === 0; }
    catch(error) { assert.match(error.message,/LEASE_FENCED|SCAN_LEASE|lease/i); rejected = true; }
    check(rejected,'Expired scan batch rejected by PostgreSQL');
  };
  // Original P1: generation 1 obtained paid; replacement generation 2 commits unknown.
  const staleScan = 'concurrency-stale-scan-paid'; await fixture(staleScan);
  const generation1 = await claimScan('recent');
  await sql("update pro_payment_reconciliation_state set lease_until=clock_timestamp()-interval '1 second' where state_key='recent';");
  const generation2 = await result("select sunland_claim_pro_payment_scan('recent');");
  check(generation2.generation === generation1.generation + 1,'Replacement scan increments generation');
  check((await result(batchSql([proof(staleScan,{payment_status:'unknown'})],'cron_recent',generation2))).processed===1,'Replacement unknown observation is durable');
  await sql(`update pro_payment_orders set next_retry_at=clock_timestamp()-interval '1 second' where order_id=${quote(staleScan)};`);
  const unchanged = await snapshot(staleScan);
  await rejectBatch(batchSql([proof(staleScan)],'cron_recent',generation1));
  assert.deepEqual(await snapshot(staleScan),unchanged); checks++;
  check((await completeScan('recent',generation1)).advanced===false,'Stale scan cannot advance cursor');
  check((await completeScan('recent',generation2)).advanced===true,'New scan can finish after stale rejection');
  check((await snapshot(staleScan)).profile.pro===false,'Stale paid cannot grant Pro');
  const fresh = await claimScan('recent');
  check((await result(batchSql([proof(staleScan)],'cron_recent',fresh))).processed===1,'Fresh verified paid synthetic order activates normally');
  check((await snapshot(staleScan)).profile.pro===true,'Fresh scan paid grants Pro');

  // Valid leases on different lanes are execution authority, not fresh provider truth.
  const cross='concurrency-cross-lane';await fixture(cross);
  const earlier=await claimScan('recent');await delay(10);const later=await claimScan('history');
  check((await result(batchSql([proof(cross,{payment_status:'unknown'})],'cron_history',later))).processed===1,'Later history unknown commits');
  await sql(`update pro_payment_orders set next_retry_at=clock_timestamp()-interval '1 second' where order_id=${quote(cross)};`);
  const crossBefore=await snapshot(cross);
  check((await result(batchSql([proof(cross)],'cron_recent',earlier))).processed===0,'Earlier valid recent lease cannot overwrite later accepted fact');
  assert.deepEqual(await snapshot(cross),crossBefore);checks++;
  const latest=await claimScan('recent');
  check((await result(batchSql([proof(cross)],'cron_recent',latest))).processed===1,'Later fresh scan restores due synthetic paid order');
  check((await snapshot(cross)).profile.pro===true,'Cross-lane deferral remains recoverable');
  // A grant accepted after a profile lock wait must have an acceptance clock later
  // than a different lane claimed during that wait (transaction-start now is too old).
  const delayed='concurrency-acceptance-clock';await fixture(delayed);const delayedLease=await claimScan('recent');
  const profileBlock=sql(`begin;select user_id from user_profiles where user_id=${quote(delayed)} for update;select pg_sleep(1);commit;`);
  await delay(100);const delayedGrant=result(batchSql([proof(delayed)],'cron_recent',delayedLease));
  await delay(150);check(Number(await sql("select count(*) from pg_stat_activity where wait_event_type='Lock';"))>=1,'Valid payment grant actually waits on profile lock');
  const waitingHistory=await claimScan('history');await Promise.all([profileBlock,delayedGrant]);const delayedBefore=await snapshot(delayed);
  check((await result(batchSql([proof(delayed,{payment_status:'unknown'})],'cron_history',waitingHistory))).processed===0,'History claimed during grant lock wait cannot overwrite later accepted paid fact');
  assert.deepEqual(await snapshot(delayed),delayedBefore);checks++;
  // Service role cannot call the private helper or old public entry point.
  check(await sql("select has_schema_privilege('service_role','afdian_private','USAGE');")==='f','Private payment schema denied to service role');
  check(await sql("select has_function_privilege('service_role','afdian_private.sunland_process_verified_pro_order(jsonb,text,uuid,boolean)','EXECUTE');")==='f','Private payment helper denied to service role');
  try{await sql(`set role service_role; select sunland_process_verified_pro_order(${quote(JSON.stringify(proof(cross)))}::jsonb,'cron_recent',${quote(trace)}::uuid,false);`);assert.fail('Legacy shim must reject');}
  catch(error){assert.match(error.message,/LEGACY_PAYMENT_ENTRY_DISABLED/);checks++;}
  // Real Waffo source is unaffected by Afdian paid/refunded observations.
  const both='concurrency-waffo-source';await fixture(both);
  const wref=randomUUID(),wrequest=randomUUID();const wmeta={user_id:both,payment_reference:wref,request_key:wrequest,mode:'prod',merchant_id:'MER_6mey7SY5b0KXN1W7JiZYSz',store_id:'STO_4gmpGF9UEj1SO6vpelNcmy',product_id:'PROD_5buXbrDEzQX6Nya6p1wMC5',currency:'CNY',amount_minor:1500};
  await result(`select sunland_waffo_register_intent(${quote(JSON.stringify(wmeta))}::jsonb);`);
  const event={...wmeta,event_type:'order.completed',event_id:'PAY_syntheticP1',order_id:'ORD_syntheticP1',payment_id:'PAY_syntheticP1',payment_status:'succeeded',order_status:'completed',charged_minor:1500,event_sha256:'a'.repeat(64),proof_sha256:'b'.repeat(64),entitlement_enabled:true};
  await result(`select sunland_waffo_apply_event(${quote(JSON.stringify(event))}::jsonb);`);
  const wSnapshot=()=>result("select jsonb_build_object('orders',(select jsonb_agg(o) from waffo_prod.orders o),'sources',(select jsonb_agg(e) from waffo_prod.entitlement_sources e where provider='waffo'),'events',(select jsonb_agg(e) from waffo_prod.events e));");
  const wBefore=await wSnapshot();
  const bothLease=await claimScan('recent');await result(batchSql([proof(both)],'cron_recent',bothLease));
  const refundLease=await claimScan('history');await result(batchSql([proof(both,{payment_status:'refunded'})],'cron_history',refundLease));
  assert.deepEqual(await wSnapshot(),wBefore);checks++;
  check((await snapshot(both)).profile.pro===true,'Afdian refund does not revoke real Waffo source entitlement');
  // Row/advisory/profile waits must use wall-clock expiry after lock acquisition.
  for (const kind of ['scan-row','global','order','profile']) {
    const id=`concurrency-expiry-${kind}`;await fixture(id);const lease=await claimScan('recent');
    await sql("update pro_payment_reconciliation_state set lease_until=clock_timestamp()+interval '600 milliseconds' where state_key='recent';");
    const before=await snapshot(id);
    const lock=kind==='scan-row' ? "select state_key from pro_payment_reconciliation_state where state_key='recent' for update" :
      kind==='global' ? 'select pg_advisory_xact_lock(20261011,30000)' :
      kind==='order' ? `select pg_advisory_xact_lock(hashtext(${quote(id)}))` :
      `select user_id from user_profiles where user_id=${quote(id)} for update`;
    const blocking=sql(`begin;${lock};select pg_sleep(1.1);commit;`);
    await delay(100);
    const waiting=rejectBatch(batchSql([proof(id)],'cron_recent',lease));
    await delay(100);
    check(Number(await sql("select count(*) from pg_stat_activity where wait_event_type='Lock';"))>=1,`${kind} actual independent connection lock wait observed`);
    await Promise.all([blocking,waiting]);
    assert.deepEqual(await snapshot(id),before);checks++;
  }
  const finishExpired='concurrency-finish-profile-expiry';await fixture(finishExpired);const finishLease=await result(claimSql(finishExpired));
  await sql(`update pro_payment_order_query_leases set lease_until=clock_timestamp()+interval '600 milliseconds' where order_id=${quote(finishExpired)};`);
  const finishBefore=await snapshot(finishExpired);
  const finishBlock=sql(`begin;select user_id from user_profiles where user_id=${quote(finishExpired)} for update;select pg_sleep(1.1);commit;`);
  await delay(100);let finishRejected=false;
  const finishWaiting=sql(finishSql(finishExpired,finishLease.lease_token)).catch(error=>{assert.match(error.message,/LEASE_FENCED/);finishRejected=true;});
  await delay(100);check(Number(await sql("select count(*) from pg_stat_activity where wait_event_type='Lock';"))>=1,'Finish RPC actually waits on profile lock');
  await Promise.all([finishBlock,finishWaiting]);check(finishRejected,'Finish RPC expires after profile wait and rolls back');
  assert.deepEqual(await snapshot(finishExpired),finishBefore);checks++;
  // Expiry after one grant was provisionally written still rolls the entire batch back.
  const tailIds=['concurrency-tail-a','concurrency-tail-b'];for(const id of tailIds)await fixture(id);
  const tailLease=await claimScan('recent');
  await sql("update pro_payment_reconciliation_state set lease_until=clock_timestamp()+interval '600 milliseconds' where state_key='recent';");
  const tailBefore=await Promise.all(tailIds.map(snapshot));
  await sql(`create function public.admission_tail_expiry() returns trigger language plpgsql as $$begin
    if new.order_id='concurrency-tail-b' and new.status='activated' then perform pg_sleep(0.8);end if;return new;end;$$;
    create trigger admission_tail_expiry before update on pro_payment_orders for each row execute function public.admission_tail_expiry();`);
  await rejectBatch(batchSql(tailIds.map(id=>proof(id)),'cron_recent',tailLease));
  assert.deepEqual(await Promise.all(tailIds.map(snapshot)),tailBefore);checks++;
  await sql('drop trigger admission_tail_expiry on pro_payment_orders;drop function public.admission_tail_expiry();');
  // Server-side SQL wall time excludes Docker startup/transport and is not Worker CPU.
  const benchIds=[];for(let i=0;i<12;i++){const id=`concurrency-benchmark-${i}`;await fixture(id);benchIds.push(id);}
  const benchFacts=JSON.stringify(benchIds.map(id=>proof(id)));
  console.log(await sql(`create temporary table admission_timing(result jsonb);do $$
    declare t timestamptz;o jsonb;j integer;lease jsonb;before_ms numeric;after_ms numeric;
    begin
      t:=clock_timestamp();
      for j in 1..4 loop for o in select value from jsonb_array_elements(${quote(benchFacts)}::jsonb) loop
        perform afdian_private.sunland_process_verified_pro_order(o,'cron_recent',${quote(trace)}::uuid,false);
      end loop;end loop;
      before_ms:=extract(epoch from clock_timestamp()-t)*1000;
      t:=clock_timestamp();
      for j in 1..4 loop
        update pro_payment_reconciliation_state set lease_until=null,last_success_at=null where state_key='recent';
        lease:=sunland_claim_pro_payment_scan('recent');
        perform sunland_process_pro_payment_scan_orders(${quote(benchFacts)}::jsonb,'cron_recent',${quote(trace)}::uuid,'recent',
          (lease->>'lease_token')::uuid,(lease->>'generation')::bigint);
      end loop;
      after_ms:=extract(epoch from clock_timestamp()-t)*1000;
      insert into admission_timing values(jsonb_build_object('databaseVersion','PostgreSQL16','rows',12,'iterations',4,
        'before_sql_ms',before_ms,'after_sql_ms',after_ms,'scope','server clock wall time, including SQL lock/execution; excludes Docker/client/network; not Worker CPU'));
    end;$$;select result from admission_timing;`));
  console.log(`Afdian isolated PostgreSQL 16 concurrency: ${checks} checks passed across independent connections.`);
} finally {
  await stack.close();
  console.log('Owned temporary PostgreSQL container removed. Existing containers untouched.');
}
