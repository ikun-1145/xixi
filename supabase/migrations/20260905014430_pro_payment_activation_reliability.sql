begin;

create table public.pro_payment_intents (
  payment_reference uuid primary key default extensions.gen_random_uuid(),
  user_id text not null unique check (user_id ~ '^[A-Za-z0-9][A-Za-z0-9@._+-]{0,127}$'),
  status text not null default 'pending' check (status in ('pending', 'activated')),
  created_at timestamptz not null default now(),
  activated_at timestamptz
);

create table public.pro_payment_orders (
  order_id text primary key check (order_id ~ '^[A-Za-z0-9_-]{6,128}$'),
  plan_id text not null,
  total_amount numeric(12, 2),
  paid_at timestamptz,
  bound_user_id text check (bound_user_id is null or bound_user_id ~ '^[A-Za-z0-9][A-Za-z0-9@._+-]{0,127}$'),
  binding_source text not null check (binding_source in ('intent', 'legacy', 'unresolved', 'support')),
  status text not null check (status in ('activated', 'unresolved', 'ineligible')),
  attempt_count integer not null default 1 check (attempt_count > 0),
  last_error_code text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  activated_at timestamptz,
  resolved_at timestamptz
);

create index pro_payment_orders_status_first_seen_idx
  on public.pro_payment_orders (status, first_seen_at desc);

alter table public.pro_payment_intents enable row level security;
alter table public.pro_payment_orders enable row level security;

revoke all on table public.pro_payment_intents from public, anon, authenticated;
revoke all on table public.pro_payment_orders from public, anon, authenticated;
grant select on table public.pro_payment_intents to authenticated;
grant select, insert, update, delete on table public.pro_payment_intents to service_role;
grant select, insert, update, delete on table public.pro_payment_orders to service_role;

create policy "pro_payment_intents_select_own"
  on public.pro_payment_intents
  for select
  to authenticated
  using ((select auth.jwt() ->> 'id') = user_id);

create policy "pro_payment_orders_service_role_only"
  on public.pro_payment_orders
  for all
  to service_role
  using (true)
  with check (true);

create or replace function public.sunland_get_or_create_pro_payment_intent()
returns table (payment_reference uuid, status text)
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_user_id text;
begin
  v_user_id := nullif((select auth.jwt() ->> 'id'), '');
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'authenticated'
    or v_user_id is null
    or v_user_id !~ '^[A-Za-z0-9][A-Za-z0-9@._+-]{0,127}$' then
    raise exception 'authenticated Sunland database token required' using errcode = '42501';
  end if;

  return query
  insert into public.pro_payment_intents (user_id)
  values (v_user_id)
  on conflict (user_id) do update set user_id = excluded.user_id
  returning pro_payment_intents.payment_reference, pro_payment_intents.status;
end;
$$;

create or replace function public.sunland_activate_pro_from_payment(
  p_order_id text,
  p_payment_reference text,
  p_binding_source text,
  p_plan_id text,
  p_total_amount numeric,
  p_paid_at timestamptz
)
returns table (status text)
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions
as $$
declare
  v_existing_status text;
  v_reference uuid;
  v_user_id text;
  v_binding_source text := 'unresolved';
  v_was_pro boolean := false;
  v_plan_id constant text := '4c2527fc6c7411f1bbe45254001e7c00';
