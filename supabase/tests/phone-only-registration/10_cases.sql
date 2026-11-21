\set ON_ERROR_STOP on
create or replace function pg_temp.h(t text) returns text language sql as $$ select encode(sha256(convert_to(t,'UTF8')),'hex') $$;
create or replace function pg_temp.ok(c boolean, label text) returns void language plpgsql as $$
begin if c is not true then raise exception 'FAIL: %', label; end if; raise notice 'PASS: %', label; end $$;
create or replace function pg_temp.d(op text, cand text, phone text, rh text default null) returns jsonb language sql as $$
  select jsonb_build_object('operation_id',op,'candidate_id',cand,'request_hash',coalesce(rh,pg_temp.h(op||phone)),
    'phone_hash',pg_temp.h(phone),'encrypted_phone','ciphertext','last4','0000','lookup_key_id','v1','lookup_check',repeat('c',64)) $$;
create or replace function pg_temp.reg(op text, cand text, phone text, rh text default null) returns jsonb language sql as $$
  select public.sunland_phone_register_phone_only(pg_temp.d(op,cand,phone,rh)) $$;
create or replace function pg_temp.k() returns jsonb language sql as $$ select jsonb_build_object('lookup_key_id','v1','lookup_check',repeat('c',64)) $$;
create or replace function pg_temp.grant(u text, sess text, proof text, subj text, method text default 'phone', purpose text default 'delete') returns jsonb language sql as $$
  select public.sunland_phone_identity('grant', pg_temp.k()||jsonb_build_object('user_id',u,'session_hash',pg_temp.h(sess),
    'proof_hash',pg_temp.h(proof),'purpose',purpose,'method',method,'subject',subj)) $$;
create or replace function pg_temp.authz(u text, sess text, proof text, op text, tok text) returns jsonb language sql as $$
  select public.sunland_phone_identity('delete_authorize', pg_temp.k()||jsonb_build_object('user_id',u,'session_hash',pg_temp.h(sess),
    'proof_hash',pg_temp.h(proof),'operation_id',op,'request_hash',pg_temp.h(op||u),'token_hash',pg_temp.h(tok))) $$;

-- Permissions and hardening.
select pg_temp.ok(not p.prosecdef, 'phone-only RPC is SECURITY INVOKER'),
       pg_temp.ok(p.proconfig = array['search_path=pg_catalog, public'], 'fixed search_path'),
       pg_temp.ok(not exists(select 1 from aclexplode(p.proacl) a where a.grantee = 0), 'PUBLIC execute revoked'),
       pg_temp.ok(not has_function_privilege('anon', p.oid, 'execute'), 'anon denied'),
       pg_temp.ok(not has_function_privilege('authenticated', p.oid, 'execute'), 'authenticated denied'),
       pg_temp.ok(has_function_privilege('service_role', p.oid, 'execute'), 'service_role allowed')
from pg_proc p where p.oid = 'public.sunland_phone_register_phone_only(jsonb)'::regprocedure;

set role service_role;
-- Existing email account with its own bound phone; must stay untouched.
insert into public.user_profiles(user_id,email) values('email-user','owner@example.test');
insert into public.sunland_phone_identities(user_id,phone_hash,lookup_key_id,encrypted_phone,last4)
  values('email-user',pg_temp.h('pe'),'v1','ciphertext','0000');

-- R1 old Worker path stays blocked by the email trigger.
do $$ begin
  perform public.sunland_phone_identity('login', pg_temp.d('aaaaaaaa-0000-4000-8000-000000000000','c0000000-0000-4000-8000-000000000000','p0')||'{"allow_create":true}');
  raise exception 'FAIL: R1 old allow_create path created phone-only identity';
exception when check_violation then raise notice 'PASS: R1 old login allow_create still requires email'; end $$;
select pg_temp.ok(not exists(select 1 from public.user_profiles where user_id='c0000000-0000-4000-8000-000000000000'),'R1 nothing persisted');

-- R2 phone-only registration.
select pg_temp.ok((select r->>'code'='OK' and r->>'user_id'='c0000000-0000-4000-8000-000000000001' and r->'email'='null'::jsonb
  and (r->>'is_new_user')::boolean and r->'onboarding'='{"version":0,"step":1}'::jsonb
  from (select pg_temp.reg('aaaaaaaa-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001','p1') r) x),'R2 phone-only register OK, email null');
