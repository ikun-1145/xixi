begin;

-- Candidate based on the production catalog captured on 2026-09-29.
-- Payment facts do not revoke independent activation-code/admin entitlements.
alter table public.pro_payment_orders
  add column payment_status text not null default 'unknown'
    check (payment_status in ('unknown', 'paid', 'refunded', 'cancelled')),
  add column last_verified_at timestamptz,
  add column next_retry_at timestamptz,
  add column verified_binding_reference text,
  add column binding_reference_verified_at timestamptz;

alter table public.pro_payment_orders add constraint pro_payment_orders_verified_reference_check
  check ((verified_binding_reference is null) = (binding_reference_verified_at is null));

-- Historical rows remain unverified: only a new query-order observation can certify them.
update public.pro_payment_orders set next_retry_at = now() where status = 'unresolved';
create index pro_payment_orders_retry_idx on public.pro_payment_orders (next_retry_at, order_id)
  where status = 'unresolved' and next_retry_at is not null;
create index pro_payment_orders_verified_reference_idx on public.pro_payment_orders (verified_binding_reference)
  where verified_binding_reference is not null;

create table public.pro_payment_reconciliation_state (
  state_key text primary key check (state_key in ('recent', 'history', 'retry', 'provider')),
  next_page integer not null default 1 check (next_page > 0),
  cycle_id uuid not null default extensions.gen_random_uuid(),
  lease_token uuid,
  lease_until timestamptz,
  generation bigint not null default 0,
  last_success_at timestamptz,
  provider_backoff_until timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.pro_payment_reconciliation_state enable row level security;
revoke all on table public.pro_payment_reconciliation_state from public, anon, authenticated;
grant select, insert, update, delete on table public.pro_payment_reconciliation_state to service_role;
create policy pro_payment_reconciliation_state_service_only
  on public.pro_payment_reconciliation_state for all to service_role using (true) with check (true);

create or replace function public.sunland_process_verified_pro_order(
  p_order jsonb, p_processing_source text, p_trace_id uuid, p_use_cached boolean default false
)
returns jsonb language plpgsql security invoker
set search_path = pg_catalog, public, extensions
as $$
declare
  v_order_id text;
  v_existing public.pro_payment_orders%rowtype;
  v_locked public.pro_payment_orders%rowtype;
  v_exists boolean;
  v_payment_status text;
  v_plan_id text;
  v_amount_text text;
  v_cents bigint;
  v_amount numeric;
  v_product_type text;
  v_currency text;
  v_reference text;
  v_binding_source text;
  v_paid_at timestamptz;
  v_user_id text;
  v_rechecked_user_id text;
  v_identity_status text;
  v_was_pro boolean;
  v_historical_owner text;
  v_historical_owners integer;
  v_historical_processed boolean := false;
  v_attempt_count integer;
  v_reason text;
  v_status text := 'unresolved';
  v_retry_class text := 'retryable';
  v_next_retry timestamptz;
  v_verified_at timestamptz;
  v_reference_at timestamptz;
  v_sticky constant text[] := array['ACCOUNT_DELETING', 'ACCOUNT_RETIRED', 'OWNER_ANONYMIZED', 'BINDING_CONFLICT', 'PROVIDER_FACT_CONFLICT', 'DATA_DELETED'];
  v_plan constant text := '4c2527fc6c7411f1bbe45254001e7c00';
begin
  if jsonb_typeof(p_order) is distinct from 'object'
    or jsonb_typeof(p_order->'order_id') is distinct from 'string'
    or (p_order->>'order_id') !~ '^[A-Za-z0-9_-]{6,128}$'
    or p_trace_id is null
    or p_processing_source is null
    or p_processing_source not in ('webhook', 'cron_recent', 'cron_history', 'manual_query', 'user_reconcile')
    or p_use_cached is null then
    raise exception 'INVALID_VERIFIED_ORDER_INPUT' using errcode = '22023';
  end if;
  v_order_id := p_order->>'order_id';

  -- First business-data operation, same key as the existing INSERT trigger.
  perform pg_advisory_xact_lock(hashtext(v_order_id));
  select * into v_existing from public.pro_payment_orders where order_id = v_order_id;
  v_exists := found;
  v_attempt_count := v_existing.attempt_count;

  if p_use_cached then
    -- A cached binding can identify a conflict, but cached paid is never grant authority.
    if v_exists and v_existing.status = 'unresolved'
      and not coalesce(v_existing.last_error_code = any(v_sticky), false) then
      update public.pro_payment_orders set last_error_code = 'PROVIDER_VERIFICATION_REQUIRED',
        next_retry_at = now(), last_seen_at = now(), attempt_count = attempt_count + 1 where order_id = v_order_id
        returning attempt_count into v_attempt_count;
    end if;
    return jsonb_build_object('order_id', v_order_id, 'status', coalesce(v_existing.status, 'unresolved'),
      'reason_code', 'PROVIDER_VERIFICATION_REQUIRED', 'retry_class', 'retryable', 'cached', true,
      'state_before', v_existing.status, 'state_after', v_existing.status, 'attempt_count', v_attempt_count);
  else
    if jsonb_typeof(p_order->'payment_status') is distinct from 'string'
      or p_order->>'payment_status' not in ('paid', 'refunded', 'cancelled', 'unknown')
      or jsonb_typeof(p_order->'plan_id') is distinct from 'string'
      or jsonb_typeof(p_order->'total_amount') is distinct from 'string'
      or jsonb_typeof(p_order->'amount_cents') is distinct from 'number'
      or (p_order->>'amount_cents') !~ '^[0-9]{1,12}$'
      or jsonb_typeof(p_order->'product_type') is distinct from 'number'
      or (p_order->>'product_type') !~ '^[0-9]{1,3}$'
      or jsonb_typeof(p_order->'currency') is distinct from 'string'
      or jsonb_typeof(p_order->'binding_source') is distinct from 'string'
      or p_order->>'binding_source' not in ('intent', 'legacy', 'unresolved')
      or not (p_order ? 'binding_reference') or not (p_order ? 'paid_at')
      or (p_order->'binding_reference' <> 'null'::jsonb and jsonb_typeof(p_order->'binding_reference') is distinct from 'string')
      or (p_order->'paid_at' <> 'null'::jsonb and jsonb_typeof(p_order->'paid_at') is distinct from 'string') then
      raise exception 'INVALID_VERIFIED_ORDER_SCHEMA' using errcode = '22023';
    end if;
    v_payment_status := p_order->>'payment_status';
    v_plan_id := p_order->>'plan_id';
    v_amount_text := p_order->>'total_amount';
    if v_amount_text !~ '^(0|[1-9][0-9]{0,9})(\.[0-9]{1,2})?$' then
      raise exception 'INVALID_VERIFIED_ORDER_AMOUNT' using errcode = '22023';
    end if;
    v_cents := (p_order->>'amount_cents')::bigint;
    v_amount := v_amount_text::numeric;
    if v_cents <> v_amount * 100 or v_cents > 999999999999 then
      raise exception 'INVALID_VERIFIED_ORDER_AMOUNT' using errcode = '22023';
    end if;
    v_product_type := p_order->>'product_type';
    v_currency := p_order->>'currency';
    v_reference := nullif(p_order->>'binding_reference', '');
    v_binding_source := p_order->>'binding_source';
    if p_order->>'paid_at' is not null then
      if p_order->>'paid_at' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$' then
        raise exception 'INVALID_VERIFIED_ORDER_PAID_AT' using errcode = '22023';
      end if;
      v_paid_at := (p_order->>'paid_at')::timestamptz;
    end if;
    v_verified_at := clock_timestamp();
    v_reference_at := v_verified_at;
  end if;

  if v_plan_id <> v_plan or v_product_type <> '0' or v_currency <> 'CNY' then
    v_reason := 'INVALID_PRODUCT'; v_status := 'ineligible'; v_retry_class := 'terminal';
  elsif v_cents is null or v_cents < 1000 or mod(v_cents, 1000) <> 0 then
    v_reason := 'AMOUNT_MISMATCH'; v_retry_class := 'blocked';
  end if;
  -- Binding validation is independent of product/amount rejection: never retain arbitrary metadata.
  if v_binding_source = 'intent' and coalesce(v_reference, '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_reference := lower(v_reference);
  elsif v_binding_source = 'legacy' and coalesce(v_reference, '') ~* '^([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' then
    -- Legacy user IDs are text and case-sensitive; preserve the provider's exact identifier.
    null;
  else
    v_reason := 'INVALID_BINDING'; v_retry_class := 'blocked';
    v_reference := null; v_reference_at := null; v_binding_source := 'unresolved';
  end if;

  -- A first trusted observation may correct old unverified unresolved facts.
  -- Once certified, metadata/owner changes are blocked and never silently rebound.
  if v_exists and v_existing.verified_binding_reference is not null
    and (v_reference is distinct from v_existing.verified_binding_reference
      or v_binding_source is distinct from v_existing.binding_source) then
    v_reason := 'BINDING_CONFLICT'; v_retry_class := 'blocked';
    v_reference := v_existing.verified_binding_reference;
    v_binding_source := v_existing.binding_source;
    v_reference_at := v_existing.binding_reference_verified_at;
  end if;
  if v_exists and v_existing.last_verified_at is not null
    and (v_existing.plan_id is distinct from v_plan_id or v_existing.total_amount is distinct from v_amount) then
    v_reason := 'PROVIDER_FACT_CONFLICT'; v_retry_class := 'blocked';
    v_plan_id := v_existing.plan_id; v_amount := v_existing.total_amount;
  end if;
  if v_reason is not null and not (v_exists and v_existing.status = 'activated') then
    -- Rejected observations must not introduce references without the owner/state guard.
    v_reference := v_existing.verified_binding_reference;
    v_reference_at := v_existing.binding_reference_verified_at;
    v_binding_source := coalesce(v_existing.binding_source, 'unresolved');
  end if;
  if v_exists and v_existing.status = 'unresolved' and v_existing.bound_user_id is null
    and v_existing.binding_source in ('intent', 'legacy', 'support')
    and v_existing.verified_binding_reference is null then
    -- Old never-resolved rows used source=unresolved; an old known binding with no owner is anonymized.
    v_reason := 'OWNER_ANONYMIZED'; v_retry_class := 'blocked';
    v_reference := null; v_reference_at := null; v_binding_source := v_existing.binding_source;
  end if;
  if v_exists and coalesce(v_existing.last_error_code = any(v_sticky), false) then
    v_reason := v_existing.last_error_code; v_retry_class := 'blocked';
    v_reference := v_existing.verified_binding_reference;
    v_reference_at := v_existing.binding_reference_verified_at;
    v_binding_source := v_existing.binding_source;
  elsif v_exists and v_existing.status = 'ineligible' then
    v_reason := coalesce(v_existing.last_error_code, 'INVALID_PRODUCT');
    v_status := 'ineligible'; v_retry_class := 'terminal';
    v_plan_id := v_existing.plan_id; v_amount := v_existing.total_amount;
  end if;
  if v_exists and v_existing.status = 'activated' and v_existing.verified_binding_reference is null then
    -- Historical terminal rows cannot acquire a new reference or owner during backfill.
    v_reference := null; v_reference_at := null; v_binding_source := v_existing.binding_source;
    if v_existing.plan_id is distinct from v_plan_id or v_existing.total_amount is distinct from v_amount then
      v_reason := 'PROVIDER_FACT_CONFLICT'; v_retry_class := 'blocked';
      v_plan_id := v_existing.plan_id; v_amount := v_existing.total_amount;
    end if;
  end if;

  if v_payment_status <> 'paid' then
    if v_reason is null then v_reason := case when v_payment_status = 'unknown' then 'PROVIDER_VERIFICATION_REQUIRED' else 'PAYMENT_NOT_PAID' end; end if;
    if v_payment_status in ('refunded', 'cancelled') and v_retry_class <> 'blocked' then v_retry_class := 'terminal'; end if;
  end if;

  select min(user_id), count(distinct user_id)::integer into v_historical_owner, v_historical_owners
    from public.pro_activations where source = 'payment' and order_id = v_order_id;
  if v_historical_owners > 1 then
    v_reason := 'BINDING_CONFLICT'; v_retry_class := 'blocked';
  end if;

  if v_exists and v_existing.status = 'activated' then
    v_status := 'activated';
    v_user_id := v_existing.bound_user_id;
    -- An activated ledger is idempotent, including a deleted/anonymized owner.
    if v_user_id is null then v_reason := coalesce(v_existing.last_error_code, 'OWNER_ANONYMIZED'); v_retry_class := 'blocked';
    elsif v_reason is null then v_retry_class := 'terminal'; end if;
  elsif v_reason is null then
    if v_binding_source = 'intent' then
      select user_id into v_user_id from public.pro_payment_intents where payment_reference = v_reference::uuid;
      if not found then v_reason := 'INTENT_NOT_FOUND'; end if;
    else
      v_user_id := v_reference;
    end if;

    if v_user_id is not null then
      select pro, identity_status into v_was_pro, v_identity_status
        from public.user_profiles where user_id = v_user_id for update;
      if not found then
        v_reason := 'USER_NOT_FOUND'; v_user_id := null;
      elsif v_identity_status <> 'active' then
        v_reason := case when v_identity_status = 'retired' then 'ACCOUNT_RETIRED' else 'ACCOUNT_DELETING' end;
        v_retry_class := 'blocked';
        -- Do not retain newly observed identity/reference during deletion.
        v_user_id := null; v_reference := null; v_reference_at := null; v_binding_source := 'unresolved';
      elsif v_binding_source = 'intent' then
        select user_id into v_rechecked_user_id from public.pro_payment_intents
          where payment_reference = v_reference::uuid;
        if not found then
          v_reason := 'INTENT_NOT_FOUND'; v_user_id := null;
        elsif v_rechecked_user_id is distinct from v_user_id then
          v_reason := 'BINDING_CONFLICT'; v_retry_class := 'blocked'; v_user_id := null;
        end if;
      end if;
    end if;
    if v_reason is null and v_historical_owner is not null and v_historical_owner <> v_user_id then
      v_reason := 'BINDING_CONFLICT'; v_retry_class := 'blocked'; v_user_id := null;
    end if;
    if v_reason is null and v_exists and v_existing.bound_user_id is not null
      and v_existing.last_verified_at is not null and v_existing.bound_user_id <> v_user_id then
      v_reason := 'BINDING_CONFLICT'; v_retry_class := 'blocked'; v_user_id := null;
    end if;
    if v_reason is null and v_historical_owner is not null then
      -- A historic payment has already been consumed; never re-grant a subsequently removed entitlement.
      v_reason := 'HISTORICAL_PAYMENT_ACTIVATION'; v_retry_class := 'blocked';
      v_historical_processed := true; v_user_id := null;
    end if;
    if v_reason is null then v_status := 'activated'; v_retry_class := 'terminal'; end if;
  end if;

  -- Cleanup can run while the candidate waits for the profile lock. Re-read the ledger
  -- only after that lock, so an anonymization/deletion decision cannot be overwritten.
  select * into v_locked from public.pro_payment_orders where order_id = v_order_id for update;
  if found then
    v_exists := true;
    if coalesce(v_locked.last_error_code = any(v_sticky), false) then
      v_reason := v_locked.last_error_code; v_retry_class := 'blocked';
      v_reference := v_locked.verified_binding_reference;
      v_reference_at := v_locked.binding_reference_verified_at;
      v_binding_source := v_locked.binding_source;
      v_user_id := v_locked.bound_user_id;
      v_status := v_locked.status;
    end if;
  end if;
  if v_reference is null then v_reference_at := null; end if;
  if v_status = 'unresolved' and v_retry_class = 'retryable' then v_next_retry := now() + interval '2 minutes'; end if;

  -- Profile was locked before any ledger write for a candidate grant.
  if not v_exists then
    insert into public.pro_payment_orders(order_id, plan_id, total_amount, paid_at, bound_user_id,
      binding_source, status, last_error_code, payment_status, last_verified_at, next_retry_at,
      verified_binding_reference, binding_reference_verified_at)
    values(v_order_id, v_plan_id, v_amount, v_paid_at, null, v_binding_source, 'unresolved', v_reason,
      v_payment_status, v_verified_at, v_next_retry, v_reference, v_reference_at);
  else
    update public.pro_payment_orders set plan_id = v_plan_id, total_amount = v_amount,
      paid_at = coalesce(v_paid_at, paid_at), payment_status = v_payment_status,
      last_verified_at = v_verified_at, verified_binding_reference = v_reference,
      binding_reference_verified_at = v_reference_at, binding_source = v_binding_source, last_error_code = v_reason,
      next_retry_at = v_next_retry, last_seen_at = now(), attempt_count = attempt_count + 1
    where order_id = v_order_id;
  end if;

  if v_status = 'activated' and not (v_exists and v_existing.status = 'activated') then
    update public.user_profiles set pro = true, updated_at = now()
      where user_id = v_user_id and identity_status = 'active';
    if not found then raise exception 'ACTIVE_OWNER_LOST' using errcode = '40001'; end if;
    if v_binding_source = 'intent' then
      update public.pro_payment_intents set status = 'activated', activated_at = coalesce(activated_at, now())
        where payment_reference = v_reference::uuid and user_id = v_user_id;
      if not found then raise exception 'INTENT_OWNER_LOST' using errcode = '40001'; end if;
    end if;
    update public.pro_payment_orders set status = 'activated', bound_user_id = v_user_id,
      activated_at = coalesce(activated_at, now()), resolved_at = coalesce(resolved_at, now()),
      last_error_code = null, next_retry_at = null where order_id = v_order_id;
  else
    update public.pro_payment_orders set status = v_status where order_id = v_order_id;
  end if;
  select attempt_count into v_attempt_count from public.pro_payment_orders where order_id = v_order_id;
  return jsonb_build_object('order_id', v_order_id, 'status', v_status, 'reason_code', v_reason,
    'retry_class', v_retry_class, 'payment_status', v_payment_status,
    'already_processed', (v_exists and v_existing.status = 'activated') or v_historical_processed, 'cached', p_use_cached,
    'state_before', v_existing.status, 'state_after', v_status, 'attempt_count', v_attempt_count);
end;
$$;

create or replace function public.sunland_record_pro_payment_hints(
  p_order_ids text[], p_processing_source text, p_trace_id uuid
)
returns jsonb language plpgsql security invoker set search_path = pg_catalog, public, extensions
as $$
declare v_id text; v_recorded integer := 0;
begin
  if p_order_ids is null or cardinality(p_order_ids) > 100 or p_trace_id is null
    or p_processing_source is null or p_processing_source not in ('webhook', 'cron_recent', 'cron_history', 'manual_query', 'user_reconcile')
    or exists(select 1 from unnest(p_order_ids) id where id is null or id !~ '^[A-Za-z0-9_-]{6,128}$') then
    raise exception 'INVALID_PAYMENT_HINT' using errcode = '22023';
  end if;
  for v_id in select distinct id from unnest(p_order_ids) id order by id loop
    perform pg_advisory_xact_lock(hashtext(v_id));
    if not exists(select 1 from public.pro_payment_orders where order_id = v_id) then
      insert into public.pro_payment_orders(order_id, plan_id, binding_source, status, last_error_code, next_retry_at)
      values(v_id, '', 'unresolved', 'unresolved', 'PROVIDER_VERIFICATION_REQUIRED', now());
    end if;
    v_recorded := v_recorded + 1;
  end loop;
  return jsonb_build_object('recorded', v_recorded);
end;
$$;

-- Signed webhook replays must not bypass the recent-scan cooldown.
-- ponytail: reuse the ledger timestamps; add quota accounting only if measured load requires it.
create or replace function public.sunland_claim_pro_payment_order_query(p_order_id text)
returns jsonb language plpgsql security invoker set search_path = pg_catalog, public
as $$
declare v_row public.pro_payment_orders%rowtype; v_due timestamptz; v_retry integer;
begin
  if p_order_id is null or p_order_id !~ '^[A-Za-z0-9_-]{6,128}$' then
    raise exception 'INVALID_PAYMENT_ORDER_QUERY' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext(p_order_id));
  select * into v_row from public.pro_payment_orders where order_id = p_order_id for update;
  if not found then
    return jsonb_build_object('acquired', false, 'status', 'unresolved',
      'reason_code', 'PROVIDER_VERIFICATION_REQUIRED', 'retry_after_seconds', 1);
  end if;
  if v_row.status = 'ineligible' or (v_row.status = 'unresolved' and
    (v_row.next_retry_at is null or coalesce(v_row.last_error_code, '') in
      ('ACCOUNT_DELETING', 'ACCOUNT_RETIRED', 'OWNER_ANONYMIZED', 'BINDING_CONFLICT', 'PROVIDER_FACT_CONFLICT',
       'DATA_DELETED', 'INVALID_BINDING', 'AMOUNT_MISMATCH', 'INVALID_PRODUCT', 'HISTORICAL_PAYMENT_ACTIVATION'))) then
    return jsonb_build_object('acquired', false, 'status', v_row.status,
      'reason_code', v_row.last_error_code, 'retry_after_seconds', 0);
  end if;
  v_due := case when v_row.status = 'activated' then v_row.last_seen_at + interval '20 seconds' else v_row.next_retry_at end;
  if v_due > clock_timestamp() then
    v_retry := greatest(1, ceil(extract(epoch from v_due - clock_timestamp()))::integer);
    return jsonb_build_object('acquired', false, 'status', v_row.status,
      'reason_code', v_row.last_error_code, 'retry_after_seconds', v_retry);
  end if;
  update public.pro_payment_orders set last_seen_at = clock_timestamp(),
    next_retry_at = case when status = 'unresolved' then clock_timestamp() + interval '20 seconds' else null end
    where order_id = p_order_id;
  return jsonb_build_object('acquired', true, 'status', v_row.status,
    'reason_code', v_row.last_error_code, 'retry_after_seconds', 0);
end;
$$;

create or replace function public.sunland_note_pro_payment_retry(
  p_order_id text, p_reason_code text, p_processing_source text, p_trace_id uuid
)
returns jsonb language plpgsql security invoker set search_path = pg_catalog, public, extensions
as $$
declare v_row public.pro_payment_orders%rowtype;
begin
  if p_order_id is null or p_order_id !~ '^[A-Za-z0-9_-]{6,128}$'
    or p_reason_code is null or p_reason_code not in ('PROVIDER_QUERY_FAILED', 'PROVIDER_VERIFICATION_REQUIRED',
      'INVALID_BINDING', 'AMOUNT_MISMATCH', 'INVALID_PRODUCT')
    or p_trace_id is null or p_processing_source is null
    or p_processing_source not in ('webhook', 'cron_recent', 'cron_history', 'manual_query', 'user_reconcile') then
    raise exception 'INVALID_PAYMENT_RETRY' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext(p_order_id));
  select * into v_row from public.pro_payment_orders where order_id = p_order_id;
  if found and v_row.status = 'unresolved' and coalesce(v_row.last_error_code, '') not in
    ('ACCOUNT_DELETING', 'ACCOUNT_RETIRED', 'OWNER_ANONYMIZED', 'BINDING_CONFLICT', 'PROVIDER_FACT_CONFLICT', 'DATA_DELETED', 'INVALID_BINDING', 'AMOUNT_MISMATCH', 'INVALID_PRODUCT', 'HISTORICAL_PAYMENT_ACTIVATION') then
    update public.pro_payment_orders set last_error_code = p_reason_code,
      next_retry_at = case when p_reason_code in ('PROVIDER_QUERY_FAILED', 'PROVIDER_VERIFICATION_REQUIRED')
        then now() + interval '2 minutes' else null end,
      last_seen_at = now(), attempt_count = attempt_count + 1
      where order_id = p_order_id;
  end if;
  return jsonb_build_object('order_id', p_order_id, 'recorded', found);