begin
  if p_order_id is null or p_order_id !~ '^[A-Za-z0-9_-]{6,128}$' then
    raise exception 'invalid payment order id' using errcode = '22023';
  end if;

  select pro_payment_orders.status
    into v_existing_status
  from public.pro_payment_orders
  where order_id = p_order_id
  for update;

  if found then
    update public.pro_payment_orders
      set attempt_count = attempt_count + 1,
          last_seen_at = now()
      where order_id = p_order_id;
    return query select case when v_existing_status = 'activated' then 'already_processed' else v_existing_status end;
    return;
  end if;

  if coalesce(p_plan_id, '') <> v_plan_id then
    insert into public.pro_payment_orders (
      order_id, plan_id, total_amount, paid_at, binding_source, status, last_error_code
    ) values (
      p_order_id, coalesce(p_plan_id, ''), p_total_amount, p_paid_at, 'unresolved', 'ineligible', 'plan_not_eligible'
    );
    return query select 'ineligible';
    return;
  end if;

  if p_total_amount is null or p_total_amount <= 0 or mod(p_total_amount, 10) <> 0 then
    insert into public.pro_payment_orders (
      order_id, plan_id, total_amount, paid_at, binding_source, status, last_error_code
    ) values (
      p_order_id, p_plan_id, p_total_amount, p_paid_at, 'unresolved', 'unresolved', 'invalid_amount'
    );
    return query select 'unresolved';
    return;
  end if;

  if p_binding_source = 'intent'
    and p_payment_reference ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_reference := p_payment_reference::uuid;
    select user_id
      into v_user_id
    from public.pro_payment_intents
    where payment_reference = v_reference;
    if found then v_binding_source := 'intent'; end if;
  end if;

  if v_user_id is null
    and p_binding_source = 'legacy'
    and p_payment_reference ~* '^([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' then
    v_user_id := p_payment_reference;
    v_binding_source := 'legacy';
  end if;

  if v_user_id is null then
    insert into public.pro_payment_orders (
      order_id, plan_id, total_amount, paid_at, binding_source, status, last_error_code
    ) values (
      p_order_id, p_plan_id, p_total_amount, p_paid_at, 'unresolved', 'unresolved', 'missing_payment_binding'
    );
    return query select 'unresolved';
    return;
  end if;

  select coalesce(pro, false)
    into v_was_pro
  from public.user_profiles
  where user_id = v_user_id
  for update;

  insert into public.user_profiles (user_id, pro)
  values (v_user_id, true)
  on conflict (user_id) do update
    set pro = true,
        updated_at = now();

  if v_binding_source = 'intent' then
    update public.pro_payment_intents
      set status = 'activated',
          activated_at = coalesce(activated_at, now())
      where payment_reference = v_reference;
  end if;

  insert into public.pro_payment_orders (
    order_id, plan_id, total_amount, paid_at, bound_user_id, binding_source, status, activated_at
  ) values (
    p_order_id, p_plan_id, p_total_amount, p_paid_at, v_user_id, v_binding_source, 'activated', now()
  );

  return query select case when coalesce(v_was_pro, false) then 'already_pro' else 'activated' end;
end;
$$;

create or replace function public.sunland_resolve_pro_payment(
  p_order_id text,
  p_user_id text
)
returns table (status text)
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions
as $$
declare
  v_existing_status text;
  v_plan_id text;
  v_was_pro boolean := false;
begin
  if p_order_id is null or p_order_id !~ '^[A-Za-z0-9_-]{6,128}$'
    or p_user_id is null or p_user_id !~ '^[A-Za-z0-9][A-Za-z0-9@._+-]{0,127}$' then
    raise exception 'invalid manual payment resolution input' using errcode = '22023';
  end if;

  select payment_order.status, payment_order.plan_id
    into v_existing_status, v_plan_id
  from public.pro_payment_orders as payment_order
  where payment_order.order_id = p_order_id
  for update;

  if not found then
    raise exception 'payment order not found' using errcode = 'P0002';
  end if;

  if v_existing_status = 'activated' then
    return query select 'already_processed';
    return;
  end if;

  if v_existing_status = 'ineligible' or v_plan_id <> '4c2527fc6c7411f1bbe45254001e7c00' then
    return query select 'ineligible';
    return;
  end if;

  select coalesce(pro, false)
    into v_was_pro
  from public.user_profiles
  where user_id = p_user_id
  for update;

  insert into public.user_profiles (user_id, pro)
  values (p_user_id, true)
  on conflict (user_id) do update
    set pro = true,
        updated_at = now();

  update public.pro_payment_orders
    set bound_user_id = p_user_id,
        binding_source = 'support',
        status = 'activated',
        last_error_code = null,
        last_seen_at = now(),
        activated_at = now(),
        resolved_at = now(),
        attempt_count = attempt_count + 1
    where order_id = p_order_id;

  return query select case when coalesce(v_was_pro, false) then 'already_pro' else 'activated' end;
end;
$$;

revoke all on function public.sunland_get_or_create_pro_payment_intent() from public;
revoke all on function public.sunland_activate_pro_from_payment(text, text, text, text, numeric, timestamptz) from public;
revoke all on function public.sunland_resolve_pro_payment(text, text) from public;
grant execute on function public.sunland_get_or_create_pro_payment_intent() to authenticated;
grant execute on function public.sunland_activate_pro_from_payment(text, text, text, text, numeric, timestamptz) to service_role;
grant execute on function public.sunland_resolve_pro_payment(text, text) to service_role;

commit;