select pg_temp.ok((select email is null and identity_status='active' from public.user_profiles where user_id='c0000000-0000-4000-8000-000000000001'),'R2 profile has NULL email');
select pg_temp.ok(exists(select 1 from public.sunland_phone_identities where user_id='c0000000-0000-4000-8000-000000000001' and phone_hash=pg_temp.h('p1')),'R2 hashed phone identity stored');

-- R2b unified flow: a non-creating login probe with the same operation must not poison it.
select pg_temp.ok(public.sunland_phone_identity('login', pg_temp.d('aaaaaaaa-0000-4000-8000-000000000021','c0000000-0000-4000-8000-000000000020','p21')||'{"allow_create":false}')->>'code'='REGISTRATION_DISABLED','R2b probe reports unregistered');
select pg_temp.ok((select r->>'code'='OK' and r->>'user_id'='c0000000-0000-4000-8000-000000000021' and r->'email'='null'::jsonb
  from (select pg_temp.reg('aaaaaaaa-0000-4000-8000-000000000021','c0000000-0000-4000-8000-000000000021','p21') r) x),'R2b same operation then registers');
select pg_temp.ok(public.sunland_phone_identity('login', pg_temp.d('aaaaaaaa-0000-4000-8000-000000000022','c0000000-0000-4000-8000-000000000022','p21')||'{"allow_create":false}')->>'user_id'='c0000000-0000-4000-8000-000000000021','R2b later normal login finds the phone-only account');

-- R3 the trigger bypass never outlives the RPC call, even in the same transaction.
begin;
select pg_temp.reg('aaaaaaaa-0000-4000-8000-000000000031','c0000000-0000-4000-8000-000000000031','p31');
insert into public.user_profiles(user_id) values('no-email');
do $$ begin
  perform set_config('sunland.phone_only_candidate','c0000000-0000-4000-8000-000000000031',true);
  perform set_config('sunland.phone_only_candidate','',true);
  insert into public.sunland_phone_identities(user_id,phone_hash,lookup_key_id,encrypted_phone,last4) values('no-email',pg_temp.h('p32'),'v1','ciphertext','0000');
  raise exception 'FAIL: R3 marker leaked';
exception when check_violation then raise notice 'PASS: R3 direct insert after RPC still blocked'; end $$;
do $$ begin
  perform set_config('sunland.phone_only_candidate','c0000000-0000-4000-8000-000000000031',true);
  insert into public.sunland_phone_identities(user_id,phone_hash,lookup_key_id,encrypted_phone,last4) values('no-email',pg_temp.h('p33'),'v1','ciphertext','0000');
  raise exception 'FAIL: R3 marker for another user accepted';
exception when check_violation then raise notice 'PASS: R3 marker only admits its own candidate'; end $$;
rollback;

-- R4 lost response: same operation, new candidate -> same account, no duplicate.
select pg_temp.ok((select r->>'code'='OK' and r->>'user_id'='c0000000-0000-4000-8000-000000000001' and (r->>'is_new_user')::boolean
  from (select pg_temp.reg('aaaaaaaa-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000041','p1') r) x),'R4 idempotent retry');
select pg_temp.ok(not exists(select 1 from public.user_profiles where user_id='c0000000-0000-4000-8000-000000000041'),'R4 no duplicate account');
-- R5 operation reused for another phone conflicts.
select pg_temp.ok(pg_temp.reg('aaaaaaaa-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000051','p5')->>'code'='OPERATION_CONFLICT','R5 operation reuse conflicts');
-- R6 already-registered phone logs into the original account.
select pg_temp.ok((select r->>'user_id'='c0000000-0000-4000-8000-000000000001' and not (r->>'is_new_user')::boolean
  from (select pg_temp.reg('aaaaaaaa-0000-4000-8000-000000000006','c0000000-0000-4000-8000-000000000061','p1') r) x),'R6 existing phone logs in');
