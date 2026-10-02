-- Waffo production source authority. D1 is only an audit/outbox mirror.
-- This migration never changes an existing profile's pro/identity flags.
-- Deployment precondition: the legacy two-argument payment RPC is either the audited
-- version (patched below) or a replacement that never writes user_profiles (e.g. the
-- verified-reconciliation wrapper), so migration order does not matter. Anything else fails closed.
-- Runs inside the migration runner transaction (apply_migration / supabase db push).
do $guard$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.sunland_activate_pro_from_payment(text,text)'::regprocedure))
     <> 'dc1110b67ee43b6ba2c02da43065b603'
    and (select prosrc from pg_catalog.pg_proc
         where oid = 'public.sunland_activate_pro_from_payment(text,text)'::regprocedure) ~* 'user_profiles' then
    raise exception 'WAFFO_LEGACY_RPC_CHANGED' using errcode = '55000';
  end if;
end;
$guard$;
lock table public.user_profiles in share row exclusive mode;
create schema waffo_prod;
revoke all on schema waffo_prod from public, anon, authenticated, service_role;

create table waffo_prod.payment_intents (
  payment_reference uuid primary key,
  user_id text not null,
  request_key uuid not null,
  merchant_id text not null check (merchant_id = 'MER_6mey7SY5b0KXN1W7JiZYSz'),
  store_id text not null check (store_id = 'STO_4gmpGF9UEj1SO6vpelNcmy'),
  product_id text not null check (product_id = 'PROD_5buXbrDEzQX6Nya6p1wMC5'),
  mode text not null check (mode = 'prod'),
  currency text not null check (currency = 'CNY'),
  amount_minor integer not null check (amount_minor = 1500),
  created_at timestamptz not null default now(),
  unique (user_id, request_key)
);
create table waffo_prod.orders (
  order_id text primary key check (order_id ~ '^ORD_[A-Za-z0-9]+$'),
  payment_id text not null unique check (payment_id ~ '^PAY_[A-Za-z0-9]+$'),
  payment_reference uuid not null unique references waffo_prod.payment_intents(payment_reference),
  user_id text not null,
  proof_sha256 text check (proof_sha256 ~ '^[a-f0-9]{64}$'),
  payment_confirmed boolean not null default false,
  state text not null default 'pending' check (state in ('pending', 'granted', 'refunded', 'revoked')),
  version integer not null default 1 check (version > 0),
  updated_at timestamptz not null default now()
);
create table waffo_prod.entitlement_sources (
  provider text not null check (provider in ('legacy', 'other', 'waffo')),
  source_id text not null,
  user_id text not null references public.user_profiles(user_id) on delete cascade,
  active boolean not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (provider, source_id)
);
create index entitlement_sources_active_user on waffo_prod.entitlement_sources(user_id) where active;
create table waffo_prod.events (
  event_type text not null check (event_type in ('order.completed', 'refund.succeeded', 'refund.failed')),
  event_id text not null,
  event_sha256 text not null check (event_sha256 ~ '^[a-f0-9]{64}$'),
  order_id text not null references waffo_prod.orders(order_id),
  recorded_at timestamptz not null default now(),
  primary key (event_type, event_id)
);
-- A protected transaction context cannot be forged using JWT claims or custom GUCs.
create table waffo_prod.projection_context (
  transaction_id bigint not null,
  user_id text not null,
  primary key (transaction_id, user_id)
);
insert into waffo_prod.entitlement_sources(provider, source_id, user_id, active)
select 'legacy', user_id, user_id, true from public.user_profiles where pro is true;

create function waffo_prod.capture_profile_source() returns trigger
language plpgsql security definer set search_path = '' as $function$
begin
  if exists(select 1 from waffo_prod.projection_context
      where transaction_id = pg_catalog.txid_current() and user_id = new.user_id) then
    return new;
  end if;
  if new.pro is true then
    insert into waffo_prod.entitlement_sources(provider, source_id, user_id, active)
    values ('other', 'profile:' || new.user_id, new.user_id, true)
    on conflict (provider, source_id) do update set active = true, updated_at = now();
  else
    -- Respect a legacy/manual revoke. Replaying an old Waffo completion cannot undo it.
    update waffo_prod.entitlement_sources set active = false, updated_at = now()
    where user_id = new.user_id and active;
    update waffo_prod.orders set state = 'revoked', version = version + 1, updated_at = now()
    where user_id = new.user_id and state in ('pending', 'granted');
  end if;
  return new;