end;
$$;

create or replace function public.sunland_get_pro_payment_backoff()
returns jsonb language sql security invoker set search_path = pg_catalog, public
as $$
  select jsonb_build_object('retry_after_seconds', coalesce((select greatest(0,
    ceil(extract(epoch from provider_backoff_until - clock_timestamp()))::integer)
    from public.pro_payment_reconciliation_state where state_key = 'provider'), 0));
$$;

create or replace function public.sunland_set_pro_payment_backoff(p_retry_after_seconds integer)
returns jsonb language plpgsql security invoker set search_path = pg_catalog, public, extensions
as $$
begin
  if p_retry_after_seconds is null or p_retry_after_seconds < 1 or p_retry_after_seconds > 3600 then
    raise exception 'INVALID_PROVIDER_BACKOFF' using errcode = '22023';
  end if;
  insert into public.pro_payment_reconciliation_state(state_key, provider_backoff_until)
    values('provider', clock_timestamp() + p_retry_after_seconds * interval '1 second')
    on conflict(state_key) do update set provider_backoff_until = greatest(
      pro_payment_reconciliation_state.provider_backoff_until, excluded.provider_backoff_until), updated_at = now();
  return public.sunland_get_pro_payment_backoff();
end;
$$;

create or replace function public.sunland_claim_pro_payment_scan(p_state_key text)
returns jsonb language plpgsql security invoker set search_path = pg_catalog, public, extensions
as $$
declare v_row public.pro_payment_reconciliation_state%rowtype; v_retry integer;
begin
  if p_state_key is null or p_state_key not in ('recent', 'history', 'retry') then
    raise exception 'INVALID_PAYMENT_SCAN' using errcode = '22023';
  end if;
  v_retry := (public.sunland_get_pro_payment_backoff()->>'retry_after_seconds')::integer;
  if v_retry > 0 then return jsonb_build_object('acquired', false, 'retry_after_seconds', v_retry); end if;
  insert into public.pro_payment_reconciliation_state(state_key) values(p_state_key) on conflict(state_key) do nothing;
  select * into v_row from public.pro_payment_reconciliation_state where state_key = p_state_key for update;
  if v_row.lease_until > clock_timestamp()
    or (p_state_key = 'recent' and v_row.last_success_at > clock_timestamp() - interval '20 seconds') then
    return jsonb_build_object('acquired', false, 'retry_after_seconds', greatest(1,
      ceil(extract(epoch from greatest(v_row.lease_until,
        case when p_state_key = 'recent' then v_row.last_success_at + interval '20 seconds' end) - clock_timestamp()))::integer));
  end if;
  update public.pro_payment_reconciliation_state set lease_token = extensions.gen_random_uuid(),
    lease_until = clock_timestamp() + interval '30 seconds', generation = generation + 1, updated_at = now()
    where state_key = p_state_key returning * into v_row;
  return jsonb_build_object('acquired', true, 'lease_token', v_row.lease_token, 'generation', v_row.generation,
    'next_page', v_row.next_page, 'cycle_id', v_row.cycle_id, 'retry_after_seconds', 0);
