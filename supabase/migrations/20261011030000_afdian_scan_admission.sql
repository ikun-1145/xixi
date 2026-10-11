-- REVIEW ONLY: do not apply to production without separate approval.
-- Requires 20261005122300. Deploy this before the Worker using the new RPCs.
-- No existing payment/entitlement function or user rights are rewritten.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table public.pro_payment_order_query_leases (
  order_id text primary key references public.pro_payment_orders(order_id) on delete cascade,
  lease_token uuid not null,
  lease_until timestamptz not null
);
alter table public.pro_payment_order_query_leases enable row level security;
revoke all on public.pro_payment_order_query_leases from public, anon, authenticated;
grant select, insert, update, delete on public.pro_payment_order_query_leases to service_role;
create policy pro_payment_order_query_leases_service_only
  on public.pro_payment_order_query_leases for all to service_role using (true) with check (true);

-- Preserve the existing signature and cooldown policy, but issue a durable fencing token.
-- A claimed request is never replayed immediately after an ambiguous HTTP response.
create or replace function public.sunland_claim_pro_payment_order_query(p_order_id text)
returns jsonb language plpgsql security invoker set search_path = pg_catalog, public, extensions
as $$
declare
  v_row public.pro_payment_orders%rowtype;
  v_lease public.pro_payment_order_query_leases%rowtype;
  v_due timestamptz;
  v_token uuid;
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
  select * into v_lease from public.pro_payment_order_query_leases where order_id = p_order_id;
  if v_lease.lease_until > clock_timestamp() then
    return jsonb_build_object('acquired', false, 'status', v_row.status,
      'reason_code', v_row.last_error_code, 'retry_after_seconds',
      greatest(1, ceil(extract(epoch from v_lease.lease_until - clock_timestamp()))::integer));
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
    return jsonb_build_object('acquired', false, 'status', v_row.status,
      'reason_code', v_row.last_error_code, 'retry_after_seconds',
      greatest(1, ceil(extract(epoch from v_due - clock_timestamp()))::integer));
  end if;
  v_token := extensions.gen_random_uuid();
  insert into public.pro_payment_order_query_leases(order_id, lease_token, lease_until)
    values(p_order_id, v_token, clock_timestamp() + interval '2 minutes')
    on conflict(order_id) do update set lease_token = excluded.lease_token, lease_until = excluded.lease_until;
  update public.pro_payment_orders set last_seen_at = clock_timestamp(),
    next_retry_at = case when status = 'unresolved' then clock_timestamp() + interval '2 minutes' else null end
    where order_id = p_order_id;
  return jsonb_build_object('acquired', true, 'status', v_row.status,
    'reason_code', v_row.last_error_code, 'retry_after_seconds', 0, 'lease_token', v_token);
end;
$$;

create function public.sunland_finish_pro_payment_order_query(
  p_order jsonb, p_processing_source text, p_trace_id uuid, p_lease_token uuid
)
returns jsonb language plpgsql security invoker set search_path = pg_catalog, public, extensions
as $$
declare v_id text := p_order->>'order_id'; v_result jsonb; v_row public.pro_payment_orders%rowtype;
begin
  if v_id is null or v_id !~ '^[A-Za-z0-9_-]{6,128}$' or p_lease_token is null then
    raise exception 'INVALID_PAYMENT_ORDER_QUERY_COMPLETION' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext(v_id));
  if not exists(select 1 from public.pro_payment_order_query_leases
    where order_id = v_id and lease_token = p_lease_token and lease_until > clock_timestamp()) then
    select * into v_row from public.pro_payment_orders where order_id = v_id;
    return jsonb_build_object('order_id', v_id, 'status', coalesce(v_row.status, 'unresolved'),
      'reason_code', 'LEASE_FENCED', 'acquired', false);
  end if;
  v_result := public.sunland_process_verified_pro_order(p_order, p_processing_source, p_trace_id, false);
  delete from public.pro_payment_order_query_leases where order_id = v_id and lease_token = p_lease_token;
  return v_result;
end;
$$;

