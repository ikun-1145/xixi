-- Reviewed schema-only trigger dependencies, extracted from immutable local Git commits.

-- No production records, credentials, or customer values are included.

create schema waffo_prod;

create table public.ai_quota_days (
  user_id text not null,
  usage_date date not null,
  used integer not null default 0,
  pending integer not null default 0,
  primary key (user_id, usage_date),
  check (used >= 0 and pending >= 0 and used + pending <= 20)
);

create table public.ai_quota_requests (
  user_id text not null,
  request_id text not null,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  usage_date date not null,
  attempt bigint not null default 0 check (attempt >= 0),
  state text not null default 'released' check (state in ('pending', 'committed', 'released')),
  countable boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, request_id),
  foreign key (user_id, usage_date) references public.ai_quota_days(user_id, usage_date)
    deferrable initially deferred,
  check (state = 'released' or attempt > 0)
);

create table public.conversation_sync_receipts (
  user_id text not null references public.user_profiles(user_id) on delete cascade,
  operation_id text not null,
  payload_hash text not null,
  committed boolean not null default false,
  created_at timestamptz not null default now(),
  primary key(user_id, operation_id)
);

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

create table waffo_prod.projection_context (
  transaction_id bigint not null,
  user_id text not null,
  primary key (transaction_id, user_id)
);

create function public.ai_quota_cleanup_retired_account()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  delete from public.ai_quota_requests where user_id=new.user_id;
  delete from public.ai_quota_days where user_id=new.user_id;
  return new;
end $$;

create function public.sunland_history_cleanup_retired_account()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  delete from public.conversation_sync_receipts where user_id=new.user_id;
  return new;
end $$;

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

create function public.set_updated_at() returns trigger language plpgsql as $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

create trigger ai_quota_cleanup_retired_account after update of identity_status on public.user_profiles
  for each row when (new.identity_status='retired' and old.identity_status is distinct from 'retired')
  execute function public.ai_quota_cleanup_retired_account();

create trigger sunland_history_cleanup_retired_account after update of identity_status on public.user_profiles
  for each row when (new.identity_status='retired' and old.identity_status is distinct from 'retired')
  execute function public.sunland_history_cleanup_retired_account();

create trigger waffo_capture_profile_insert after insert on public.user_profiles
for each row execute function waffo_prod.capture_profile_source();

create trigger waffo_capture_profile_update after update of pro on public.user_profiles
for each row execute function waffo_prod.capture_profile_source();

CREATE TRIGGER trg_user_profiles_updated_at BEFORE UPDATE ON public.user_profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

alter table public.ai_quota_days enable row level security;

alter table public.ai_quota_requests enable row level security;

alter table public.conversation_sync_receipts enable row level security;

alter table waffo_prod.payment_intents enable row level security;

alter table waffo_prod.orders enable row level security;

alter table waffo_prod.entitlement_sources enable row level security;

alter table waffo_prod.projection_context enable row level security;