-- R7 phone bound to an email account logs into it; nothing is merged or created.
select pg_temp.ok((select r->>'user_id'='email-user' and r->>'email'='owner@example.test' and not (r->>'is_new_user')::boolean
  from (select pg_temp.reg('aaaaaaaa-0000-4000-8000-000000000007','c0000000-0000-4000-8000-000000000071','pe') r) x),'R7 bound phone logs into its own account');
select pg_temp.ok(not exists(select 1 from public.user_profiles where user_id='c0000000-0000-4000-8000-000000000071'),'R7 no extra profile');
-- R8 caller cannot smuggle email or allow_create.
select pg_temp.ok(public.sunland_phone_register_phone_only(pg_temp.d('aaaaaaaa-0000-4000-8000-000000000008','c0000000-0000-4000-8000-000000000081','p8')||'{"email":"owner@example.test"}')->>'code'='INVALID_REQUEST','R8 email field rejected');
select pg_temp.ok(public.sunland_phone_register_phone_only(pg_temp.d('aaaaaaaa-0000-4000-8000-000000000008','c0000000-0000-4000-8000-000000000081','p8')||'{"allow_create":false}')->>'code'='INVALID_REQUEST','R8 allow_create field rejected');
select pg_temp.ok(public.sunland_phone_register_phone_only(pg_temp.d('aaaaaaaa-0000-4000-8000-000000000008','not-a-uuid','p8'))->>'code'='INVALID_REQUEST','R8 bad candidate rejected');
select pg_temp.ok(public.sunland_phone_register_phone_only(pg_temp.d('aaaaaaaa-0000-4000-8000-000000000008','c0000000-0000-4000-8000-000000000081','p8')||'{"lookup_check":"x"}')->>'code'='PHONE_KEY_MISMATCH','R8 lookup key enforced');
-- R9 existing candidate id collision is refused.
select pg_temp.ok(pg_temp.reg('aaaaaaaa-0000-4000-8000-000000000009','c0000000-0000-4000-8000-000000000001','p9')->>'code'='OPERATION_CONFLICT','R9 candidate collision refused');
-- R10 legacy email registration unaffected.
select pg_temp.ok(public.sunland_phone_register(pg_temp.d('aaaaaaaa-0000-4000-8000-000000000010','c0000000-0000-4000-8000-000000000010','p10')||'{"email":"new@example.test"}')->>'code'='OK','R10 email registration still works');

-- D: phone reauth + delete authorization for the phone-only user.
\set U '''c0000000-0000-4000-8000-000000000001'''
select pg_temp.ok(pg_temp.grant(:U,'sess-a','proof-1',pg_temp.h('p1'))->>'code'='OK','D1 phone grant issued');
select pg_temp.ok(pg_temp.grant(:U,'sess-a','proof-x',pg_temp.h('p9'))->>'code'='REAUTH_INVALID','D2 grant for another phone refused');
select pg_temp.ok(pg_temp.grant(:U,'sess-a','proof-y','x@example.test','email')->>'code'='REAUTH_INVALID','D3 email grant refused without email');
select pg_temp.ok(pg_temp.authz('email-user','sess-a','proof-1','bbbbbbbb-0000-4000-8000-000000000001','t0')->>'code'='REAUTH_INVALID','D4 grant not usable for other account');
select pg_temp.ok(pg_temp.authz(:U,'sess-b','proof-1','bbbbbbbb-0000-4000-8000-000000000002','t0')->>'code'='REAUTH_INVALID','D5 grant not usable from other session');
select pg_temp.ok((select r->>'code'='OK' and r->>'user_id'=:U and r->>'expires_in'='600' from (select pg_temp.authz(:U,'sess-a','proof-1','bbbbbbbb-0000-4000-8000-000000000003','tok-1') r) x),'D6 delete authorized');
select pg_temp.ok((select status='pending' and token_hash=pg_temp.h('tok-1') from public.account_deletion_jobs where user_id=:U),'D6 job pending with token hash');
select pg_temp.ok(pg_temp.authz(:U,'sess-a','proof-1','bbbbbbbb-0000-4000-8000-000000000004','tok-2')->>'code'='REAUTH_INVALID','D7 consumed grant cannot authorize again');
select pg_temp.ok(pg_temp.authz(:U,'sess-a','proof-1','bbbbbbbb-0000-4000-8000-000000000003','tok-1')->>'code'='OK','D8 same operation replay returns cached result');
select pg_temp.ok((select count(*) from public.account_deletion_jobs where user_id=:U)=1,'D8 no second job');
select pg_temp.ok(pg_temp.grant(:U,'sess-a','proof-2',pg_temp.h('p1'))->>'code'='OK','D9 second grant');
select pg_temp.ok(pg_temp.authz(:U,'sess-a','proof-2','bbbbbbbb-0000-4000-8000-000000000009','tok-9')->>'code'='DELETION_CONFLICT','D9 pending job blocks parallel authorization');
select pg_temp.ok(pg_temp.grant(:U,'sess-a','proof-3',pg_temp.h('p1'))->>'code'='OK','D10 grant to expire');
update public.sunland_phone_auth_grants set issued_at=now()-interval '6 minutes', expires_at=now()-interval '1 minute' where proof_hash=pg_temp.h('proof-3');
update public.account_deletion_jobs set expires_at=now()-interval '1 second' where user_id=:U;
select pg_temp.ok(pg_temp.authz(:U,'sess-a','proof-3','bbbbbbbb-0000-4000-8000-000000000010','tok-10')->>'code'='REAUTH_INVALID','D10 expired grant refused');
update public.account_deletion_jobs set expires_at=now()+interval '10 minutes' where user_id=:U;