end;
$$;

create or replace function public.sunland_complete_pro_payment_scan(
  p_state_key text, p_lease_token uuid, p_generation bigint,
  p_next_page integer, p_total_pages integer, p_order_ids text[]
)
returns jsonb language plpgsql security invoker set search_path = pg_catalog, public, extensions
as $$
declare v_row public.pro_payment_reconciliation_state%rowtype; v_expected integer;
begin
  if p_state_key is null or p_state_key not in ('recent', 'history', 'retry') or p_lease_token is null
    or p_generation is null or p_generation < 1 or p_order_ids is null or cardinality(p_order_ids) > 100
    or p_total_pages is null or p_total_pages < 1 or p_next_page is null or p_next_page < 1
    or exists(select 1 from unnest(p_order_ids) id where id is null or id !~ '^[A-Za-z0-9_-]{6,128}$') then
    raise exception 'INVALID_PAYMENT_SCAN_COMPLETION' using errcode = '22023';
  end if;
  select * into v_row from public.pro_payment_reconciliation_state where state_key = p_state_key
    and lease_token = p_lease_token and generation = p_generation and lease_until > clock_timestamp() for update;
  if not found then return jsonb_build_object('advanced', false, 'reason_code', 'LEASE_FENCED'); end if;
  if exists(select 1 from unnest(p_order_ids) id where not exists(
    select 1 from public.pro_payment_orders o where o.order_id = id and
      (o.status in ('activated', 'ineligible') or o.next_retry_at is not null or o.last_error_code in
        ('ACCOUNT_DELETING', 'ACCOUNT_RETIRED', 'OWNER_ANONYMIZED', 'BINDING_CONFLICT', 'PROVIDER_FACT_CONFLICT',
         'DATA_DELETED', 'INVALID_BINDING', 'AMOUNT_MISMATCH', 'INVALID_PRODUCT', 'HISTORICAL_PAYMENT_ACTIVATION')))) then
    return jsonb_build_object('advanced', false, 'reason_code', 'PAGE_NOT_DURABLE');
  end if;
  v_expected := case when p_state_key <> 'history' or v_row.next_page >= p_total_pages then 1 else v_row.next_page + 1 end;
  if p_next_page <> v_expected then raise exception 'INVALID_PAYMENT_CURSOR_ADVANCE' using errcode = '22023'; end if;
  update public.pro_payment_reconciliation_state set next_page = p_next_page,
    cycle_id = case when p_state_key = 'history' and p_next_page = 1 then extensions.gen_random_uuid() else cycle_id end,
    lease_token = null, lease_until = null, last_success_at = clock_timestamp(), updated_at = now()
    where state_key = p_state_key;
  return jsonb_build_object('advanced', true, 'next_page', p_next_page);
