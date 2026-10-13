// Real, owned PostgreSQL 16 only. No production credentials or payment traffic.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { startLocalStack, quote } from './afdianpay-local-stack.mjs';
const migration = await readFile(new URL('../supabase/migrations/20261011030000_afdian_scan_admission.sql', import.meta.url), 'utf8');
const stack = await startLocalStack({ admission: false });
const { sql, result } = stack; let checks = 0;
const trackedMigration = migration.slice(0, migration.lastIndexOf('commit;')) +
  `insert into supabase_migrations.schema_migrations(version,name,statements) values('20261011030000','afdian_scan_admission',array[${quote(migration)}]);\ncommit;`;
const check = (value, description) => { assert.ok(value, description); checks++; };
const signature = 'public.sunland_process_verified_pro_order(jsonb,text,uuid,boolean)';
const protectedBodies = `select coalesce(jsonb_object_agg(oid::regprocedure::text,md5(prosrc)),'{}') from pg_proc
 where pronamespace='public'::regnamespace and (proname like 'sunland_waffo_%' or proname='sunland_activate_pro_from_payment');`;
try {
  await sql(`create schema supabase_migrations; create table supabase_migrations.schema_migrations(version text primary key,statements text[],name text,created_by text,idempotency_key text,rollback text[]); grant usage on schema public,extensions to service_role;`);
  const originalBody = await sql(`select md5(prosrc) from pg_proc where oid=${quote(signature)}::regprocedure;`);
  const protectedBefore = await result(protectedBodies);
  await sql(`revoke execute on function ${signature} from service_role;`);
  await assert.rejects(() => sql(`set role service_role; select ${signature.split('(')[0]}('{}','cron_recent',${quote(randomUUID())}::uuid,false);`), /permission denied/); checks++;
  check(Number(await sql("select count(*) from pg_stat_activity where pid<>pg_backend_pid() and backend_type='client backend' and xact_start is not null;")) === 0, 'Pause/drain has no old in-flight SQL');
  const failed = trackedMigration.slice(0, trackedMigration.lastIndexOf('commit;')) + "select 1 / 0;\ncommit;";
  await assert.rejects(() => sql(failed), /division by zero/); checks++;
  check(await sql("select to_regnamespace('afdian_private') is null and to_regclass('public.pro_payment_order_query_leases') is null;") === 't', 'Failed DDL transaction leaves no partial structure');
  check(await sql(`select md5(prosrc) from pg_proc where oid=${quote(signature)}::regprocedure;`) === originalBody, 'Failed migration restores original business definition');
  check(await sql(`select has_function_privilege('service_role',${quote(signature)},'EXECUTE');`) === 'f', 'Failure retains the already-committed pause');
  assert.deepEqual(await result(protectedBodies), protectedBefore); checks++;
  check(await sql("select count(*) from supabase_migrations.schema_migrations where version='20261011030000';") === '0', 'Failed migration rolls back its history record');
  await sql(trackedMigration);
  check(await sql("select count(*) from supabase_migrations.schema_migrations where version='20261011030000' and name='afdian_scan_admission' and cardinality(statements)=1;") === '1', 'Successful migration and history are atomic');
  check(await sql("select md5(prosrc) from pg_proc where oid='afdian_private.sunland_process_verified_pro_order(jsonb,text,uuid,boolean)'::regprocedure;") === originalBody, 'Successful migration preserves original business body');
  assert.deepEqual(await result(protectedBodies), protectedBefore); checks++;
  await assert.rejects(() => sql(`set role service_role; select public.sunland_process_verified_pro_order('{}','cron_recent',${quote(randomUUID())}::uuid,false);`), /LEGACY_PAYMENT_ENTRY_DISABLED/); checks++;
  check(await sql("select not has_schema_privilege('service_role','afdian_private','USAGE') and not has_function_privilege('service_role','afdian_private.sunland_process_verified_pro_order(jsonb,text,uuid,boolean)','EXECUTE');") === 't', 'Old invocations cannot reach the private helper after cutover');
  const reference = randomUUID(), trace = randomUUID(), id = 'recovery-synthetic-paid';
  await sql(`insert into user_profiles(user_id) values('recovery-synthetic-user');
    insert into pro_payment_intents(payment_reference,user_id) values(${quote(reference)}::uuid,'recovery-synthetic-user');
    set role service_role; select sunland_record_pro_payment_hints(array[${quote(id)}],'webhook',${quote(trace)}::uuid);`);
  const lease = await result(`set role service_role; select sunland_claim_pro_payment_order_query(${quote(id)});`);
  const proof = {provider:'afdian',order_id:id,payment_status:'paid',plan_id:'16b23966c0a711f183dc5254001e7c00',
    product_type:1,amount_cents:1500,total_amount:'15.00',currency:'CNY',binding_reference:reference,binding_source:'intent',paid_at:null,
    sku_detail:[{sku_id:'16b98478c0a711f1bb735254001e7c00',count:1}]};
  const completion = await result(`set role service_role; select sunland_finish_pro_payment_order_query(${quote(JSON.stringify(proof))}::jsonb,'webhook',${quote(trace)}::uuid,${quote(lease.lease_token)}::uuid);`);
  check(completion.status === 'activated', 'New service-only fenced finish can activate a synthetic paid order');
  check(await sql("select pro from user_profiles where user_id='recovery-synthetic-user';") === 't', 'Synthetic entitlement committed');
  // Recovery deliberately keeps new schema and permanent legacy barrier. Never reverse
  // a migration that has carried order state; the Worker maintenance gate stops callers.
  const before = await result(`select jsonb_build_object('order',to_jsonb(o),'intent',to_jsonb(i),'profile',to_jsonb(p))
    from pro_payment_orders o join pro_payment_intents i on i.payment_reference=${quote(reference)}::uuid
    join user_profiles p on p.user_id=i.user_id where o.order_id=${quote(id)};`);
  await assert.rejects(() => sql(`set role service_role; select public.sunland_process_verified_pro_order(${quote(JSON.stringify(proof))}::jsonb,'cron_recent',${quote(trace)}::uuid,false);`), /LEGACY_PAYMENT_ENTRY_DISABLED/); checks++;
  assert.deepEqual(await result(`select jsonb_build_object('order',to_jsonb(o),'intent',to_jsonb(i),'profile',to_jsonb(p))
    from pro_payment_orders o join pro_payment_intents i on i.payment_reference=${quote(reference)}::uuid
    join user_profiles p on p.user_id=i.user_id where o.order_id=${quote(id)};`), before); checks++;
  console.log(JSON.stringify({checks,postgres:stack.version,migrationFailure:'atomic rollback with pause retained',
    recovery:'retain schema, facts, entitlements and permanent legacy barrier; maintenance Worker then forward repair',
    productionWrites:false},null,2));
} finally { await stack.close(); }
