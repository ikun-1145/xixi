-- LOCAL CANDIDATE ONLY. 本轮禁止执行；不属于 supabase/migrations。
-- PATCH 003 最终状态的新建草案；不是已安装 schema 的增量补丁，禁止重复执行。
-- 现有项目内新增 Test 对象/角色的候选，不能修改任何生产表或现有函数。
-- 未来必须另行授权并核对目标；ack 只防误执行，不是授权。
begin;
do $$
begin
  if current_setting('waffo_test.target_ack', true) is distinct from 'existing-project-test-schema-only' then
    raise exception 'explicit test schema acknowledgement required' using errcode = '55000';
  end if;
end;
$$;
-- 旧 checkout / ingest 角色保留但无 waffo_test 对象权限，与 PATCH 002/003 对齐。
create role waffo_test_checkout nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
create role waffo_test_ingest nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
create schema waffo_test;
revoke all on schema waffo_test from public, anon, authenticated, service_role, waffo_test_checkout, waffo_test_ingest;
grant usage on schema waffo_test to authenticated;

-- exposed schemas 追加 waffo_test 另经 Management API 单独执行；本文件不改 PostgREST 配置。
create table waffo_test.test_subjects (
  user_id uuid primary key,
  label text not null unique check (label in ('tester_a', 'tester_b', 'tester_disabled')),
  enabled boolean not null default true
);
create table waffo_test.payment_intents (
  payment_reference uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references waffo_test.test_subjects(user_id) on delete restrict,
  status text not null default 'pending' check (status = 'pending'),
  requested_product_id text not null default 'PROD_4ibh2Jka4tSTmyb35okbRs'
    check (requested_product_id = 'PROD_4ibh2Jka4tSTmyb35okbRs'),
  requested_currency text not null default 'CNY' check (requested_currency = 'CNY'),
  expected_price_minor integer not null default 1500 check (expected_price_minor = 1500),
  created_at timestamptz not null default now()
);
-- 合并订单/事件观测账本；不存原始 payload、用户文本、JWT 或私钥。
-- requested_* 只表示 checkout 请求意图，绝不证明付款商品。
create table waffo_test.event_ledger (
  mode text not null check (mode = 'test'),
  store_id text not null check (store_id ~ '^STO_[A-Za-z0-9]+$'),
  event_type text not null check (event_type in ('order.completed', 'refund.succeeded', 'refund.failed')),
  event_id text not null check (event_id ~ '^(PAY|REF)_[A-Za-z0-9]+$'),
  delivery_id text not null check (length(delivery_id) between 1 and 128),
  order_id text check (order_id is null or order_id ~ '^ORD_[A-Za-z0-9]+$'),
  payment_id text check (payment_id is null or payment_id ~ '^PAY_[A-Za-z0-9]+$'),
  reported_reference uuid,
  bound_reference uuid references waffo_test.payment_intents(payment_reference) on delete restrict,
  body_sha256 text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
  observation_code text not null check (observation_code in ('valid_observation', 'invalid_observation', 'unbound')),
  first_seen_at timestamptz not null default now(),
  primary key (store_id, event_type, event_id),
  check (bound_reference is null or (reported_reference is not null and bound_reference = reported_reference)),
  check ((event_type = 'order.completed' and event_id like 'PAY_%')
    or (event_type in ('refund.succeeded', 'refund.failed') and event_id like 'REF_%'))
);
-- ingest 身份白名单：专用 GoTrue bot 的 user id，与 checkout 的 test_subjects 分表且互斥，只允许一个 bot。
create table waffo_test.ingest_principals (
  user_id uuid primary key,
  label text not null unique check (label = 'ingest_bot'),
  enabled boolean not null default true
);

alter table waffo_test.test_subjects enable row level security;
alter table waffo_test.payment_intents enable row level security;
alter table waffo_test.event_ledger enable row level security;
alter table waffo_test.ingest_principals enable row level security;
revoke all on all tables in schema waffo_test from public, anon, authenticated, service_role, waffo_test_checkout, waffo_test_ingest;
grant select on waffo_test.test_subjects to authenticated;
grant select on waffo_test.payment_intents to authenticated;
-- 仅 user_id 可写；引用、状态、商品和金额采用服务端默认值。
grant insert (user_id) on waffo_test.payment_intents to authenticated;
-- 账本只经 policy 放行 enabled ingest bot；普通 authenticated 读得 0 行、写入被 RLS 拒绝。
grant select, insert on waffo_test.event_ledger to authenticated;
-- policy / record_event 为 invoker，需能读到"自己"这一行；他人只得 0 行。
grant select on waffo_test.ingest_principals to authenticated;
-- 身份只读 PostgREST 设置的 request.jwt.claims，不依赖 auth schema（属 supabase_admin，
-- 管理通道无法给 test 角色授 USAGE）。role 必须等于 current_user 且 sub 为 UUID，否则 NULL。
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
grant execute on function waffo_test.jwt_uid() to authenticated;
create policy subjects_own on waffo_test.test_subjects for select to authenticated
  using (user_id = (select waffo_test.jwt_uid()));