end;
$$;

create or replace function public.sunland_release_pro_payment_scan(p_state_key text, p_lease_token uuid, p_generation bigint)
returns jsonb language plpgsql security invoker set search_path = pg_catalog, public
as $$
begin
  if p_state_key is null or p_state_key not in ('recent', 'history', 'retry') or p_lease_token is null or p_generation is null then
    raise exception 'INVALID_PAYMENT_SCAN_RELEASE' using errcode = '22023';
  end if;
  update public.pro_payment_reconciliation_state set lease_token = null, lease_until = null, updated_at = now()
    where state_key = p_state_key and lease_token = p_lease_token and generation = p_generation;
  return jsonb_build_object('released', found);
end;
$$;

-- Legacy payment entry points retain signatures, but all new grants require v2 verification.
create or replace function public.sunland_activate_pro_from_payment(
  p_order_id text, p_payment_reference text, p_binding_source text, p_plan_id text, p_total_amount numeric, p_paid_at timestamptz
)
returns table(status text) language plpgsql security invoker set search_path = pg_catalog, public, extensions
as $$
begin
  perform public.sunland_record_pro_payment_hints(array[p_order_id], 'manual_query', extensions.gen_random_uuid());
  return query select case when exists(select 1 from public.pro_payment_orders o where o.order_id = p_order_id and o.status = 'activated')
    or exists(select 1 from public.pro_activations a where a.order_id = p_order_id and a.source = 'payment')
    then 'already_processed'::text
    when exists(select 1 from public.pro_payment_orders o where o.order_id = p_order_id and o.status = 'ineligible')
    then 'ineligible'::text else 'unresolved'::text end;
