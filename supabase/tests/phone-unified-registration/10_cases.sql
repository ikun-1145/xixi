\set ON_ERROR_STOP on
create or replace function pg_temp.d(op text, cand text, phone text, email text, rh text default null) returns jsonb language sql as $$
  select jsonb_build_object('operation_id',op,'candidate_id',cand,'request_hash',coalesce(rh,encode(sha256(convert_to(op||email,'UTF8')),'hex')),
    'phone_hash',encode(sha256(convert_to(phone,'UTF8')),'hex'),'encrypted_phone','ciphertext','last4','0000','email',email,
    'lookup_key_id','v1','lookup_check',repeat('c',64)) $$;
create or replace function pg_temp.h(t text) returns text language sql as $$ select encode(sha256(convert_to(t,'UTF8')),'hex') $$;
create or replace function pg_temp.ok(c boolean, label text) returns void language plpgsql as $$
begin if c is not true then raise exception 'FAIL: %', label; end if; raise notice 'PASS: %', label; end $$;
create or replace function pg_temp.reserve(subj text, req uuid, code text) returns void language sql as $$
  select public.sunland_otp('reserve',pg_temp.h(subj),pg_temp.h('ip'),req,pg_temp.h(code)) $$;

-- Permissions and function hardening.
select pg_temp.ok(p.prosecdef, 'SECURITY DEFINER'),
       pg_temp.ok(p.proconfig = array['search_path=pg_catalog, public'], 'fixed search_path'),
       pg_temp.ok(not has_function_privilege('public', p.oid, 'execute') is distinct from false and
                  not exists(select 1 from aclexplode(p.proacl) a where a.grantee = 0), 'PUBLIC execute revoked'),
       pg_temp.ok(not has_function_privilege('anon', p.oid, 'execute'), 'anon denied'),
       pg_temp.ok(not has_function_privilege('authenticated', p.oid, 'execute'), 'authenticated denied'),
       pg_temp.ok(has_function_privilege('service_role', p.oid, 'execute'), 'service_role allowed')
from pg_proc p where p.oid = 'public.sunland_phone_register_unified(jsonb,text,text,uuid,text)'::regprocedure;

set role service_role;
-- T1 success consumes OTP and creates profile + identity + operation atomically.
select pg_temp.reserve('s1','11111111-1111-4111-8111-111111111111','111111');
select pg_temp.ok(public.sunland_phone_register_unified(pg_temp.d('aaaaaaaa-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001','p1','one@example.test'),
  pg_temp.h('s1'),pg_temp.h('ip'),'11111111-1111-4111-8111-111111111111',pg_temp.h('111111'))->>'code'='OK','T1 register OK');
select pg_temp.ok((select state from public.sunland_otp_challenges where subject=pg_temp.h('s1'))='consumed','T1 OTP consumed');
select pg_temp.ok((select count(*) from public.sunland_phone_identities where phone_hash=pg_temp.h('p1'))=1,'T1 identity created');

-- T2 lost response: same operation retried after OTP already consumed returns same account.
select pg_temp.ok((select r->>'code'='OK' and r->>'user_id'='c0000000-0000-4000-8000-000000000001' from (select public.sunland_phone_register_unified(
  pg_temp.d('aaaaaaaa-0000-4000-8000-000000000001','c9999999-0000-4000-8000-000000000009','p1','one@example.test'),
  pg_temp.h('s1'),pg_temp.h('ip'),gen_random_uuid(),pg_temp.h('000000')) r) x),'T2 idempotent retry');
select pg_temp.ok((select count(*) from public.user_profiles)=1,'T2 no duplicate account');

-- T3 OTP one-time: a new operation cannot reuse the consumed email code.
select pg_temp.ok(public.sunland_phone_register_unified(pg_temp.d('aaaaaaaa-0000-4000-8000-000000000003','c0000000-0000-4000-8000-000000000003','p3','one@example.test'),
  pg_temp.h('s1'),pg_temp.h('ip'),'11111111-1111-4111-8111-111111111111',pg_temp.h('111111'))->>'code'='INVALID','T3 OTP single use');

-- T4 operation reused with different email (request hash differs) conflicts.
select pg_temp.ok(public.sunland_phone_register_unified(pg_temp.d('aaaaaaaa-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000004','p1','other@example.test'),
  pg_temp.h('s1'),pg_temp.h('ip'),gen_random_uuid(),pg_temp.h('000000'))->>'code'='OPERATION_CONFLICT','T4 operation conflict');

-- T5 wrong code: no account, failure counted, code remains usable.
select pg_temp.reserve('s5','55555555-5555-4555-8555-555555555555','555555');
select pg_temp.ok(public.sunland_phone_register_unified(pg_temp.d('aaaaaaaa-0000-4000-8000-000000000005','c0000000-0000-4000-8000-000000000005','p5','five@example.test'),
  pg_temp.h('s5'),pg_temp.h('ip'),'55555555-5555-4555-8555-555555555555',pg_temp.h('000000'))->>'code'='INVALID','T5 wrong code');