end;
$function$;
create trigger waffo_capture_profile_insert after insert on public.user_profiles
for each row execute function waffo_prod.capture_profile_source();
create trigger waffo_capture_profile_update after update of pro on public.user_profiles
for each row execute function waffo_prod.capture_profile_source();

create function waffo_prod.capture_legacy_payment(p_user_id text, p_order_id text) returns void
language plpgsql security definer set search_path = '' as $function$
begin
  insert into waffo_prod.entitlement_sources(provider, source_id, user_id, active)
  values ('other', 'payment:' || p_order_id, p_user_id, true)
  on conflict (provider, source_id) do nothing;
  if exists(select 1 from waffo_prod.entitlement_sources where provider = 'other'
    and source_id = 'payment:' || p_order_id and user_id <> p_user_id) then
    raise exception 'PAYMENT_ORDER_USER_MISMATCH' using errcode = '22023';
  end if;
end;
$function$;
-- Exact audited function, with only the additive source capture before already_pro.
-- Skipped when a replacement already stopped writing user_profiles (the trigger covers it).
do $patch$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.sunland_activate_pro_from_payment(text,text)'::regprocedure))
     = 'dc1110b67ee43b6ba2c02da43065b603' then
    execute $sql$
create or replace function public.sunland_activate_pro_from_payment(p_user_id text, p_order_id text)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare
  v_existing_order_user_id text;
  v_is_pro boolean;
  v_identity_status text;
begin
  if char_length(btrim(coalesce(p_user_id, ''))) = 0
    or char_length(btrim(coalesce(p_order_id, ''))) = 0 then
    raise exception 'INVALID_PAYMENT_REFERENCE' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('payment-order:' || p_order_id, 0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('payment-user:' || p_user_id, 0));
  select pa.user_id into v_existing_order_user_id from public.pro_activations pa where pa.order_id = p_order_id;
  if found then
    if v_existing_order_user_id <> p_user_id then
      raise exception 'PAYMENT_ORDER_USER_MISMATCH' using errcode = '22023';
    end if;
    return jsonb_build_object('status', 'already_processed');
  end if;
  select up.pro, up.identity_status into v_is_pro, v_identity_status
    from public.user_profiles up where up.user_id = p_user_id for update;
  if not found or v_identity_status <> 'active' then
    raise exception 'ACCOUNT_NOT_ACTIVE' using errcode = '42501';
  end if;
  perform waffo_prod.capture_legacy_payment(p_user_id, p_order_id);
  if coalesce(v_is_pro, false) then
    return jsonb_build_object('status', 'already_pro');
  else
    update public.user_profiles set pro = true where user_id = p_user_id;
  end if;
  insert into public.pro_activations (user_id, source, order_id) values (p_user_id, 'payment', p_order_id);
  return jsonb_build_object('status', 'activated');
end;
$function$;
$sql$;
  end if;
end;
$patch$;