create policy intents_own on waffo_test.payment_intents for select to authenticated
  using (user_id = (select waffo_test.jwt_uid()));
create policy intents_create_own on waffo_test.payment_intents for insert to authenticated
  with check (user_id = (select waffo_test.jwt_uid()) and exists (
    select 1 from waffo_test.test_subjects as s where s.user_id = (select waffo_test.jwt_uid()) and s.enabled
  ));
create policy intents_ingest_read on waffo_test.payment_intents for select to authenticated
  using (exists (select 1 from waffo_test.ingest_principals as b where b.user_id = (select waffo_test.jwt_uid()) and b.enabled));
create policy ledger_ingest_read on waffo_test.event_ledger for select to authenticated
  using (exists (select 1 from waffo_test.ingest_principals as b where b.user_id = (select waffo_test.jwt_uid()) and b.enabled));
create policy ledger_ingest_insert on waffo_test.event_ledger for insert to authenticated
  with check (exists (select 1 from waffo_test.ingest_principals as b where b.user_id = (select waffo_test.jwt_uid()) and b.enabled));
create policy ingest_self on waffo_test.ingest_principals for select to authenticated
  using (user_id = (select waffo_test.jwt_uid()));
-- 所有角色无 UPDATE/DELETE 权限；不持有生产 service_role。

-- 独立 schema/名字；绝不覆盖生产同名函数。
create function waffo_test.get_or_create_intent()
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

-- Test Worker 只允许本 RPC，无 public RPC 回落。
-- 调用方已完成 raw body 验签、Test/store 检查；DB 不伪称自己验过 RSA。
-- 身份只来自 PostgREST 验签后的 claims.sub，须为 enabled ingest bot 且不在 test_subjects。
create function waffo_test.record_event(
  p_mode text, p_store_id text, p_event_type text, p_event_id text,
  p_delivery_id text, p_order_id text, p_payment_id text,
  p_reference uuid, p_body_sha256 text, p_observation_code text
)
returns table (result text)
language plpgsql security invoker set search_path = pg_catalog
as $$
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
$$;
revoke all on function waffo_test.record_event(text,text,text,text,text,text,text,uuid,text,text)
  from public, anon, authenticated, service_role, waffo_test_checkout, waffo_test_ingest;
grant execute on function waffo_test.record_event(text,text,text,text,text,text,text,uuid,text,text)
  to authenticated;
-- PUBLIC 权限仍会被所有角色继承，NOINHERIT 不能屏蔽 PUBLIC，也无法按单个角色 REVOKE。
-- 因此仅标记角色“独有”的外部权限：排除 PUBLIC 普授项（pg_net / pg_cron 等扩展默认，
-- anon/authenticated 同样持有、非本方案引入、且不可按角色撤销）。这样守卫仍能抓住
-- 真正的越权（直接 GRANT、角色成员继承、SECURITY DEFINER 函数），而不因不可移除的
-- 平台基线在任何标准 Supabase 项目上恒为不可满足。
-- 检查失败则整笔事务中止，禁止为了通过而修改生产 ACL。
do $$
declare v_role text;
begin
  foreach v_role in array array['waffo_test_checkout', 'waffo_test_ingest'] loop
    if exists (
      select 1 from pg_catalog.pg_class as c join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
      cross join lateral (values ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('TRIGGER')) as w(priv)
      where n.nspname <> 'waffo_test' and n.nspname not in ('pg_catalog', 'information_schema')
        and c.relkind in ('r','p','v','m','f')
        and pg_catalog.has_table_privilege(v_role, c.oid, w.priv)
        and not pg_catalog.has_table_privilege('public', c.oid, w.priv)
    ) or exists (
      select 1 from pg_catalog.pg_namespace as n
      where n.nspname <> 'waffo_test' and n.nspname not in ('pg_catalog', 'information_schema')
        and pg_catalog.has_schema_privilege(v_role, n.oid, 'CREATE')
        and not pg_catalog.has_schema_privilege('public', n.oid, 'CREATE')
    ) or exists (
      select 1 from pg_catalog.pg_proc as p join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
      where n.nspname <> 'waffo_test' and n.nspname not in ('pg_catalog', 'information_schema')
        and p.prosecdef and pg_catalog.has_function_privilege(v_role, p.oid, 'EXECUTE')
        and not pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE')
    ) then
      raise exception 'test role inherits unsafe external privileges' using errcode = '42501';
    end if;
  end loop;
end;
$$;
-- 两个旧 Test 角色的 authenticator 成员关系与生产一致保留（无 waffo_test 权限，便于回滚），不改变原认证函数/hook。
grant waffo_test_checkout, waffo_test_ingest to authenticator;
notify pgrst, 'reload schema';
commit;