end;
$$;

create or replace function public.sunland_activate_pro_from_payment(p_user_id text, p_order_id text)
returns jsonb language plpgsql security invoker set search_path = pg_catalog, public, extensions
as $$
begin
  if p_user_id is null or p_user_id !~ '^[A-Za-z0-9][A-Za-z0-9@._+-]{0,127}$' then
    raise exception 'INVALID_PAYMENT_REFERENCE' using errcode = '22023';
  end if;
  perform public.sunland_record_pro_payment_hints(array[p_order_id], 'manual_query', extensions.gen_random_uuid());
  if exists(select 1 from public.pro_payment_orders o where o.order_id = p_order_id and o.status = 'activated' and o.bound_user_id is distinct from p_user_id)
    or exists(select 1 from public.pro_activations a where a.order_id = p_order_id and a.source = 'payment' and a.user_id <> p_user_id) then
    raise exception 'PAYMENT_ORDER_USER_MISMATCH' using errcode = '22023';
  end if;
  return jsonb_build_object('status', case when exists(select 1 from public.pro_payment_orders o where o.order_id = p_order_id and o.status = 'activated')
    or exists(select 1 from public.pro_activations a where a.order_id = p_order_id and a.source = 'payment')
    then 'already_processed' else 'verification_required' end);
end;
$$;

