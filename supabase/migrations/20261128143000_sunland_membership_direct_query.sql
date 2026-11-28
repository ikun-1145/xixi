begin;
set local lock_timeout = '3s';

-- Direct lookup is an explicit partner capability. Existing and new partners start closed.
alter table sunland_membership.partners
  add column direct_query_enabled boolean not null default false,
  add column direct_query_approved_at timestamptz,
  add column direct_query_approval_ref text
    check (direct_query_approval_ref ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$'),
  add column daily_direct_checks integer not null default 0,
  add column daily_direct_no_matches integer not null default 0,
  add constraint membership_direct_query_requires_approval check (
    not direct_query_enabled or
    (direct_query_approved_at is not null and direct_query_approval_ref is not null)
  );

create or replace function public.sunland_membership_check(
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
  v_no_match integer;
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
  if not v_partner.enabled or not v_partner.direct_query_enabled then
    return jsonb_build_object('status', 403, 'partner', v_partner.id);
  end if;
  if p_count > v_partner.batch_limit then
    return jsonb_build_object('status', 400, 'partner', v_partner.id);
  end if;

  v_day := (v_now at time zone 'UTC')::date;
  if v_partner.quota_day is distinct from v_day then
    v_partner.daily_requests := 0;
    v_partner.daily_emails := 0;
    v_partner.daily_direct_checks := 0;
    v_partner.daily_direct_no_matches := 0;
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
  select
    jsonb_agg(jsonb_build_object('email', wanted.email,
      'is_pro', coalesce(profile.is_pro, false)) order by wanted.position),
    count(*) filter (where profile.is_pro is null)
  into v_results, v_no_match
  from unnest(p_emails) with ordinality as wanted(email, position)
  left join lateral (
    select p.pro is true and not coalesce(p.is_banned, false) and p.identity_status = 'active' as is_pro
    from public.user_profiles p
    where p.email is not null and p.identity_status is distinct from 'retired'
      and lower(p.email) = wanted.email
    limit 1
  ) profile on true;

  update sunland_membership.partners set
    quota_day = v_day,
    daily_requests = v_partner.daily_requests + 1,
    daily_emails = v_partner.daily_emails + p_count,
    daily_direct_checks = v_partner.daily_direct_checks + cardinality(p_emails),
    daily_direct_no_matches = v_partner.daily_direct_no_matches + v_no_match,
    recent_requests = array_append(v_partner.recent_requests, v_now)
  where id = v_partner.id;

  return jsonb_build_object('status', 200, 'partner', v_partner.id, 'results', v_results,
    'anomaly', v_partner.daily_direct_no_matches + v_no_match >= 100
      and (v_partner.daily_direct_no_matches + v_no_match)::bigint * 10
          >= (v_partner.daily_direct_checks::bigint + cardinality(p_emails)) * 9);
end;
$$;

revoke all on function public.sunland_membership_check(text,text,text[],integer)
  from public, anon, authenticated, service_role;
grant execute on function public.sunland_membership_check(text,text,text[],integer) to anon;
notify pgrst, 'reload schema';

commit;