select pg_temp.ok((select failures=1 and state='ready' from public.sunland_otp_challenges where subject=pg_temp.h('s5')),'T5 failure counted, code usable');
select pg_temp.ok(not exists(select 1 from public.user_profiles where email='five@example.test'),'T5 no account');

-- T6 existing email is never merged.
select pg_temp.reserve('s6','66666666-6666-4666-8666-666666666666','666666');
select pg_temp.ok(public.sunland_phone_register_unified(pg_temp.d('aaaaaaaa-0000-4000-8000-000000000006','c0000000-0000-4000-8000-000000000006','p6','ONE@example.test'),
  pg_temp.h('s6'),pg_temp.h('ip'),'66666666-6666-4666-8666-666666666666',pg_temp.h('666666'))->>'code'='INVALID_REQUEST','T6 non-normalized email rejected');
select pg_temp.ok(public.sunland_phone_register_unified(pg_temp.d('aaaaaaaa-0000-4000-8000-000000000006','c0000000-0000-4000-8000-000000000006','p6','one@example.test'),
  pg_temp.h('s6'),pg_temp.h('ip'),'66666666-6666-4666-8666-666666666666',pg_temp.h('666666'))->>'code'='EMAIL_CONFLICT','T6 email conflict');
select pg_temp.ok(not exists(select 1 from public.sunland_phone_identities where phone_hash=pg_temp.h('p6')),'T6 no phone identity');

-- T7 phone already registered.
select pg_temp.reserve('s7','77777777-7777-4777-8777-777777777777','777777');
select pg_temp.ok(public.sunland_phone_register_unified(pg_temp.d('aaaaaaaa-0000-4000-8000-000000000007','c0000000-0000-4000-8000-000000000007','p1','seven@example.test'),
  pg_temp.h('s7'),pg_temp.h('ip'),'77777777-7777-4777-8777-777777777777',pg_temp.h('777777'))->>'code'='PHONE_CONFLICT','T7 phone conflict');
reset role;

-- T8 atomicity: an unexpected failure after OTP consumption rolls back consumption and account rows.
create function public.t_fail() returns trigger language plpgsql as $$ begin raise exception 'synthetic failure'; end $$;
create trigger t_fail before insert on public.sunland_phone_identities for each row execute function public.t_fail();
set role service_role;
select pg_temp.reserve('s8','88888888-8888-4888-8888-888888888888','888888');
do $$ begin
  perform public.sunland_phone_register_unified(pg_temp.d('aaaaaaaa-0000-4000-8000-000000000008','c0000000-0000-4000-8000-000000000008','p8','eight@example.test'),
    pg_temp.h('s8'),pg_temp.h('ip'),'88888888-8888-4888-8888-888888888888',pg_temp.h('888888'));
  raise exception 'FAIL: T8 expected error';
exception when raise_exception then
  if sqlerrm <> 'synthetic failure' then raise; end if;
end $$;
select pg_temp.ok((select state='ready' from public.sunland_otp_challenges where subject=pg_temp.h('s8')),'T8 OTP consumption rolled back');
select pg_temp.ok(not exists(select 1 from public.user_profiles where email='eight@example.test'),'T8 profile rolled back');
reset role;
drop trigger t_fail on public.sunland_phone_identities;
set role service_role;
select pg_temp.ok(public.sunland_phone_register_unified(pg_temp.d('aaaaaaaa-0000-4000-8000-000000000008','c0000000-0000-4000-8000-000000000008','p8','eight@example.test'),
  pg_temp.h('s8'),pg_temp.h('ip'),'88888888-8888-4888-8888-888888888888',pg_temp.h('888888'))->>'code'='OK','T8 retry after failure succeeds');
reset role;

-- T9 anon/authenticated cannot call directly.
set role anon;
do $$ begin perform public.sunland_phone_register_unified('{}',repeat('a',64),repeat('a',64),gen_random_uuid(),repeat('a',64));
  raise exception 'FAIL: anon executed'; exception when insufficient_privilege then raise notice 'PASS: anon execute denied'; end $$;
reset role; set role authenticated;
do $$ begin perform public.sunland_phone_register_unified('{}',repeat('a',64),repeat('a',64),gen_random_uuid(),repeat('a',64));
  raise exception 'FAIL: authenticated executed'; exception when insufficient_privilege then raise notice 'PASS: authenticated execute denied'; end $$;
reset role;

-- T10 a banned account cannot be resumed through a cached registration.
update public.user_profiles set is_banned=true where user_id='c0000000-0000-4000-8000-000000000001';
set role service_role;
select pg_temp.ok(public.sunland_phone_register_unified(pg_temp.d('aaaaaaaa-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001','p1','one@example.test'),
  pg_temp.h('s1'),pg_temp.h('ip'),gen_random_uuid(),pg_temp.h('000000'))->>'code'='ACCOUNT_NOT_ACTIVE','T10 banned cached account rejected');
reset role;
