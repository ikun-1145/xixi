CREATE OR REPLACE FUNCTION public.sunland_serialize_pro_payment_order_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
begin
  perform pg_advisory_xact_lock(hashtext(new.order_id));
  if exists (select 1 from public.pro_payment_orders where order_id = new.order_id) then
    return null;
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.sunland_get_or_create_pro_payment_intent()
 RETURNS TABLE(payment_reference uuid, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'extensions'
AS $function$
declare
  v_user_id text;
begin
  v_user_id := nullif((select auth.jwt() ->> 'id'), '');
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'authenticated'
    or v_user_id is null
    or v_user_id !~ '^[A-Za-z0-9][A-Za-z0-9@._+-]{0,127}$' then
    raise exception 'authenticated Sunland database token required' using errcode = '42501';
  end if;

  perform 1 from public.user_profiles
   where user_id = v_user_id and identity_status = 'active'
   for share;
  if not found then
    raise exception 'ACCOUNT_NOT_ACTIVE' using errcode = '42501';
  end if;

  return query
  insert into public.pro_payment_intents (user_id)
  values (v_user_id)
  on conflict (user_id) do update set user_id = excluded.user_id
  returning pro_payment_intents.payment_reference, pro_payment_intents.status;
end;
$function$;

CREATE OR REPLACE FUNCTION public.sunland_activate_pro_from_payment(p_order_id text, p_payment_reference text, p_binding_source text, p_plan_id text, p_total_amount numeric, p_paid_at timestamp with time zone)
 RETURNS TABLE(status text)
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'extensions'
AS $function$
declare
  v_existing_status text;
  v_reference uuid;
  v_user_id text;
  v_binding_source text := 'unresolved';
  v_was_pro boolean := false;
  v_identity_status text;
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

  select coalesce(pro, false), identity_status
    into v_was_pro, v_identity_status
  from public.user_profiles
  where user_id = v_user_id
  for update;

  if not found or v_identity_status <> 'active' then
    insert into public.pro_payment_orders (
      order_id, plan_id, total_amount, paid_at, binding_source, status, last_error_code
    ) values (
      p_order_id, p_plan_id, p_total_amount, p_paid_at, 'unresolved', 'unresolved', 'account_not_active'
    );
    return query select 'unresolved';
    return;
  end if;

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
$function$;

CREATE OR REPLACE FUNCTION public.sunland_resolve_pro_payment(p_order_id text, p_user_id text)
 RETURNS TABLE(status text)
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'extensions'
AS $function$
declare
  v_existing_status text;
  v_plan_id text;
  v_was_pro boolean := false;
  v_identity_status text;
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

  select coalesce(pro, false), identity_status
    into v_was_pro, v_identity_status
  from public.user_profiles
  where user_id = p_user_id
  for update;

  if not found or v_identity_status <> 'active' then
    update public.pro_payment_orders
       set last_error_code = 'account_not_active',
           last_seen_at = now(),
           attempt_count = attempt_count + 1
     where order_id = p_order_id;
    return query select 'unresolved';
    return;
  end if;

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
$function$;

