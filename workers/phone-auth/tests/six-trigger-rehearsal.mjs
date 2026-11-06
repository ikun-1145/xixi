// Isolated in-memory PGlite only. No production data or credentials.
// Reviewed local migration files are extracted; dependencies are synthetic.
// This is not a complete schema, a real PostgreSQL server, or a concurrency test.
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
if (!process.env.PHONE_PREFLIGHT_PACKAGE_ROOT || !process.env.PHONE_XIXI_SOURCE_ROOT || !process.env.PHONE_SUNLAND_SOURCE_ROOT) throw Error('Set PHONE_PREFLIGHT_PACKAGE_ROOT, PHONE_XIXI_SOURCE_ROOT and PHONE_SUNLAND_SOURCE_ROOT');
const require=createRequire(resolve(process.env.PHONE_PREFLIGHT_PACKAGE_ROOT,'package.json'));
const {PGlite}=require('@electric-sql/pglite');
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const read=path=>readFile(path,'utf8');
const quota=await read(resolve(process.env.PHONE_SUNLAND_SOURCE_ROOT,'supabase/migrations/20261009005912_ai_daily_quota_ledger.sql'));
const history=await read(resolve(process.env.PHONE_SUNLAND_SOURCE_ROOT,'supabase/migrations/20261009010000_conversation_compare_and_swap.sql'));
const pay=await read(resolve(process.env.PHONE_XIXI_SOURCE_ROOT,'supabase/migrations/20261002071010_waffo_production_entitlement_sources.sql'));
const phone=await read(resolve(process.env.PHONE_XIXI_SOURCE_ROOT,'supabase/migrations/20261024003756_phone_identity.sql'));
const test=await read(new URL('./initialization-full-postgres.py',import.meta.url));
const extract=(s,re)=>{const m=s.match(re);if(!m)throw Error('Missing migration section '+re);return m[0];};
const createTable=(src,name)=>extract(src,new RegExp('create table '+name.replace('.','\\.')+'\\s*\\([\\s\\S]*?\\n\\);','i'));
const createFunc=(src,name)=>extract(src,new RegExp('create function '+name.replace('.','\\.')+'\\(\\)\\s+returns trigger[\\s\\S]*?as (\\$\\w*\\$)[\\s\\S]*?\\1;','i'));
const createTrigger=(src,name)=>extract(src,new RegExp('create trigger '+name+'\\s+[\\s\\S]*?execute function [\\w.]+\\(\\);','i'));
const pyInit=await read(new URL('../operations/initialize-db.py',import.meta.url));
const update=extract(pyInit,/UPDATE public\.sunland_phone_auth_config[\s\S]*?RETURNING singleton/).replace('%s',"'v1'").replace('%s',"repeat('a',64)");
const m=test.match(/conn\.execute\('''(create table public\.user_profiles[\s\S]*?)'''\)/);if(!m)throw Error('Missing isolated profile tables');
const db=new PGlite();
try {
 await db.exec("create role anon;create role authenticated;create role service_role;create schema extensions;create function extensions.gen_random_uuid() returns uuid language sql volatile as $$ select pg_catalog.gen_random_uuid() $$;"+m[1]);
 for (const name of ['public.ai_quota_days','public.ai_quota_requests']) await db.exec(createTable(quota,name));
 await db.exec(createTable(history,'public.conversation_sync_receipts'));
 await db.exec('create schema waffo_prod;');
 for (const name of ['waffo_prod.payment_intents','waffo_prod.orders','waffo_prod.entitlement_sources','waffo_prod.projection_context']) await db.exec(createTable(pay,name));
 for(const [src,name] of [[quota,'public.ai_quota_cleanup_retired_account'],[history,'public.sunland_history_cleanup_retired_account'],[pay,'waffo_prod.capture_profile_source']]) await db.exec(createFunc(src,name));
 // Synthetic function follows the observed production timestamp trigger semantics.
 await db.exec('create function public.set_updated_at() returns trigger language plpgsql as $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;');
 for(const [src,name] of [[quota,'ai_quota_cleanup_retired_account'],[history,'sunland_history_cleanup_retired_account'],[pay,'waffo_capture_profile_insert'],[pay,'waffo_capture_profile_update']]) await db.exec(createTrigger(src,name));
 await db.exec('CREATE TRIGGER trg_user_profiles_updated_at BEFORE UPDATE ON public.user_profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();');
 await db.exec(phone);
 const expected={ai_quota_cleanup_retired_account:'d11662e112e667afaca80d3e1e31c40c',sunland_history_cleanup_retired_account:'f16a533e0bc8f3c61222da01c451650d',capture_profile_source:'49d3fdc3b25e11f16c3580cafac6e902',set_updated_at:'a27bb088c067b7b77a9f0707b0048e40',sunland_phone_identity_lifecycle:'89e753458b07653b31091b43584e03f3'};
 const funcs=await db.query("SELECT proname,md5(regexp_replace(prosrc,'\\s+',' ','g')) AS digest FROM pg_proc WHERE proname=ANY(ARRAY['ai_quota_cleanup_retired_account','sunland_history_cleanup_retired_account','capture_profile_source','set_updated_at','sunland_phone_identity_lifecycle'])");
 assert.equal(funcs.rows.length,5);for(const f of funcs.rows)assert.equal(f.digest,expected[f.proname],f.proname);
 const t=await db.query("SELECT count(*)::int AS c FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='user_profiles' AND NOT t.tgisinternal");assert.equal(t.rows[0].c,6);
 await db.exec("insert into public.user_profiles(user_id) values('synthetic');");
 await db.exec('BEGIN;SELECT pg_advisory_xact_lock(20261024,2);LOCK TABLE public.sunland_phone_identities,public.sunland_phone_auth_state,public.sunland_phone_auth_grants,public.sunland_phone_auth_operations IN SHARE ROW EXCLUSIVE MODE;'+update+';COMMIT;');
 const cfg=await db.query("select lookup_key_id='v1' and lookup_check=repeat('a',64) as ok from public.sunland_phone_auth_config where singleton");assert.equal(cfg.rows[0].ok,true);
 await db.exec("update public.user_profiles set pro=true where user_id='synthetic';");
 const x=await db.query("select count(*)::int as n from waffo_prod.entitlement_sources where user_id='synthetic' and active");assert.equal(x.rows[0].n,1);
 await db.exec(`
 insert into public.ai_quota_days(user_id,usage_date) values('synthetic',current_date);
 insert into public.ai_quota_requests(user_id,request_id,payload_hash,usage_date) values('synthetic','synthetic-request',repeat('a',64),current_date);
 insert into public.conversation_sync_receipts(user_id,operation_id,payload_hash) values('synthetic','synthetic-operation','synthetic-hash');
 insert into public.sunland_phone_auth_state(user_id) values('synthetic');
 insert into public.sunland_phone_auth_operations(operation_id,request_hash,user_id,action,result) values(gen_random_uuid(),repeat('b',64),'synthetic','login','{}');
 update public.user_profiles set identity_status='retired' where user_id='synthetic';
 `);
 for(const table of ['public.ai_quota_requests','public.ai_quota_days','public.conversation_sync_receipts','public.sunland_phone_auth_operations']){
  const rows=await db.query(`select count(*)::int as n from ${table} where user_id='synthetic'`);assert.equal(rows.rows[0].n,0,table);
 }
 const state=await db.query("select version from public.sunland_phone_auth_state where user_id='synthetic'");assert.equal(Number(state.rows[0].version),1);
 console.log('PASS: six trigger definitions, actual phone migration, synthetic dependencies; single-backend PGlite (not full schema/concurrency)');
}finally{await db.close();}
