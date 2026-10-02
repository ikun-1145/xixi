-- LOCAL CANDIDATE ONLY. 未单独授权前禁止执行；不属于 supabase/migrations。
-- PATCH 003：webhook ingest 改用专用 GoTrue ingest bot 的标准 access token（role=authenticated），
--   不再需要自定义 signing key 签发 waffo_test_ingest 令牌。作用于已执行的 PATCH 002。
-- 身份只来自 PostgREST 验签后的 claims.sub，且须在独立 ingest_principals 中 enabled；与 test_subjects 互斥。
--   普通 authenticated / checkout 测试用户调用 record_event → 42501。
--   waffo_test_ingest 收回全部 waffo_test 权限（角色与 authenticator 成员关系保留：无额外权限，便于回滚）。
--   不动 auth、生产对象、JWT/Signing Keys；不创建 GoTrue 用户（bot 登记另行执行）。
begin;
do $$
begin
  if current_setting('waffo_test.target_ack', true) is distinct from 'existing-project-test-schema-only' then
    raise exception 'explicit test schema acknowledgement required' using errcode = '55000';
  end if;
  -- 只接受 PATCH 002 之后的状态；不符即中止。
  if (select md5(p.prosrc) from pg_catalog.pg_proc as p
      where p.oid = pg_catalog.to_regprocedure('waffo_test.record_event(text,text,text,text,text,text,text,uuid,text,text)'))
      is distinct from '8a8ad8d02cd7e3341f8b53143a609645'
    or (select count(*) from pg_catalog.pg_policies
      where schemaname = 'waffo_test' and policyname in ('intents_ingest_read', 'ledger_ingest_read', 'ledger_ingest_insert')
        and roles = array['waffo_test_ingest']::name[]) <> 3
    or pg_catalog.to_regclass('waffo_test.ingest_principals') is not null
    or pg_catalog.has_function_privilege('authenticated',
      'waffo_test.record_event(text,text,text,text,text,text,text,uuid,text,text)', 'EXECUTE')
    or exists (
      select 1 from pg_catalog.pg_proc as p join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
      where n.nspname = 'waffo_test' and p.prosecdef
    ) then
    raise exception 'unexpected waffo_test state' using errcode = '55000';
  end if;
end;
$$;

-- ingest 身份白名单：与 checkout 的 test_subjects 分表，只允许一个 bot。
create table waffo_test.ingest_principals (
  user_id uuid primary key,
  label text not null unique check (label = 'ingest_bot'),
  enabled boolean not null default true
);
alter table waffo_test.ingest_principals enable row level security;
revoke all on waffo_test.ingest_principals from public, anon, authenticated, service_role, waffo_test_checkout, waffo_test_ingest;
-- policy / record_event 为 invoker，需能读到"自己"这一行；他人只得 0 行。
grant select on waffo_test.ingest_principals to authenticated;
create policy ingest_self on waffo_test.ingest_principals for select to authenticated
  using (user_id = (select waffo_test.jwt_uid()));

-- 复用原 ingest policy 名，改授 authenticated 且限 enabled bot（与旧 waffo_test_ingest 直写信任级别一致，CHECK/FK 仍生效）。
grant select, insert on waffo_test.event_ledger to authenticated;
alter policy ledger_ingest_read on waffo_test.event_ledger to authenticated
  using (exists (select 1 from waffo_test.ingest_principals as b where b.user_id = (select waffo_test.jwt_uid()) and b.enabled));
alter policy ledger_ingest_insert on waffo_test.event_ledger to authenticated
  with check (exists (select 1 from waffo_test.ingest_principals as b where b.user_id = (select waffo_test.jwt_uid()) and b.enabled));
alter policy intents_ingest_read on waffo_test.payment_intents to authenticated
  using (exists (select 1 from waffo_test.ingest_principals as b where b.user_id = (select waffo_test.jwt_uid()) and b.enabled));

-- ingest 单一路径：旧 test 角色不再可用。
revoke all on all tables in schema waffo_test from waffo_test_ingest;
revoke usage on schema waffo_test from waffo_test_ingest;

-- 同签名同返回类型原位替换，保留 OID；仅身份守卫改变，其余逻辑与 PATCH 002 逐字一致。
create or replace function waffo_test.record_event(
  p_mode text, p_store_id text, p_event_type text, p_event_id text,
  p_delivery_id text, p_order_id text, p_payment_id text,
  p_reference uuid, p_body_sha256 text, p_observation_code text
)
returns table (result text)
language plpgsql security invoker set search_path = pg_catalog
as $fn$
declare
  v_uid uuid := waffo_test.jwt_uid();
  v_bound uuid;
  v_inserted integer;
  v_existing waffo_test.event_ledger%rowtype;
