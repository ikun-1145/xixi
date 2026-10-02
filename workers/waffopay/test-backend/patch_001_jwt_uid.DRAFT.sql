-- LOCAL CANDIDATE ONLY. 未单独授权前禁止执行；不属于 supabase/migrations。
-- PATCH 001：waffo_test 身份读取与 auth schema 解耦（作用于已执行的 schema.DRAFT.sql）。
-- 根因：auth schema 属 supabase_admin，管理通道(postgres)无法给自建 test 角色授 auth USAGE；
--   3 条 checkout policy 与 get_or_create_intent() 调用 auth.uid()，test 角色执行即 42501。
-- 方案：新增 waffo_test.jwt_uid()，只读 PostgREST 设置的 request.jwt.claims（不读 legacy
--   request.jwt.claim.sub）；要求 claims.role = current_user 且 sub 为 UUID，否则返回 NULL（fail closed）。
-- 只改 waffo_test 内对象；不动 auth、生产表/函数、JWT/Signing Keys、Worker。record_event 未用 auth，不改。
begin;
do $$
begin
  if current_setting('waffo_test.target_ack', true) is distinct from 'existing-project-test-schema-only' then
    raise exception 'explicit test schema acknowledgement required' using errcode = '55000';
  end if;
  -- 只替换本方案自建的零参 invoker 函数；状态不符即中止。
  if not exists (
    select 1 from pg_catalog.pg_proc as p join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
    where n.nspname = 'waffo_test' and p.proname = 'get_or_create_intent'
      and pg_catalog.pg_get_function_identity_arguments(p.oid) = '' and not p.prosecdef
  ) then
    raise exception 'unexpected waffo_test.get_or_create_intent state' using errcode = '55000';
  end if;
end;
$$;

create function waffo_test.jwt_uid()
returns uuid
language sql stable security invoker set search_path = pg_catalog
as $$
  select case
    when c.claims ->> 'role' = current_user::text
      and c.claims ->> 'sub' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then (c.claims ->> 'sub')::uuid
  end
  from (select nullif(current_setting('request.jwt.claims', true), '')::jsonb as claims) as c;
$$;
revoke all on function waffo_test.jwt_uid() from public, anon, authenticated, service_role, waffo_test_checkout, waffo_test_ingest;
grant execute on function waffo_test.jwt_uid() to waffo_test_checkout;

alter policy subjects_own on waffo_test.test_subjects
  using (user_id = (select waffo_test.jwt_uid()));
alter policy intents_own on waffo_test.payment_intents
  using (user_id = (select waffo_test.jwt_uid()));
alter policy intents_create_own on waffo_test.payment_intents
  with check (user_id = (select waffo_test.jwt_uid()) and exists (
    select 1 from waffo_test.test_subjects as s where s.user_id = (select waffo_test.jwt_uid()) and s.enabled
  ));

-- 同签名同返回类型原位替换，保留 OID/ACL；下方仍显式重申 ACL。
create or replace function waffo_test.get_or_create_intent()
returns table (payment_reference uuid, status text)
language plpgsql security invoker set search_path = pg_catalog
as $$
declare v_user uuid := waffo_test.jwt_uid();
begin
  if current_user <> 'waffo_test_checkout' or v_user is null or not exists (
    select 1 from waffo_test.test_subjects as s where s.user_id = v_user and s.enabled
  ) then
    raise exception 'enrolled test user required' using errcode = '42501';
  end if;
  insert into waffo_test.payment_intents (user_id) values (v_user)
    on conflict (user_id) do nothing;
  return query select i.payment_reference, i.status
    from waffo_test.payment_intents as i where i.user_id = v_user;
end;
$$;
revoke all on function waffo_test.get_or_create_intent() from public, anon, authenticated, service_role, waffo_test_checkout, waffo_test_ingest;
grant execute on function waffo_test.get_or_create_intent() to waffo_test_checkout;

-- 自检：waffo_test 内 policy 与函数不得再引用 auth.*，否则整笔回滚。
do $$
begin
  if exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'waffo_test' and (coalesce(qual, '') || coalesce(with_check, '')) ~ '\mauth\.'
  ) or exists (
    select 1 from pg_catalog.pg_proc as p join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
    where n.nspname = 'waffo_test' and p.prosrc ~ '\mauth\.'
  ) then
    raise exception 'waffo_test still depends on auth schema' using errcode = '55000';
  end if;
end;
$$;
notify pgrst, 'reload schema';
commit;
