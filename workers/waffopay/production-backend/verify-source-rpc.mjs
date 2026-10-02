// Run against actual PostgreSQL (PGlite), without any Supabase/network access.
// WAFFO_PGLITE_PATH=/absolute/path/to/pglite/dist/index.js node .../verify-source-rpc.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const { PGlite } = await import(process.env.WAFFO_PGLITE_PATH ? pathToFileURL(process.env.WAFFO_PGLITE_PATH).href : '@electric-sql/pglite');
const db = new PGlite();
const original = await readFile(resolve(root, 'tests/fixtures/waffo-legacy-payment-rpc.sql'), 'utf8');
const migration = await readFile(resolve(root, 'supabase/migrations/20261002071010_waffo_production_entitlement_sources.sql'), 'utf8');
await db.exec(`create role anon; create role authenticated; create role service_role;
create table public.user_profiles(user_id text primary key,pro boolean default false,identity_status text default 'active',is_banned boolean default false,updated_at timestamptz default now());
create table public.pro_activations(id uuid default gen_random_uuid(),user_id text,source text,order_id text unique,activated_at timestamptz default now(),created_at timestamptz default now());
${original}
revoke all on function public.sunland_activate_pro_from_payment(text,text) from public,anon,authenticated;
grant execute on function public.sunland_activate_pro_from_payment(text,text) to service_role;
insert into public.user_profiles(user_id,pro) values('legacy',true),('w',false),('b',false),('manual',false),('retry',false),('pending',false),('two',false),('off',false),('rollback',false),('inactive',false),('race',false),('afdian',false);
grant select,insert,update on public.user_profiles to service_role;`);
const before = (await db.query('select * from public.user_profiles order by user_id')).rows;
assert.equal((await db.query("select md5(pg_get_functiondef('public.sunland_activate_pro_from_payment(text,text)'::regprocedure)) as hash")).rows[0].hash,'dc1110b67ee43b6ba2c02da43065b603');
await db.exec(migration);
assert.deepEqual((await db.query('select * from public.user_profiles order by user_id')).rows,before);
let checks = 1;
async function rpc(name, event) {
  const { rows } = await db.query(`select public.${name}($1::jsonb) as result`, [JSON.stringify(event)]);
  return rows[0].result;
}
async function status(user,request) { return (await db.query('select public.sunland_waffo_status($1,$2::uuid) as result',[user,request])).rows[0].result; }
async function isPro(user) { return (await db.query('select pro from public.user_profiles where user_id=$1',[user])).rows[0]?.pro; }
const uu = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const config = {mode:'prod',merchant_id:'MER_6mey7SY5b0KXN1W7JiZYSz',store_id:'STO_4gmpGF9UEj1SO6vpelNcmy',product_id:'PROD_5buXbrDEzQX6Nya6p1wMC5',currency:'CNY',amount_minor:1500};
async function intent(user,n) {
 const data={...config,user_id:user,payment_reference:uu(n),request_key:uu(n)};
 const r=await rpc('sunland_waffo_register_intent',data);
 assert.equal(r.paymentReference,uu(n)); return data;
}
function completed(i,n,overrides={}) { return {...config,user_id:i.user_id,payment_reference:i.payment_reference,order_id:`ORD_${n}`,payment_id:`PAY_${n}`,event_id:`PAY_${n}`,event_type:'order.completed',event_sha256:'a'.repeat(64),proof_sha256:'b'.repeat(64),charged_minor:1500,payment_status:'succeeded',order_status:'completed',entitlement_enabled:true,...overrides}; }
function refund(e,n,overrides={}) { return {...e,event_type:'refund.succeeded',event_id:`${['TKT_','RFD-',''][n%3]}${n}x`,event_sha256:'c'.repeat(64),refund_status:'succeeded',...overrides}; }
async function reject(event,code) {
 await assert.rejects(()=>rpc('sunland_waffo_apply_event',event),e=>e.message.includes(code)); checks++;
}
const i=await intent('w',1),e=completed(i,1);
assert.equal((await rpc('sunland_waffo_apply_event',e)).entitlementState,'granted'); assert.equal(await isPro('w'),true);checks++;
const firstVersion=(await status('w',uu(1))).version;
assert.equal((await rpc('sunland_waffo_apply_event',e)).status,'duplicate');assert.equal((await status('w',uu(1))).version,firstVersion);checks++;
assert.equal((await rpc('sunland_waffo_apply_event',refund(e,1))).entitlementState,'revoked');assert.equal(await isPro('w'),false);checks++;
assert.equal((await rpc('sunland_waffo_apply_event',e)).entitlementState,'revoked');assert.equal(await isPro('w'),false);checks++;
const fi=await intent('b',2),fe=completed(fi,2);
await rpc('sunland_waffo_apply_event',refund(fe,2));await rpc('sunland_waffo_apply_event',fe);assert.equal(await isPro('b'),false);checks++;
// Legacy snapshot survives Waffo refund.
const li=await intent('legacy',3),le=completed(li,3);
await rpc('sunland_waffo_apply_event',le);await rpc('sunland_waffo_apply_event',refund(le,3));assert.equal(await isPro('legacy'),true);checks++;
// Two independent Waffo sources: refund one does not revoke the other.
const ti=await intent('two',4),te=completed(ti,4),ti2=await intent('two',5),te2=completed(ti2,5);
await rpc('sunland_waffo_apply_event',te);await rpc('sunland_waffo_apply_event',te2);
await rpc('sunland_waffo_apply_event',refund(te,4));assert.equal(await isPro('two'),true);
await rpc('sunland_waffo_apply_event',refund(te2,5));assert.equal(await isPro('two'),false);checks++;
// Legacy 2arg already_pro captures its own source even though it writes no profile/activation.
const ri=await intent('retry',6),re=completed(ri,6);await rpc('sunland_waffo_apply_event',re);
assert.equal((await db.query("select sunland_activate_pro_from_payment('retry','legacy-order-6') as result")).rows[0].result.status,'already_pro');
await rpc('sunland_waffo_apply_event',refund(re,6));assert.equal(await isPro('retry'),true);checks++;
// Any existing pro=true writer is captured, including a no-op true update.
const mi=await intent('manual',7),me=completed(mi,7);await rpc('sunland_waffo_apply_event',me);
await db.exec("update user_profiles set pro=true where user_id='manual'");
await rpc('sunland_waffo_apply_event',refund(me,7));assert.equal(await isPro('manual'),true);checks++;
await db.exec("update user_profiles set pro=false where user_id='manual'");
await rpc('sunland_waffo_apply_event',me);assert.equal(await isPro('manual'),false);checks++;
// Afdian/support RPCs upsert pro=true as service_role even for a Waffo-only Pro user; still captured.
const ui=await intent('afdian',13),ue=completed(ui,13);await rpc('sunland_waffo_apply_event',ue);
await db.exec("set role service_role; insert into public.user_profiles(user_id,pro) values('afdian',true) on conflict(user_id) do update set pro=true, updated_at=now(); reset role;");
await rpc('sunland_waffo_apply_event',refund(ue,13));assert.equal(await isPro('afdian'),true);checks++;
// Disable grant while preserving paid proof; retrying identical event after enable grants.
const pi=await intent('pending',8),pe=completed(pi,8,{entitlement_enabled:false});
await rpc('sunland_waffo_apply_event',pe);assert.equal(await isPro('pending'),false);
assert.equal((await status('pending',uu(8))).paymentConfirmed,true);
assert.equal((await rpc('sunland_waffo_apply_event',{...pe,entitlement_enabled:true})).entitlementState,'granted');assert.equal(await isPro('pending'),true);checks++;
// Disabling grants must not disable refunds.
await rpc('sunland_waffo_apply_event',refund(pe,8,{entitlement_enabled:false}));assert.equal(await isPro('pending'),false);checks++;
// refund.failed is immutable audit only; it neither tombstones nor revokes.
const oi=await intent('off',9),oe=completed(oi,9);
await rpc('sunland_waffo_apply_event',refund(oe,9,{event_type:'refund.failed',refund_status:'failed'}));await rpc('sunland_waffo_apply_event',oe);assert.equal(await isPro('off'),true);checks++;
for (const [key,value] of Object.entries({mode:'test',merchant_id:'MER_wrong',store_id:'STO_wrong',product_id:'PROD_wrong',currency:'USD',order_id:'wrong',payment_id:'wrong',event_id:'bad id',event_sha256:'wrong'})) await reject({...e,[key]:value},'WAFFO_INVALID_EVENT');
for (const [key,value] of Object.entries({amount_minor:1400,charged_minor:1600,payment_status:'failed',order_status:'canceled',proof_sha256:'bad',entitlement_enabled:'true'})) await reject({...e,[key]:value},'WAFFO_INVALID_PAYMENT_PROOF');
await reject({...e,user_id:'legacy'},'WAFFO_INTENT_USER_MISMATCH');
await reject({...e,event_sha256:'d'.repeat(64)},'WAFFO_EVENT_CONFLICT');
await reject({...oe,proof_sha256:'d'.repeat(64)},'WAFFO_PAYMENT_PROOF_CONFLICT');
// No cross-user or order/payment/reference reuse.
const racei=await intent('race',10),racee=completed(racei,10);
await reject({...racee,order_id:oe.order_id,payment_id:oe.payment_id,event_id:oe.payment_id},'WAFFO_ORDER_BINDING_CONFLICT');
await assert.rejects(()=>rpc('sunland_waffo_apply_event',{...racee,payment_id:oe.payment_id,event_id:oe.payment_id}),/duplicate key/);checks++;
await assert.rejects(()=>rpc('sunland_waffo_apply_event',{...oe,order_id:'ORD_another'}),/duplicate key/);checks++;
// Atomic crash/failure injection after source insertion but before profile write.
const ai=await intent('rollback',11),ae=completed(ai,11);
await db.exec(`create function public.fail_waffo_projection() returns trigger language plpgsql as $$begin if new.user_id='rollback' and new.pro=true then raise exception 'INJECTED_FAILURE'; end if; return new; end;$$;
create trigger fail_projection before update of pro on public.user_profiles for each row execute function public.fail_waffo_projection();`);
await reject(ae,'INJECTED_FAILURE');
assert.equal(await isPro('rollback'),false);assert.equal((await status('rollback',uu(11))).version,0);
assert.equal((await db.query("select count(*)::int as n from waffo_prod.projection_context")).rows[0].n,0);checks++;
await db.exec('drop trigger fail_projection on public.user_profiles; drop function public.fail_waffo_projection();');
await rpc('sunland_waffo_apply_event',ae);assert.equal(await isPro('rollback'),true);checks++;
// Lost response / D1 mirror failure: same event converges to the committed version.
const committed=await status('rollback',uu(11));assert.deepEqual(await rpc('sunland_waffo_apply_event',ae),{...committed,status:'duplicate'});checks++;
await db.exec("update user_profiles set identity_status='retired' where user_id='inactive'");
await assert.rejects(()=>intent('inactive',12),/ACCOUNT_NOT_ACTIVE/);checks++;
assert.deepEqual(await status('legacy',uu(11)),{paymentConfirmed:false,entitlementState:null,version:0});checks++;
// JWT claims and GUCs cannot forge the protected projection context.
for(const role of ['anon','authenticated']) {
 await db.exec(`set role ${role}`);
 await assert.rejects(()=>rpc('sunland_waffo_apply_event',e),/permission denied/);
 await assert.rejects(()=>rpc('sunland_waffo_register_intent',i),/permission denied/);
 await assert.rejects(()=>status('w',uu(1)),/permission denied/);
 await assert.rejects(()=>db.query('select * from waffo_prod.entitlement_sources'),/permission denied/);
 await assert.rejects(()=>db.query('insert into waffo_prod.projection_context values(1,\'w\')'),/permission denied/);
 await db.exec('reset role');checks++;
}
await db.exec('set role service_role');assert.equal((await status('rollback',uu(11))).entitlementState,'granted');
await assert.rejects(()=>db.query('select * from waffo_prod.entitlement_sources'),/permission denied/);await db.exec('reset role');checks++;
assert.equal((await db.query('select count(*)::int as n from waffo_prod.projection_context')).rows[0].n,0);checks++;
await db.close();
// Migration order vs verified-reconciliation: a replacement 2-arg RPC that never writes
// user_profiles is accepted and left untouched; any other changed definition fails closed.
async function guardDb(fn) {
 const g=new PGlite();
 await g.exec(`create role anon; create role authenticated; create role service_role;
create table public.user_profiles(user_id text primary key,pro boolean default false,identity_status text default 'active',is_banned boolean default false,updated_at timestamptz default now());
create function public.sunland_activate_pro_from_payment(p_user_id text,p_order_id text) returns jsonb language plpgsql as $f$begin ${fn} return '{}'::jsonb; end;$f$;`);
 return g;
}
const replaced=await guardDb('perform 1;');await replaced.exec(migration);
assert.equal((await replaced.query("select prosrc ~ 'capture_legacy_payment' as patched from pg_proc where proname='sunland_activate_pro_from_payment'")).rows[0].patched,false);
await replaced.close();checks++;
const tampered=await guardDb("update public.user_profiles set pro=true where user_id=p_user_id;");
await assert.rejects(()=>tampered.exec(migration),/WAFFO_LEGACY_RPC_CHANGED/);await tampered.close();checks++;
console.log(`Waffo source SQL: ${checks} real PostgreSQL regression checks passed; no network/database writes.`);