create or replace function public.sunland_resolve_pro_payment(p_order_id text, p_user_id text)
returns table(status text) language plpgsql security invoker set search_path = pg_catalog, public, extensions
as $$
begin
  if p_user_id is null or p_user_id !~ '^[A-Za-z0-9][A-Za-z0-9@._+-]{0,127}$' then
    raise exception 'INVALID_PAYMENT_REFERENCE' using errcode = '22023';
  end if;
  perform public.sunland_record_pro_payment_hints(array[p_order_id], 'manual_query', extensions.gen_random_uuid());
  return query select case when exists(select 1 from public.pro_payment_orders o where o.order_id = p_order_id and o.status = 'activated')
    then 'already_processed'::text else 'verification_required'::text end;
end;
$$;

-- Current production deletion function: preserve every cleanup operation, add only guard/reference cleanup.
create or replace function public.sunland_delete_account_business_data(p_user_id text)
returns table(status text) language plpgsql security definer set search_path = pg_catalog, public, extensions
as $$
declare v_identity_status text;
begin
  if p_user_id is null or p_user_id !~ '^[A-Za-z0-9][A-Za-z0-9@._+-]{0,127}$' then
    raise exception 'invalid user id' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('sunland-delete-account:' || p_user_id));
  select identity_status into v_identity_status from public.user_profiles where user_id = p_user_id for update;
  if found and v_identity_status not in ('deleting', 'retired') then
    raise exception 'ACCOUNT_DELETION_NOT_STARTED' using errcode = '42501';
  end if;
  -- Clear references before removing intents; include orders that never resolved an owner.
  update public.pro_payment_orders set bound_user_id = null, verified_binding_reference = null,
    binding_reference_verified_at = null, last_error_code = case when last_error_code in
      ('ACCOUNT_DELETING', 'ACCOUNT_RETIRED', 'OWNER_ANONYMIZED', 'BINDING_CONFLICT', 'PROVIDER_FACT_CONFLICT', 'DATA_DELETED')
      then last_error_code else 'DATA_DELETED' end, next_retry_at = null
    where bound_user_id = p_user_id
      or (binding_source = 'legacy' and verified_binding_reference = p_user_id)
      or verified_binding_reference in (select payment_reference::text from public.pro_payment_intents where user_id = p_user_id);
  -- This snapshots private Storage paths and consumes any in-flight quota.
  -- Rows can be removed only after the cleanup job is durably inserted.
  perform public.chat_prepare_account_delete(p_user_id);
  delete from public.chat_message_images where user_id = p_user_id;
  delete from public.chat_turns where user_id = p_user_id;
  delete from public.chat_messages where user_id = p_user_id;
  delete from public.chat_usage_entries where user_id = p_user_id;
  delete from public.chat_daily_usage where user_id = p_user_id;
  delete from public.chat_threads where user_id = p_user_id;

  delete from public.sunland_ai_turn_results where user_id = p_user_id;
  delete from public.sunland_ai_migration_receipts where user_id = p_user_id;
  delete from public.sunland_ai_context where user_id = p_user_id;
  delete from public.sunland_ai_knowledge where user_id = p_user_id;
  delete from public.sunland_ai_memory where user_id = p_user_id;
  delete from public.sunland_ai_user_state where user_id = p_user_id;
  delete from public.pro_activations where user_id = p_user_id;
  delete from public.comment_copilot_context where user_id = p_user_id;
  delete from public.comment_copilot_usage where user_id = p_user_id;
  delete from public.conversations where user_id = p_user_id;
  delete from public.deleted_conversations where user_id = p_user_id;
  delete from public.usage where user_id = p_user_id;
  delete from public.usage_logs where user_id::text = p_user_id;
  delete from public.request_logs where user_id::text = p_user_id;
  delete from public.pro_payment_intents where user_id = p_user_id;

  update public.pro_payment_orders set bound_user_id = null
    where bound_user_id = p_user_id;
  return query select 'deleted'::text;