create function public.sunland_fail_pro_payment_order_query(
  p_order_id text, p_reason_code text, p_processing_source text, p_trace_id uuid, p_lease_token uuid
)
returns jsonb language plpgsql security invoker set search_path = pg_catalog, public, extensions
as $$
declare v_result jsonb;
begin
  if p_order_id is null or p_order_id !~ '^[A-Za-z0-9_-]{6,128}$' or p_lease_token is null then
    raise exception 'INVALID_PAYMENT_ORDER_QUERY_FAILURE' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext(p_order_id));
  if not exists(select 1 from public.pro_payment_order_query_leases
    where order_id = p_order_id and lease_token = p_lease_token and lease_until > clock_timestamp()) then
    return jsonb_build_object('recorded', false, 'reason_code', 'LEASE_FENCED');
  end if;
  v_result := public.sunland_note_pro_payment_retry(p_order_id, p_reason_code, p_processing_source, p_trace_id);
  delete from public.pro_payment_order_query_leases where order_id = p_order_id and lease_token = p_lease_token;
  return v_result;
end;
$$;

-- Admission is shared by recent/history scans and query leases. Hints for the whole
-- page are durable before this bounded batch, so deferred new rows enter retry.
-- Recheck terminal/blocked facts daily; actionable unresolved rows keep their due date.
create function public.sunland_process_pro_payment_scan_orders(
  p_orders jsonb, p_processing_source text, p_trace_id uuid
)
returns jsonb language plpgsql security invoker set search_path = pg_catalog, public, extensions
as $$
declare
  v_id text;
  v_candidate record;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
  v_processed integer := 0;