create function public.sunland_waffo_register_intent(p_intent jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $function$
declare
  v_user text := p_intent->>'user_id';
  v_ref uuid := (p_intent->>'payment_reference')::uuid;
  v_request uuid := (p_intent->>'request_key')::uuid;
  v_existing waffo_prod.payment_intents%rowtype;
  v_active boolean;
  v_inserted boolean;
begin
  if jsonb_typeof(p_intent) <> 'object' or v_ref is null or v_request is null
    or p_intent->>'mode' is distinct from 'prod'
    or p_intent->>'merchant_id' is distinct from 'MER_6mey7SY5b0KXN1W7JiZYSz'
    or p_intent->>'store_id' is distinct from 'STO_4gmpGF9UEj1SO6vpelNcmy'
    or p_intent->>'product_id' is distinct from 'PROD_5buXbrDEzQX6Nya6p1wMC5'
    or p_intent->>'currency' is distinct from 'CNY'
    or p_intent->'amount_minor' is distinct from '1500'::jsonb then
    raise exception 'WAFFO_INVALID_INTENT' using errcode = '22023';
  end if;
  select identity_status = 'active' and not coalesce(is_banned, false) into v_active
  from public.user_profiles where user_id = v_user for update;
  if not found or v_active is distinct from true then
    raise exception 'ACCOUNT_NOT_ACTIVE' using errcode = '42501';
  end if;
  insert into waffo_prod.payment_intents(payment_reference,user_id,request_key,merchant_id,store_id,product_id,mode,currency,amount_minor)
  values(v_ref,v_user,v_request,p_intent->>'merchant_id',p_intent->>'store_id',p_intent->>'product_id','prod','CNY',1500)
  on conflict(user_id,request_key) do nothing;
  v_inserted := found;
  select * into v_existing from waffo_prod.payment_intents where user_id = v_user and request_key = v_request;
  return jsonb_build_object('status',case when v_inserted then 'registered' else 'duplicate' end,
    'paymentReference',v_existing.payment_reference,'paymentConfirmed',false,'entitlementState','pending','version',0);
end;
$function$;

create function public.sunland_waffo_apply_event(p_event jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $function$
declare
  v_type text := p_event->>'event_type';
  v_id text := p_event->>'event_id';
  v_order_id text := p_event->>'order_id';
  v_payment_id text := p_event->>'payment_id';
  v_ref uuid := (p_event->>'payment_reference')::uuid;
  v_user text := p_event->>'user_id';
  v_hash text := p_event->>'event_sha256';
  v_proof text := p_event->>'proof_sha256';
  v_intent waffo_prod.payment_intents%rowtype;
  v_order waffo_prod.orders%rowtype;
  v_old_event waffo_prod.events%rowtype;
  v_active boolean;
  v_pro boolean;
  v_duplicate boolean := false;
  v_enabled boolean;
  v_changed boolean := false;
  v_result text := 'recorded';
begin
  if jsonb_typeof(p_event) <> 'object' or v_ref is null
    or p_event->>'mode' is distinct from 'prod'
    or p_event->>'merchant_id' is distinct from 'MER_6mey7SY5b0KXN1W7JiZYSz'
    or p_event->>'store_id' is distinct from 'STO_4gmpGF9UEj1SO6vpelNcmy'
    or p_event->>'product_id' is distinct from 'PROD_5buXbrDEzQX6Nya6p1wMC5'
    or p_event->>'currency' is distinct from 'CNY'
    or v_type is null or v_type not in ('order.completed','refund.succeeded','refund.failed')
    or v_hash is null or v_hash !~ '^[a-f0-9]{64}$'
    or v_order_id is null or v_order_id !~ '^ORD_[A-Za-z0-9]+$'
    or v_payment_id is null or v_payment_id !~ '^PAY_[A-Za-z0-9]+$'
    or v_id is null or v_id !~ '^[A-Za-z0-9_-]{1,128}$' then
    raise exception 'WAFFO_INVALID_EVENT' using errcode = '22023';
  end if;
  if v_type = 'order.completed' then
    if v_id <> v_payment_id or p_event->>'payment_status' is distinct from 'succeeded'
      or p_event->>'order_status' is distinct from 'completed'
      or p_event->'amount_minor' is distinct from '1500'::jsonb
      or p_event->'charged_minor' is distinct from '1500'::jsonb
      or v_proof is null or v_proof !~ '^[a-f0-9]{64}$'
      or jsonb_typeof(p_event->'entitlement_enabled') is distinct from 'boolean' then
      raise exception 'WAFFO_INVALID_PAYMENT_PROOF' using errcode = '22023';
    end if;
    v_enabled := (p_event->>'entitlement_enabled')::boolean;
  elsif p_event->>'refund_status' is distinct from (case when v_type = 'refund.succeeded' then 'succeeded' else 'failed' end) then
    raise exception 'WAFFO_INVALID_REFUND_PROOF' using errcode = '22023';
  end if;
  -- Always lock profile before any order/event/source row. All writers that set pro
  -- acquire this same row lock, so grant/refund/source projection are atomic.
  select identity_status = 'active' and not coalesce(is_banned, false), pro into v_active, v_pro
  from public.user_profiles where user_id = v_user for update;
  if not found or v_active is distinct from true then
    raise exception 'ACCOUNT_NOT_ACTIVE' using errcode = '42501';
  end if;
  select * into v_intent from waffo_prod.payment_intents where payment_reference = v_ref;
  if not found or v_intent.user_id <> v_user then
    raise exception 'WAFFO_INTENT_USER_MISMATCH' using errcode = '22023';
  end if;
  insert into waffo_prod.orders(order_id,payment_id,payment_reference,user_id)
  values(v_order_id,v_payment_id,v_ref,v_user) on conflict(order_id) do nothing;
  select * into v_order from waffo_prod.orders where order_id = v_order_id for update;
  if v_order.payment_id <> v_payment_id or v_order.payment_reference <> v_ref or v_order.user_id <> v_user then
    raise exception 'WAFFO_ORDER_BINDING_CONFLICT' using errcode = '22023';
  end if;
  select * into v_old_event from waffo_prod.events where event_type = v_type and event_id = v_id;
  if found then
    if v_old_event.event_sha256 <> v_hash or v_old_event.order_id <> v_order_id then
      raise exception 'WAFFO_EVENT_CONFLICT' using errcode = '22023';
    end if;
    v_duplicate := true;
  else
    insert into waffo_prod.events(event_type,event_id,event_sha256,order_id) values(v_type,v_id,v_hash,v_order_id);
  end if;
  if v_type = 'refund.succeeded' then
    if v_order.state <> 'refunded' then
      update waffo_prod.orders set state = 'refunded', payment_confirmed = false, version = version + 1, updated_at = now()
      where order_id = v_order_id returning * into v_order;
      update waffo_prod.entitlement_sources set active = false, updated_at = now()
      where provider = 'waffo' and source_id = v_order_id;
      v_changed := true;
    end if;
    v_result := 'refunded';
  elsif v_type = 'order.completed' and v_order.state not in ('refunded','revoked') then
    if not v_order.payment_confirmed then
      update waffo_prod.orders set payment_confirmed = true, proof_sha256 = v_proof, version = version + 1, updated_at = now()
      where order_id = v_order_id returning * into v_order;
    elsif v_order.proof_sha256 <> v_proof then
      raise exception 'WAFFO_PAYMENT_PROOF_CONFLICT' using errcode = '22023';
    end if;
    if v_enabled and v_order.state = 'pending' then
      insert into waffo_prod.entitlement_sources(provider,source_id,user_id,active) values('waffo',v_order_id,v_user,true);
      update waffo_prod.orders set state = 'granted', version = version + 1, updated_at = now()
      where order_id = v_order_id returning * into v_order;
      v_changed := true;
    end if;
    v_result := case when v_order.state = 'granted' then 'granted' else 'recorded' end;
  elsif v_order.state in ('refunded','revoked') then
    v_result := case when v_order.state = 'refunded' then 'refunded' else 'revoked' end;
  end if;
  if v_changed then
    insert into waffo_prod.projection_context(transaction_id,user_id) values(pg_catalog.txid_current(),v_user);
    update public.user_profiles set pro = exists(select 1 from waffo_prod.entitlement_sources where user_id = v_user and active)
    where user_id = v_user;
    delete from waffo_prod.projection_context where transaction_id = pg_catalog.txid_current() and user_id = v_user;
  end if;
  return jsonb_build_object('status',case when v_duplicate and not v_changed then 'duplicate' else v_result end,
    'paymentConfirmed',v_order.payment_confirmed and v_order.state not in ('refunded','revoked'),
    'entitlementState',case when v_order.state in ('refunded','revoked') then 'revoked' else v_order.state end,'version',v_order.version);
end;
$function$;

create function public.sunland_waffo_status(p_user_id text, p_request_key uuid) returns jsonb
language sql stable security definer set search_path = '' as $function$
  select jsonb_build_object('paymentConfirmed',coalesce(o.payment_confirmed and o.state not in ('refunded','revoked'),false),
    'entitlementState',case when o.state in ('refunded','revoked') then 'revoked' else o.state end,'version',coalesce(o.version,0))
  from (select 1) seed left join waffo_prod.payment_intents i on i.user_id = p_user_id and i.request_key = p_request_key
    and exists(select 1 from public.user_profiles p where p.user_id = p_user_id and p.identity_status = 'active' and not coalesce(p.is_banned,false))
  left join waffo_prod.orders o on o.payment_reference = i.payment_reference;
$function$;

alter table waffo_prod.payment_intents enable row level security;
alter table waffo_prod.orders enable row level security;
alter table waffo_prod.entitlement_sources enable row level security;
alter table waffo_prod.events enable row level security;
alter table waffo_prod.projection_context enable row level security;
revoke all on all tables in schema waffo_prod from public, anon, authenticated, service_role;
revoke all on all functions in schema waffo_prod from public, anon, authenticated, service_role;
revoke all on function public.sunland_waffo_register_intent(jsonb) from public, anon, authenticated;
revoke all on function public.sunland_waffo_apply_event(jsonb) from public, anon, authenticated;
revoke all on function public.sunland_waffo_status(text,uuid) from public, anon, authenticated;
grant execute on function public.sunland_waffo_register_intent(jsonb) to service_role;
grant execute on function public.sunland_waffo_apply_event(jsonb) to service_role;
grant execute on function public.sunland_waffo_status(text,uuid) to service_role;
notify pgrst, 'reload schema';