-- L: deletion lifecycle (mirrors begin/finalize state changes).
update public.account_deletion_jobs set status='in_progress', attempt_id='attempt-aaaaaaaaaaaaaaaa', fencing_version=1,
  lease_expires_at=now()+interval '5 minutes', recovery_expires_at=now()+interval '7 days', external_revoked_at=now() where user_id=:U;
update public.user_profiles set identity_status='deleting', deletion_job_id=(select id from public.account_deletion_jobs where user_id=:U),
  deletion_attempt_id='attempt-aaaaaaaaaaaaaaaa', deletion_fencing_version=1, deletion_started_at=now() where user_id=:U;
select pg_temp.ok(not exists(select 1 from public.sunland_phone_auth_grants where user_id=:U),'L1 deleting wipes outstanding grants');
select pg_temp.ok(pg_temp.reg('aaaaaaaa-0000-4000-8000-000000000101','c0000000-0000-4000-8000-000000000101','p1')->>'code'='ACCOUNT_NOT_ACTIVE','L2 deleting account cannot log in or re-register');
select pg_temp.ok(pg_temp.reg('aaaaaaaa-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000102','p1')->>'code'='ACCOUNT_NOT_ACTIVE','L3 cached registration cannot resurrect deleting account');
select pg_temp.ok(pg_temp.grant(:U,'sess-a','proof-4',pg_temp.h('p1'))->>'code'='ACCOUNT_NOT_ACTIVE','L4 deleting account cannot get new grants');
update public.account_deletion_jobs set data_deleted_at=now() where user_id=:U;
update public.user_profiles set identity_status='retired', retired_at=now() where user_id=:U;
select pg_temp.ok(not exists(select 1 from public.sunland_phone_identities where user_id=:U),'L5 phone released at retirement');
select pg_temp.ok(not exists(select 1 from public.sunland_phone_auth_operations where user_id=:U and action<>'release'),'L5 old operation results wiped');
select pg_temp.ok((select r->>'code'='OK' and r->>'user_id'='c0000000-0000-4000-8000-000000000103' and (r->>'is_new_user')::boolean
  from (select pg_temp.reg('aaaaaaaa-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000103','p1') r) x),'L6 old operation after retirement yields a fresh account, not the retired one');
select pg_temp.ok((select email is null and onboarding_step=1 from public.user_profiles where user_id='c0000000-0000-4000-8000-000000000103'),'L6 fresh account starts empty');
select pg_temp.ok(pg_temp.reg('aaaaaaaa-0000-4000-8000-000000000104','c0000000-0000-4000-8000-000000000104','p1')->>'user_id'='c0000000-0000-4000-8000-000000000103','L7 phone now maps only to the fresh account');
select pg_temp.ok((select identity_status='retired' from public.user_profiles where user_id=:U),'L7 retired account stays retired');
