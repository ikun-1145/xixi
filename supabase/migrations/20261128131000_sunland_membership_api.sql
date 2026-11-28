begin;
set local lock_timeout = '3s';

create schema sunland_membership;
revoke all on schema sunland_membership from public, anon, authenticated, service_role;

-- A dedicated RPC credential avoids granting a PostgreSQL LOGIN or service-role access.
create table sunland_membership.worker_credentials (
  id uuid primary key default gen_random_uuid(),
  secret_hash text not null unique check (secret_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table sunland_membership.partners (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9_-]{0,47}$'),
  enabled boolean not null default true,
  requests_per_minute integer not null default 60 check (requests_per_minute between 1 and 6000),
  requests_per_day integer not null default 5000 check (requests_per_day > 0),
  emails_per_day integer not null default 50000 check (emails_per_day > 0),
  batch_limit integer not null default 100 check (batch_limit between 1 and 100),
  quota_day date,
  daily_requests integer not null default 0,
  daily_emails integer not null default 0,
  daily_checked_emails integer not null default 0,
  daily_denied_emails integer not null default 0,
  recent_requests timestamptz[] not null default '{}'
);

create table sunland_membership.api_keys (
  id uuid primary key default gen_random_uuid(),
  partner_id text not null references sunland_membership.partners(id),
  key_hash text not null unique check (key_hash ~ '^[a-f0-9]{64}$'),
  scope text not null default 'membership:read' check (scope = 'membership:read'),
  created_at timestamptz not null default now(),
  expires_at timestamptz check (expires_at > created_at),
  disabled_at timestamptz,
  revoked_at timestamptz
);

create table sunland_membership.authorizations (
  partner_id text not null references sunland_membership.partners(id),
  user_id text not null references public.user_profiles(user_id) on delete cascade,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (partner_id, user_id)
);

-- Supports profile deletion without scanning partner authorizations.
create index membership_authorizations_user_idx on sunland_membership.authorizations(user_id);

alter table sunland_membership.worker_credentials enable row level security;
alter table sunland_membership.partners enable row level security;
alter table sunland_membership.api_keys enable row level security;
alter table sunland_membership.authorizations enable row level security;
revoke all on all tables in schema sunland_membership from public, anon, authenticated, service_role;

create function public.sunland_membership_check(
  p_worker_token text, p_hash text, p_emails text[], p_count integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  v_key sunland_membership.api_keys%rowtype;
  v_partner sunland_membership.partners%rowtype;
  v_now timestamptz;
  v_day date;
  v_retry integer := 0;
  v_results jsonb;
  v_denied integer;
begin
  if p_worker_token is null or length(p_worker_token) <> 51
      or p_worker_token !~ '^slw_rpc_[A-Za-z0-9_-]{43}$' then
    return jsonb_build_object('status', 503);
  end if;
  perform 1 from sunland_membership.worker_credentials
    where secret_hash = encode(sha256(convert_to(p_worker_token, 'UTF8')), 'hex')
      and revoked_at is null for share;
  if not found then
    return jsonb_build_object('status', 503);
  end if;

  if p_hash is null or p_hash !~ '^[a-f0-9]{64}$'
      or p_count is null or p_count < 1 or p_count > 100
      or p_emails is null or cardinality(p_emails) not between 1 and p_count
      or exists (select 1 from unnest(p_emails) e where e is null or length(e) not between 3 and 254)
      or (select count(distinct e) from unnest(p_emails) e) <> cardinality(p_emails) then
    return jsonb_build_object('status', 400);
  end if;

  select * into v_key from sunland_membership.api_keys where key_hash = p_hash for share;
  if not found or v_key.revoked_at is not null or v_key.expires_at <= clock_timestamp() then
    return jsonb_build_object('status', 401);
  end if;

  if v_key.disabled_at is not null or v_key.scope <> 'membership:read' then
    return jsonb_build_object('status', 403, 'partner', v_key.partner_id);
  end if;

  -- Serialize requests across every key and region for this partner.
  select * into strict v_partner from sunland_membership.partners where id = v_key.partner_id for update;
  v_now := clock_timestamp();
  if v_key.expires_at <= v_now then
    return jsonb_build_object('status', 401);
  end if;
  if not v_partner.enabled then
    return jsonb_build_object('status', 403, 'partner', v_partner.id);
  end if;
  if p_count > v_partner.batch_limit then
    return jsonb_build_object('status', 400, 'partner', v_partner.id);
  end if;

  v_day := (v_now at time zone 'UTC')::date;
  if v_partner.quota_day is distinct from v_day then
    v_partner.daily_requests := 0;
    v_partner.daily_emails := 0;
    v_partner.daily_checked_emails := 0;
    v_partner.daily_denied_emails := 0;
  end if;
  select array(select ts from unnest(v_partner.recent_requests) ts
    where ts > v_now - interval '1 minute' order by ts) into v_partner.recent_requests;
  if cardinality(v_partner.recent_requests) >= v_partner.requests_per_minute then
    v_retry := greatest(1, ceil(extract(epoch from
      v_partner.recent_requests[cardinality(v_partner.recent_requests) - v_partner.requests_per_minute + 1]
      + interval '1 minute' - v_now))::integer);
  end if;
  if v_partner.daily_requests >= v_partner.requests_per_day or
      p_count > v_partner.emails_per_day - v_partner.daily_emails then
    v_retry := greatest(v_retry, ceil(extract(epoch from
      ((v_day + 1)::timestamp at time zone 'UTC') - v_now))::integer);
  end if;
  if v_retry > 0 then
    return jsonb_build_object('status', 429, 'partner', v_partner.id, 'retry_after', v_retry);
  end if;

  -- Resolve each input through the existing partial email index in a single SQL statement.
  -- An authorization is tied to the account ID, so a recycled email cannot carry it over.
  select
    jsonb_agg(jsonb_build_object('email', wanted.email,
      'is_pro', coalesce(a.user_id is not null and profile.is_pro, false)) order by wanted.position),
    count(*) filter (where a.user_id is null)
  into v_results, v_denied
  from unnest(p_emails) with ordinality as wanted(email, position)
  left join lateral (
    select p.user_id, p.pro is true and not coalesce(p.is_banned, false) and p.identity_status = 'active' as is_pro
    from public.user_profiles p
    where p.email is not null and p.identity_status is distinct from 'retired'
      and lower(p.email) = wanted.email
    limit 1
  ) profile on true
  left join sunland_membership.authorizations a
    on a.partner_id = v_partner.id and a.user_id = profile.user_id and a.revoked_at is null;

  update sunland_membership.partners set
    quota_day = v_day,
    daily_requests = v_partner.daily_requests + 1,
    daily_emails = v_partner.daily_emails + p_count,
    daily_checked_emails = v_partner.daily_checked_emails + cardinality(p_emails),
    daily_denied_emails = v_partner.daily_denied_emails + v_denied,
    recent_requests = array_append(v_partner.recent_requests, v_now)
  where id = v_partner.id;

  return jsonb_build_object('status', 200, 'partner', v_partner.id, 'results', v_results,
    'anomaly', v_partner.daily_denied_emails + v_denied >= 100
      and (v_partner.daily_denied_emails + v_denied)::bigint * 10
          >= (v_partner.daily_checked_emails::bigint + cardinality(p_emails)) * 9);
end;
$$;

revoke all on function public.sunland_membership_check(text,text,text[],integer)
  from public, anon, authenticated, service_role;
grant execute on function public.sunland_membership_check(text,text,text[],integer) to anon;
notify pgrst, 'reload schema';

commit;
