// Actual PostgreSQL in memory; no network, production credentials or real user data.
// AFDIAN_PGLITE_PATH=/path/to/@electric-sql/pglite/dist/index.js node this-file
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { canonicalAfdianProof, MERCHANDISE } from './worker-proof.DRAFT.mjs';
const { PGlite } = await import(process.env.AFDIAN_PGLITE_PATH
  ? pathToFileURL(process.env.AFDIAN_PGLITE_PATH).href : '@electric-sql/pglite');
const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const db = new PGlite();
let checks = 0;
const eq = (a,b) => { assert.deepEqual(a,b); checks++; };
const uu = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const trace = uu(900);
const oldPlan = '4c2527fc6c7411f1bbe45254001e7c00';
const base = await read('../../../supabase/migrations/20260905014430_pro_payment_activation_reliability.sql');
const waffo = await read('../../../supabase/migrations/20261002071010_waffo_production_entitlement_sources.sql');
const draft = await read('./schema.DRAFT.sql');
try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema extensions; create function extensions.gen_random_uuid() returns uuid language sql as $$select gen_random_uuid()$$;
    create schema auth; create function auth.jwt() returns jsonb language sql as $$select '{}'::jsonb$$;
    create table public.user_profiles(user_id text primary key, pro boolean default false,
      identity_status text default 'active',is_banned boolean default false,updated_at timestamptz default now());
    create table public.pro_activations(id uuid default gen_random_uuid(),user_id text,source text,order_id text unique,
      activated_at timestamptz default now(),created_at timestamptz default now());
    grant select,insert,update on public.user_profiles,public.pro_activations to service_role;
    ${base.slice(base.indexOf('create table'),base.indexOf('create or replace function'))}
    ${await read('../../../tests/fixtures/waffo-legacy-payment-rpc.sql')}
    ${await read('./live-rpc-baseline.sql')}
    ${await read('./live-deletion-baseline.sql')}
    create trigger pro_payment_orders_serialize_insert before insert on public.pro_payment_orders
      for each row execute function public.sunland_serialize_pro_payment_order_insert();
    revoke all on function public.sunland_activate_pro_from_payment(text,text,text,text,numeric,timestamptz) from public,anon,authenticated;
    revoke all on function public.sunland_delete_account_business_data(text) from public,anon,authenticated;
    grant execute on function public.sunland_activate_pro_from_payment(text,text,text,text,numeric,timestamptz) to service_role;
    insert into public.user_profiles(user_id,pro) values('preexisting',true);
    ${waffo}`);
  const protectedDefinitions = async () => (await db.query(`select oid::regprocedure::text as signature,pg_get_functiondef(oid) as definition
    from pg_proc where pronamespace='public'::regnamespace and (proname in
    ('sunland_activate_pro_from_payment','sunland_resolve_pro_payment','sunland_get_or_create_pro_payment_intent','sunland_delete_account_business_data')
      or proname like 'sunland_waffo_%') order by 1`)).rows;
  const before = await protectedDefinitions();
  await db.exec(draft);
  const expectedDefinitions=before.map(f=>({ ...f, definition:
    f.signature.startsWith('sunland_activate_pro_from_payment(text,text,text,')
      ? f.definition.replace('  select pro_payment_orders.status','  perform pg_advisory_xact_lock(hashtext(p_order_id));\n\n  select pro_payment_orders.status')
      : f.signature==='sunland_resolve_pro_payment(text,text)'
        ? f.definition.replace('  select payment_order.status, payment_order.plan_id',
          '  perform pg_advisory_xact_lock(hashtext(p_order_id));\n\n  select payment_order.status, payment_order.plan_id')
      : f.signature==='sunland_delete_account_business_data(text)'
        ? f.definition.replace('  perform public.chat_prepare_account_delete(p_user_id);',
          '  perform public.sunland_scrub_afdian_user_references(p_user_id);\n  perform public.chat_prepare_account_delete(p_user_id);')
        : f.definition }));
  eq(await protectedDefinitions(),expectedDefinitions);
  eq((await db.query("select pro from public.user_profiles where user_id='preexisting'")).rows[0].pro,true);
  const proof = (n,patch={}) => canonicalAfdianProof({out_trade_no:`draft-order-${n}`,status:2,product_type:1,
    plan_id:MERCHANDISE.planId,total_amount:'15.00',custom_order_id:uu(n),
    sku_detail:[{sku_id:MERCHANDISE.skuId,count:1}],...patch});
  const fixture = async n => {
    await db.query('insert into public.user_profiles(user_id) values($1)',[`buyer-${n}`]);
    await db.query('insert into public.pro_payment_intents(payment_reference,user_id) values($1::uuid,$2)',[uu(n),`buyer-${n}`]);
  };
  const call = async (order,cached=false) => (await db.query('select public.sunland_process_verified_pro_order($1::jsonb,$2,$3::uuid,$4) as result',
    [JSON.stringify(order),'webhook',trace,cached])).rows[0].result;
  const pro = async n => (await db.query('select pro from public.user_profiles where user_id=$1',[`buyer-${n}`])).rows[0].pro;
  await fixture(1);
  eq((await call(proof(1))).status,'activated'); eq(await pro(1),true);
  eq((await call(proof(1))).already_processed,true);
  eq((await db.query("select count(*)::int as n from public.pro_activations where order_id='draft-order-1'")).rows[0].n,1);
  eq((await db.query("select active from waffo_prod.entitlement_sources where source_id='payment:draft-order-1'")).rows[0].active,true);
  let n = 10;
  for (const patch of [ {plan_id:'a'.repeat(32)}, {sku_detail:[{sku_id:'b'.repeat(32),count:1}]},
    {sku_detail:[{sku_id:MERCHANDISE.skuId,count:2}]}, {total_amount:'14.99'}, {total_amount:'30.00'},
    {status:0}, {product_type:0}, {remark:'buyer-other',custom_order_id:''} ]) {
    n++; await fixture(n); await call(proof(n,patch)); eq(await pro(n),false);
  }
  await fixture(30);
  await assert.rejects(()=>call({...proof(30),provider:'waffo'}),/INVALID_VERIFIED_ORDER_INPUT/); checks++;
  eq((await call({...proof(30),currency:'USD'})).status,'ineligible'); eq(await pro(30),false);
  for (const sku of [[],null,{},[{sku_id:MERCHANDISE.skuId,count:'1'}],
    [{sku_id:MERCHANDISE.skuId,count:1},{sku_id:MERCHANDISE.skuId,count:1}]]) {
    n++; await fixture(n); await call({...proof(n),sku_detail:sku}); eq(await pro(n),false);
  }
  await fixture(40);
  eq((await call({order_id:'draft-order-40',provider:'afdian'},true)).reason_code,'PROVIDER_VERIFICATION_REQUIRED');
  eq(await pro(40),false);
  eq((await call(proof(40,{custom_order_id:uu(41)}))).reason_code,'INTENT_NOT_FOUND');
  eq(await pro(40),false);
  // Later creation of the missing intent cannot turn cached paid into authorization.
  await fixture(41);
  await call({order_id:'draft-order-40',provider:'afdian'},true); eq(await pro(41),false);
  eq((await call(proof(40,{custom_order_id:uu(41)}))).status,'activated'); eq(await pro(41),true);
  eq((await call(proof(40))).reason_code,'BINDING_CONFLICT'); eq(await pro(40),false);
  eq((await call(proof(1,{sku_detail:[{sku_id:'b'.repeat(32),count:1}]}))).reason_code,'PROVIDER_FACT_CONFLICT');
  eq(await pro(1),true);
  // Both supported historical binding forms retain the old price rule.
  await fixture(50);
  eq((await call(proof(50,{product_type:0,plan_id:oldPlan,total_amount:'10.00',sku_detail:[]}))).status,'activated');
  await fixture(51);
  eq((await call(proof(51,{product_type:0,plan_id:oldPlan,total_amount:'15.00',sku_detail:[]}))).reason_code,'AMOUNT_MISMATCH');
  eq(await pro(51),false);
  await fixture(52);
  await db.query('insert into public.pro_payment_orders(order_id,plan_id,total_amount,bound_user_id,binding_source,status) values($1,$2,10,$3,$4,$5)',
    ['draft-order-52',oldPlan,'buyer-52','intent','activated']);
  // An already consumed historical ledger does not recreate a manually removed Pro.
  eq((await call(proof(52,{product_type:0,plan_id:oldPlan,total_amount:'10.00'}))).already_processed,true); eq(await pro(52),false);
  await fixture(60); await call(proof(60,{status:'refunded'}));
  eq((await call(proof(60))).reason_code,'PAYMENT_NOT_PAID'); eq(await pro(60),false);
  await fixture(61); await db.query("update public.user_profiles set identity_status='retired' where user_id='buyer-61'");
  eq((await call(proof(61))).reason_code,'ACCOUNT_RETIRED'); eq(await pro(61),false);
  await fixture(62); await db.query("update public.user_profiles set is_banned=true where user_id='buyer-62'");
  await call(proof(62)); eq(await pro(62),false);
  await fixture(63); await call(proof(63,{status:0}));
  await db.query('delete from public.pro_payment_intents where user_id=$1',['buyer-63']);
  const scrub=(await db.query("select verified_binding_reference,last_error_code,next_retry_at from pro_payment_orders where order_id='draft-order-63'")).rows[0];
  eq(scrub,{verified_binding_reference:null,last_error_code:'DATA_DELETED',next_retry_at:null});
  await db.query('insert into public.pro_payment_intents(payment_reference,user_id) values($1::uuid,$2)',[uu(63),'buyer-63']);
  eq((await call(proof(63))).reason_code,'DATA_DELETED'); eq(await pro(63),false);
  // Legacy account without an intent must also erase the raw user-ID reference.
  const legacyUser='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  await db.query('insert into user_profiles(user_id) values($1)',[legacyUser]);
  const legacyProof=proof(64,{product_type:0,plan_id:oldPlan,total_amount:'10.00',custom_order_id:'',remark:legacyUser});
  eq((await call(legacyProof)).status,'activated');
  await db.query('select public.sunland_scrub_afdian_user_references($1)',[legacyUser]);
  eq((await db.query("select bound_user_id,verified_binding_reference,last_error_code from pro_payment_orders where order_id='draft-order-64'")).rows[0],
    {bound_user_id:null,verified_binding_reference:null,last_error_code:'DATA_DELETED'});
  // Failure after unified activation rolls back source, profile, intent and ledger together.
  await fixture(70);
  await db.exec(`create function public.draft_fail_ledger() returns trigger language plpgsql as $$begin
    if new.order_id='draft-order-70' and new.status='activated' then raise exception 'INJECTED_LEDGER_FAILURE'; end if;return new;end;$$;
    create trigger draft_fail before update on public.pro_payment_orders for each row execute function public.draft_fail_ledger();`);
  await assert.rejects(()=>call(proof(70)),/INJECTED_LEDGER_FAILURE/);checks++;
  eq(await pro(70),false); eq((await db.query("select count(*)::int as n from waffo_prod.entitlement_sources where source_id='payment:draft-order-70'")).rows[0].n,0);
  await db.exec('drop trigger draft_fail on public.pro_payment_orders; drop function public.draft_fail_ledger();');
  eq((await call(proof(70))).status,'activated'); eq((await call(proof(70))).already_processed,true);
  // Waffo first, then Afdian purchase while already Pro, then Waffo refund.
  await fixture(80);
  const config={mode:'prod',merchant_id:'MER_6mey7SY5b0KXN1W7JiZYSz',store_id:'STO_4gmpGF9UEj1SO6vpelNcmy',
    product_id:'PROD_5buXbrDEzQX6Nya6p1wMC5',currency:'CNY',amount_minor:1500};
  const wcall=async(name,value)=>(await db.query(`select public.${name}($1::jsonb) as result`,[JSON.stringify(value)])).rows[0].result;
  await wcall('sunland_waffo_register_intent',{...config,user_id:'buyer-80',payment_reference:uu(800),request_key:uu(801)});
  const event={...config,user_id:'buyer-80',payment_reference:uu(800),order_id:'ORD_draft80',payment_id:'PAY_draft80',
    event_id:'PAY_draft80',event_type:'order.completed',event_sha256:'a'.repeat(64),proof_sha256:'b'.repeat(64),
    charged_minor:1500,payment_status:'succeeded',order_status:'completed',entitlement_enabled:true};
  eq((await wcall('sunland_waffo_apply_event',event)).entitlementState,'granted');
  eq((await call(proof(80))).status,'activated');
  eq((await wcall('sunland_waffo_apply_event',{...event,event_type:'refund.succeeded',event_id:'RFD_draft80',refund_status:'succeeded',event_sha256:'c'.repeat(64)})).entitlementState,'revoked');
  eq(await pro(80),true);
  // Run the new RPC as its actual server role, with RLS enabled and BYPASSRLS.
  await fixture(90); await fixture(91);
  await db.exec('set role service_role');
  eq((await call(proof(90))).status,'activated');
  eq((await call(proof(91,{sku_detail:[{sku_id:'b'.repeat(32),count:1}]}))).status,'ineligible');
  await db.exec('reset role'); eq(await pro(90),true); eq(await pro(91),false);
  for(const role of ['anon','authenticated']) {
    await db.exec(`set role ${role}`);
    await assert.rejects(()=>call(proof(1)),/permission denied/);checks++;
    await assert.rejects(()=>db.query('select * from public.pro_payment_reconciliation_state'),/permission denied/);checks++;
    await db.exec('reset role');
  }
  // Forward-only rollback: revoke only new routines; preserve facts and Pro sources.
  await db.exec(await read('./rollback.DRAFT.sql'));
  eq(await pro(80),true); eq(await pro(1),true); eq(await protectedDefinitions(),expectedDefinitions);
} catch (error) {
  // PGlite errors otherwise print the entire SQL query. Keep failure output structural.
  console.error(`Draft SQL check failed: ${error.message}`);
  process.exitCode = 1;
} finally { await db.close(); }
if (!process.exitCode) console.log(`Afdian draft SQL: ${checks} PostgreSQL checks passed.`);