begin
  if current_user <> 'authenticated' or v_uid is null
    or not exists (select 1 from waffo_test.ingest_principals as b where b.user_id = v_uid and b.enabled)
    or exists (select 1 from waffo_test.test_subjects as s where s.user_id = v_uid) then
    raise exception 'ingest principal required' using errcode = '42501';
  end if;
  if p_mode is distinct from 'test' or p_store_id is null or p_event_type is null
    or p_event_id is null or p_delivery_id is null or p_body_sha256 is null
    or p_observation_code is null
    or p_observation_code not in ('valid_observation', 'invalid_observation', 'unbound') then
    raise exception 'test observation required' using errcode = '22023';
  end if;
  select i.payment_reference into v_bound from waffo_test.payment_intents as i
    where i.payment_reference = p_reference;
  insert into waffo_test.event_ledger (
    mode, store_id, event_type, event_id, delivery_id, order_id, payment_id,
    reported_reference, bound_reference, body_sha256, observation_code
  ) values (
    p_mode, p_store_id, p_event_type, p_event_id, p_delivery_id, p_order_id, p_payment_id,
    p_reference, v_bound, p_body_sha256,
    case when v_bound is null then 'unbound' else p_observation_code end
  ) on conflict (store_id, event_type, event_id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 1 then return query select 'recorded'::text; return; end if;
  select e.* into v_existing from waffo_test.event_ledger as e
    where e.store_id = p_store_id and e.event_type = p_event_type and e.event_id = p_event_id;
  -- 同一业务事件不允许静默覆盖绑定/正文；只返回冲突，无 UPDATE 或权益副作用。
  if v_existing.body_sha256 is distinct from p_body_sha256
    or v_existing.reported_reference is distinct from p_reference then
    return query select 'conflict'::text;
  else
    return query select 'duplicate'::text;
  end if;
end;
$fn$;
revoke all on function waffo_test.record_event(text,text,text,text,text,text,text,uuid,text,text)
  from public, anon, authenticated, service_role, waffo_test_checkout, waffo_test_ingest;
grant execute on function waffo_test.record_event(text,text,text,text,text,text,text,uuid,text,text)
  to authenticated;

-- 自检：authenticated 在 waffo_test 内只有白名单权限；旧 ingest 角色、anon、service_role 触达不到；
-- bot 与 checkout 测试用户互斥。任一不符整笔回滚。
do $$
begin
  if (select count(*) from pg_catalog.pg_policies
      where schemaname = 'waffo_test' and policyname in ('intents_ingest_read', 'ledger_ingest_read', 'ledger_ingest_insert')
        and roles = array['authenticated']::name[]
        and coalesce(qual, with_check) like '%ingest_principals%') <> 3
    or exists (select 1 from pg_catalog.pg_policies where schemaname = 'waffo_test' and 'waffo_test_ingest' = any(roles))
    or exists (
      select 1 from (values ('test_subjects'), ('payment_intents'), ('event_ledger'), ('ingest_principals')) as t(rel)
      cross join lateral (values ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) as w(priv)
      where pg_catalog.has_any_column_privilege('authenticated', 'waffo_test.' || t.rel, w.priv)
        and (t.rel, w.priv) not in (('test_subjects', 'SELECT'), ('payment_intents', 'SELECT'), ('payment_intents', 'INSERT'),
          ('event_ledger', 'SELECT'), ('event_ledger', 'INSERT'), ('ingest_principals', 'SELECT'))
    ) or exists (
      select 1 from (values ('test_subjects'), ('payment_intents'), ('event_ledger'), ('ingest_principals')) as t(rel)
      cross join lateral (values ('DELETE'), ('TRUNCATE'), ('TRIGGER'), ('MAINTAIN')) as w(priv)
      where pg_catalog.has_table_privilege('authenticated', 'waffo_test.' || t.rel, w.priv)
    ) or pg_catalog.has_table_privilege('authenticated', 'waffo_test.payment_intents', 'INSERT')
    or not pg_catalog.has_function_privilege('authenticated',
      'waffo_test.record_event(text,text,text,text,text,text,text,uuid,text,text)', 'EXECUTE')
    or exists (
      select 1 from unnest(array['public', 'anon', 'service_role', 'waffo_test_checkout', 'waffo_test_ingest']) as r(role)
      where pg_catalog.has_schema_privilege(r.role, 'waffo_test', 'USAGE')
        or pg_catalog.has_function_privilege(r.role,
          'waffo_test.record_event(text,text,text,text,text,text,text,uuid,text,text)', 'EXECUTE')
    ) or exists (
      select 1 from pg_catalog.pg_class as c
      where c.relnamespace = 'waffo_test'::regnamespace and c.relkind in ('r', 'p') and not c.relrowsecurity
    ) or exists (
      select 1 from waffo_test.ingest_principals as b join waffo_test.test_subjects as s on s.user_id = b.user_id
    ) or exists (
      select 1 from pg_catalog.pg_proc as p join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
      where n.nspname = 'waffo_test' and p.prosecdef
    ) then
    raise exception 'authenticated ingest privileges out of bounds' using errcode = '55000';
  end if;
end;
$$;
notify pgrst, 'reload schema';
commit;
