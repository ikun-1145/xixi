begin;

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

revoke all on function public.sunland_resolve_pro_payment(text, text) from public, anon, authenticated;
grant execute on function public.sunland_resolve_pro_payment(text, text) to service_role;

commit;
