CREATE OR REPLACE FUNCTION public.sunland_activate_pro_from_payment(p_user_id text, p_order_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_existing_order_user_id text;
  v_is_pro boolean;
  v_identity_status text;
begin
  if char_length(btrim(coalesce(p_user_id, ''))) = 0
    or char_length(btrim(coalesce(p_order_id, ''))) = 0 then
    raise exception 'INVALID_PAYMENT_REFERENCE' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payment-order:' || p_order_id, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payment-user:' || p_user_id, 0)
  );

  select pa.user_id
    into v_existing_order_user_id
    from public.pro_activations pa
   where pa.order_id = p_order_id;

  if found then
    if v_existing_order_user_id <> p_user_id then
      raise exception 'PAYMENT_ORDER_USER_MISMATCH' using errcode = '22023';
    end if;
    return jsonb_build_object('status', 'already_processed');
  end if;

  select up.pro, up.identity_status
    into v_is_pro, v_identity_status
    from public.user_profiles up
   where up.user_id = p_user_id
   for update;

  if not found or v_identity_status <> 'active' then
    raise exception 'ACCOUNT_NOT_ACTIVE' using errcode = '42501';
  end if;

  if coalesce(v_is_pro, false) then
    return jsonb_build_object('status', 'already_pro');
  else
    update public.user_profiles
       set pro = true
     where user_id = p_user_id;
  end if;

  insert into public.pro_activations (user_id, source, order_id)
  values (p_user_id, 'payment', p_order_id);

  return jsonb_build_object('status', 'activated');
end;
$function$
;
