-- LOCAL CANDIDATE ONLY. 未单独授权前禁止执行；不属于 supabase/migrations。
-- PATCH 002：Test checkout 改用 Supabase 正常签发的 GoTrue access token（role=authenticated），
--   不再需要自定义 signing key 签发 waffo_test_checkout 令牌。作用于已执行的 schema.DRAFT.sql + PATCH 001。
-- 边界：authenticated 只获 waffo_test 内最小权限；sub 必须是 enabled test_subjects，否则 42501 / 0 行。
--   waffo_test_checkout 收回全部 waffo_test 权限（角色与 authenticator 成员关系保留：无额外权限，便于回滚）。
--   ingest 路径（waffo_test_ingest / record_event）不变。不动 auth、生产对象、JWT/Signing Keys。
begin;
do $$
begin
  if current_setting('waffo_test.target_ack', true) is distinct from 'existing-project-test-schema-only' then
    raise exception 'explicit test schema acknowledgement required' using errcode = '55000';
  end if;
  -- 只接受 PATCH 001 之后的状态；不符即中止。
  if (select count(*) from pg_catalog.pg_policies
      where schemaname = 'waffo_test' and policyname in ('subjects_own', 'intents_own', 'intents_create_own')
        and roles = array['waffo_test_checkout']::name[]) <> 3
    or pg_catalog.has_schema_privilege('authenticated', 'waffo_test', 'USAGE')
    or pg_catalog.to_regprocedure('waffo_test.jwt_uid()') is null
    or pg_catalog.to_regprocedure('waffo_test.get_or_create_intent()') is null
    or exists (
      select 1 from pg_catalog.pg_proc as p join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
      where n.nspname = 'waffo_test' and p.prosecdef
    ) then
    raise exception 'unexpected waffo_test state' using errcode = '55000';
  end if;
end;
$$;

-- checkout 单一路径：旧 test 角色不再可用。
revoke all on all tables in schema waffo_test from waffo_test_checkout;
revoke usage on schema waffo_test from waffo_test_checkout;

grant usage on schema waffo_test to authenticated;
grant select on waffo_test.test_subjects to authenticated;
grant select on waffo_test.payment_intents to authenticated;
-- 只授 user_id 列：payment_reference/status/金额只能取服务端默认值并受 CHECK 约束。
grant insert (user_id) on waffo_test.payment_intents to authenticated;

alter policy subjects_own on waffo_test.test_subjects to authenticated;
alter policy intents_own on waffo_test.payment_intents to authenticated;
alter policy intents_create_own on waffo_test.payment_intents to authenticated;

-- jwt_uid() 逻辑不变：claims.role = current_user（此处即 authenticated）且 sub 为 UUID。
revoke all on function waffo_test.jwt_uid() from public, anon, authenticated, service_role, waffo_test_checkout, waffo_test_ingest;
grant execute on function waffo_test.jwt_uid() to authenticated;

-- 同签名同返回类型原位替换，保留 OID；下方显式重申 ACL。
create or replace function waffo_test.get_or_create_intent()
returns table (payment_reference uuid, status text)
language plpgsql security invoker set search_path = pg_catalog
as $$
declare v_user uuid := waffo_test.jwt_uid();
begin
  if current_user <> 'authenticated' or v_user is null or not exists (
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
grant execute on function waffo_test.get_or_create_intent() to authenticated;

-- 自检：authenticated 只有 subjects SELECT、intents SELECT + INSERT(user_id)、两函数 EXECUTE；
-- 其余角色（含旧 checkout、service_role）不得触达 checkout 路径。任一不符整笔回滚。
do $$
begin
  if (select count(*) from pg_catalog.pg_policies
      where schemaname = 'waffo_test' and policyname in ('subjects_own', 'intents_own', 'intents_create_own')
        and roles = array['authenticated']::name[]) <> 3
    or exists (
      select 1 from (values ('test_subjects'), ('payment_intents'), ('event_ledger')) as t(rel)
      cross join lateral (values ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) as w(priv)
      where pg_catalog.has_any_column_privilege('authenticated', 'waffo_test.' || t.rel, w.priv)
        and (t.rel, w.priv) not in (('test_subjects', 'SELECT'), ('payment_intents', 'SELECT'), ('payment_intents', 'INSERT'))
    ) or exists (
      select 1 from (values ('test_subjects'), ('payment_intents'), ('event_ledger')) as t(rel)
      cross join lateral (values ('DELETE'), ('TRUNCATE'), ('TRIGGER')) as w(priv)
      where pg_catalog.has_table_privilege('authenticated', 'waffo_test.' || t.rel, w.priv)
    ) or pg_catalog.has_table_privilege('authenticated', 'waffo_test.payment_intents', 'INSERT')
    or exists (
      select 1 from pg_catalog.pg_attribute as a
      where a.attrelid = 'waffo_test.payment_intents'::regclass and a.attnum > 0 and not a.attisdropped
        and a.attname <> 'user_id' and pg_catalog.has_column_privilege('authenticated', a.attrelid, a.attnum, 'INSERT')
    ) or pg_catalog.has_function_privilege('authenticated',
      'waffo_test.record_event(text,text,text,text,text,text,text,uuid,text,text)', 'EXECUTE')
    or exists (
      select 1 from unnest(array['public', 'anon', 'service_role', 'waffo_test_checkout']) as r(role)
      where pg_catalog.has_schema_privilege(r.role, 'waffo_test', 'USAGE')
        or pg_catalog.has_function_privilege(r.role, 'waffo_test.jwt_uid()', 'EXECUTE')
        or pg_catalog.has_function_privilege(r.role, 'waffo_test.get_or_create_intent()', 'EXECUTE')
    ) or pg_catalog.has_function_privilege('waffo_test_ingest', 'waffo_test.get_or_create_intent()', 'EXECUTE') then
    raise exception 'authenticated checkout privileges out of bounds' using errcode = '55000';
  end if;
end;
$$;
notify pgrst, 'reload schema';
commit;