end;
$$;

revoke all on function public.sunland_process_verified_pro_order(jsonb, text, uuid, boolean) from public, anon, authenticated;
revoke all on function public.sunland_record_pro_payment_hints(text[], text, uuid) from public, anon, authenticated;
revoke all on function public.sunland_claim_pro_payment_order_query(text) from public, anon, authenticated;
revoke all on function public.sunland_note_pro_payment_retry(text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.sunland_get_pro_payment_backoff() from public, anon, authenticated;
revoke all on function public.sunland_set_pro_payment_backoff(integer) from public, anon, authenticated;
revoke all on function public.sunland_claim_pro_payment_scan(text) from public, anon, authenticated;
revoke all on function public.sunland_complete_pro_payment_scan(text, uuid, bigint, integer, integer, text[]) from public, anon, authenticated;
revoke all on function public.sunland_release_pro_payment_scan(text, uuid, bigint) from public, anon, authenticated;
revoke all on function public.sunland_activate_pro_from_payment(text, text, text, text, numeric, timestamptz) from public, anon, authenticated;
revoke all on function public.sunland_activate_pro_from_payment(text, text) from public, anon, authenticated;
revoke all on function public.sunland_resolve_pro_payment(text, text) from public, anon, authenticated;
revoke all on function public.sunland_delete_account_business_data(text) from public, anon, authenticated;
grant execute on function public.sunland_process_verified_pro_order(jsonb, text, uuid, boolean) to service_role;
grant execute on function public.sunland_record_pro_payment_hints(text[], text, uuid) to service_role;
grant execute on function public.sunland_claim_pro_payment_order_query(text) to service_role;
grant execute on function public.sunland_note_pro_payment_retry(text, text, text, uuid) to service_role;
grant execute on function public.sunland_get_pro_payment_backoff() to service_role;
grant execute on function public.sunland_set_pro_payment_backoff(integer) to service_role;
grant execute on function public.sunland_claim_pro_payment_scan(text) to service_role;
grant execute on function public.sunland_complete_pro_payment_scan(text, uuid, bigint, integer, integer, text[]) to service_role;
grant execute on function public.sunland_release_pro_payment_scan(text, uuid, bigint) to service_role;
grant execute on function public.sunland_activate_pro_from_payment(text, text, text, text, numeric, timestamptz) to service_role;
grant execute on function public.sunland_activate_pro_from_payment(text, text) to service_role;
grant execute on function public.sunland_resolve_pro_payment(text, text) to service_role;
grant execute on function public.sunland_delete_account_business_data(text) to service_role;

commit;