begin
  if jsonb_typeof(p_orders) is distinct from 'array' then
    raise exception 'INVALID_PAYMENT_SCAN_ORDERS' using errcode = '22023';
  end if;
  if jsonb_array_length(p_orders) > 50 or p_trace_id is null
    or p_processing_source is null or p_processing_source not in ('cron_recent', 'cron_history', 'user_reconcile')
    or exists(select 1 from jsonb_array_elements(p_orders) o where
      jsonb_typeof(o) is distinct from 'object' or jsonb_typeof(o->'order_id') is distinct from 'string'
      or o->>'order_id' !~ '^[A-Za-z0-9_-]{6,128}$' or o->>'provider' is distinct from 'afdian'
      or (o ? 'validation_error' and (jsonb_typeof(o->'validation_error') is distinct from 'string'
        or o->>'validation_error' not in ('INVALID_BINDING', 'INVALID_PRODUCT', 'AMOUNT_MISMATCH', 'PROVIDER_FACT_CONFLICT'))))
    or (select count(*) <> count(distinct o->>'order_id') from jsonb_array_elements(p_orders) o) then
    raise exception 'INVALID_PAYMENT_SCAN_ORDERS' using errcode = '22023';
  end if;
  -- ponytail: one database-only batch at a time (at most 50 hints/eight facts).
  -- Multi-order grants retain user/profile locks until commit; serializing batches
  -- prevents disjoint orders binding the same users in opposite order from deadlocking.
  -- No network work runs under this lock. Single-order query completion stays independent.
  perform pg_advisory_xact_lock(20261011, 30000);
  -- Acquire all order locks in a stable order before reading admission state.
  -- This avoids cross-page deadlocks when priority changes between invocations.
  for v_id in select o->>'order_id' from jsonb_array_elements(p_orders) o order by 1 loop
    perform pg_advisory_xact_lock(hashtext(v_id));
  end loop;
  if exists(select 1 from jsonb_array_elements(p_orders) o
    where not exists(select 1 from public.pro_payment_orders r where r.order_id = o->>'order_id')) then
    raise exception 'PAYMENT_SCAN_HINT_NOT_DURABLE' using errcode = '22023';
  end if;
  for v_candidate in
    with facts as (
      select o as payload, r.*,
        not (o ? 'validation_error') and r.last_verified_at is not null and (
          r.payment_status is distinct from o->>'payment_status' or
          r.verified_product is distinct from jsonb_build_object('provider', 'afdian',
            'product_type', o->>'product_type', 'plan_id', o->>'plan_id',
            'sku_id', o->'sku_detail'->0->>'sku_id', 'quantity', o->'sku_detail'->0->'count',
            'currency', o->>'currency', 'amount_cents', o->'amount_cents') or
          r.verified_binding_reference is distinct from nullif(o->>'binding_reference', '') or
          r.binding_source is distinct from o->>'binding_source' or
          (r.paid_at is not null and o->>'paid_at' is not null and
            to_char(r.paid_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') is distinct from o->>'paid_at')
        ) as fact_changed,
        not (o ? 'validation_error') and r.last_verified_at is not null and r.payment_status = 'paid'
          and o->>'payment_status' in ('refunded', 'cancelled', 'unknown') as payment_downgrade,
        (r.payment_status in ('refunded', 'cancelled') or coalesce(r.last_error_code, '') in ('ACCOUNT_DELETING', 'ACCOUNT_RETIRED', 'OWNER_ANONYMIZED',
          'BINDING_CONFLICT', 'PROVIDER_FACT_CONFLICT', 'DATA_DELETED', 'INVALID_BINDING',
          'AMOUNT_MISMATCH', 'INVALID_PRODUCT', 'HISTORICAL_PAYMENT_ACTIVATION')) as blocked
      from jsonb_array_elements(p_orders) o join public.pro_payment_orders r on r.order_id = o->>'order_id'
    )
    select * from facts f where
      not exists(select 1 from public.pro_payment_order_query_leases l
        where l.order_id = f.order_id and l.lease_until > clock_timestamp()) and (
        (payload ? 'validation_error' and status = 'unresolved' and next_retry_at is not null
          and next_retry_at <= clock_timestamp() and not blocked) or
        (not (payload ? 'validation_error') and (
        payment_downgrade or
        (status = 'unresolved' and next_retry_at is not null and next_retry_at <= clock_timestamp()) or
        (status <> 'unresolved' and fact_changed and not blocked) or
        ((status <> 'unresolved' or next_retry_at is null)
          and coalesce(last_verified_at, first_seen_at) <= clock_timestamp() - interval '24 hours')))
      )
    order by payment_downgrade desc, (fact_changed and not blocked) desc,
      last_verified_at asc nulls first, next_retry_at asc nulls last, order_id
    limit 8
  loop
    begin
      if v_candidate.payload ? 'validation_error' then
        v_result := public.sunland_note_pro_payment_retry(v_candidate.order_id,
          case when v_candidate.payload->>'validation_error' = 'PROVIDER_FACT_CONFLICT'
            then 'PROVIDER_VERIFICATION_REQUIRED' else v_candidate.payload->>'validation_error' end,
          p_processing_source, p_trace_id);
      else
        v_result := public.sunland_process_verified_pro_order(v_candidate.payload, p_processing_source, p_trace_id, false);
      end if;
    exception when sqlstate '22023' then
      -- Only malformed business input is isolated. Database/transaction failures
      -- abort the whole batch and preserve the cursor for recovery.
      v_result := public.sunland_note_pro_payment_retry(v_candidate.order_id,
        'PROVIDER_VERIFICATION_REQUIRED', p_processing_source, p_trace_id);
    end;
    -- Retry-note RPC has a different JSON shape; expose the durable ledger state
    -- through the same batch result contract as verified processing.
    if v_result->>'status' is null then
      select v_result || jsonb_build_object('order_id', order_id, 'status', status,
        'reason_code', last_error_code) into v_result
        from public.pro_payment_orders where order_id = v_candidate.order_id;
    end if;
    v_processed := v_processed + 1;
    v_results := v_results || jsonb_build_array(v_result);
  end loop;
  return jsonb_build_object('processed', v_processed,
    'skipped', jsonb_array_length(p_orders) - v_processed, 'results', v_results);
end;
$$;

-- Retry lane completion sets last_success_at through the existing fenced RPC.
-- Keep the same scan signature; apply the existing 20s admission cooldown to retry.
do $patch$
declare v_definition text; v_anchor constant text := 'p_state_key = ''recent''';
begin
  v_definition := pg_get_functiondef('public.sunland_claim_pro_payment_scan(text)'::regprocedure);
  if (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor) <> 2 then
    raise exception 'AFDIAN_SCAN_CLAIM_BASELINE_CHANGED';
  end if;
  if position('interval ''30 seconds''' in v_definition) = 0 then
    raise exception 'AFDIAN_SCAN_LEASE_BASELINE_CHANGED';
  end if;
  execute replace(replace(v_definition, v_anchor, 'p_state_key in (''recent'', ''retry'')'),
    'interval ''30 seconds''', 'interval ''3 minutes''');
end;
$patch$;

revoke all on function public.sunland_claim_pro_payment_order_query(text) from public, anon, authenticated;
revoke all on function public.sunland_finish_pro_payment_order_query(jsonb, text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.sunland_fail_pro_payment_order_query(text, text, text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.sunland_process_pro_payment_scan_orders(jsonb, text, uuid) from public, anon, authenticated;
grant execute on function public.sunland_claim_pro_payment_order_query(text) to service_role;
grant execute on function public.sunland_finish_pro_payment_order_query(jsonb, text, uuid, uuid) to service_role;
grant execute on function public.sunland_fail_pro_payment_order_query(text, text, text, uuid, uuid) to service_role;
grant execute on function public.sunland_process_pro_payment_scan_orders(jsonb, text, uuid) to service_role;
commit;
