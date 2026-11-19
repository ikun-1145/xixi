-- Minimal mirror of production objects used by the unified registration RPC.
create table public.user_profiles(user_id text primary key, email text, is_banned boolean not null default false,
  identity_status text not null default 'active' check (identity_status in ('active','deleting','retired')),
  onboarding_version smallint not null default 0, onboarding_step smallint not null default 1,
  check ((onboarding_version=0 and onboarding_step between 1 and 3) or (onboarding_version=1 and onboarding_step=3)));
create unique index user_profiles_email_unique_idx on public.user_profiles(lower(email))
  where email is not null and identity_status is distinct from 'retired';
create table public.sunland_phone_auth_config(singleton boolean primary key default true check(singleton),
  lookup_key_id text check (lookup_key_id ~ '^[A-Za-z0-9_-]{1,64}$'), lookup_check text check (lookup_check ~ '^[0-9a-f]{64}$'));
create table public.sunland_phone_auth_state(user_id text primary key references public.user_profiles, version bigint not null default 0);
create table public.sunland_phone_identities(user_id text primary key references public.user_profiles, phone_hash text not null unique,
  lookup_key_id text not null, encrypted_phone text not null, last4 text not null);
create table public.sunland_phone_auth_operations(operation_id uuid primary key, request_hash text not null,
  user_id text not null references public.user_profiles, action text not null
  check (action in ('login','bind','change','unbind','delete_authorize','release')), result jsonb not null);
create table public.sunland_otp_challenges(subject text primary key, request_id uuid not null, code_hash text not null,
  state text not null check (state in ('sending','ready','consumed','failed')), expires_at timestamptz not null,
  next_send_at timestamptz not null, failures integer not null default 0 check (failures between 0 and 5));
create table public.sunland_otp_limits(key text primary key, started_at timestamptz not null, used integer not null, expires_at timestamptz not null);
revoke all on all tables in schema public from anon, authenticated;

create function public.sunland_phone_identity(text,jsonb) returns jsonb language sql as $$ select '{}'::jsonb $$;
revoke all on function public.sunland_phone_identity(text,jsonb) from public, anon, authenticated;

create or replace function public.sunland_otp_budget(p_key text, p_limit integer, p_seconds integer)
 returns integer language plpgsql security definer set search_path to '' as $function$
declare v_now timestamptz := clock_timestamp(); v_row public.sunland_otp_limits%rowtype;
begin
  insert into public.sunland_otp_limits as l(key,started_at,used,expires_at)
  values(p_key,v_now,1,v_now+make_interval(secs=>p_seconds))
  on conflict(key) do update set
    used=case when l.expires_at<=v_now then 1 else least(l.used+1,p_limit+1) end,
    started_at=case when l.expires_at<=v_now then v_now else l.started_at end,
    expires_at=case when l.expires_at<=v_now then excluded.expires_at else l.expires_at end
  returning * into v_row;
  if v_row.used>p_limit then return greatest(1,ceil(extract(epoch from v_row.expires_at-v_now))::integer); end if;
  return 0;
end $function$;

create or replace function public.sunland_otp(p_action text, p_subject text, p_ip text, p_request_id uuid default null, p_code_hash text default null, p_delivery text default null)
 returns jsonb language plpgsql security definer set search_path to '' as $function$
declare v_row public.sunland_otp_challenges%rowtype; v_now timestamptz; v_retry integer; v_budget integer;
begin
  if p_subject is null or p_subject !~ '^[0-9a-f]{64}$' or p_ip is null or p_ip !~ '^[0-9a-f]{64}$'
     or p_action is null or p_action not in ('reserve','challenge','consume','delivery') then
    raise exception 'Invalid OTP arguments' using errcode='22023';
  end if;
  if p_action in ('reserve','consume') and (p_request_id is null or p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$') then
    raise exception 'Invalid OTP arguments' using errcode='22023';
  end if;
  if p_action in ('reserve','challenge') then
    if p_action='reserve' then
      v_retry:=public.sunland_otp_budget('send:global',600,60);
      if v_retry>0 then return jsonb_build_object('code','THROTTLED','retry_after',v_retry); end if;
      v_budget:=public.sunland_otp_budget('send:ip:'||p_ip,20,600); v_retry:=greatest(v_retry,v_budget);
      if v_retry>0 then return jsonb_build_object('code','THROTTLED','retry_after',v_retry); end if;
      v_budget:=public.sunland_otp_budget('send:mail:'||p_subject,10,3600);
    else
      v_retry:=public.sunland_otp_budget('verify:global',6000,60);
      if v_retry>0 then return jsonb_build_object('code','THROTTLED','retry_after',v_retry); end if;
      v_budget:=public.sunland_otp_budget('verify:ip:'||p_ip,60,60); v_retry:=greatest(v_retry,v_budget);
      if v_retry>0 then return jsonb_build_object('code','THROTTLED','retry_after',v_retry); end if;
      v_budget:=public.sunland_otp_budget('verify:mail:'||p_subject,30,300);
    end if;
    v_retry:=greatest(v_retry,v_budget);
    if v_retry>0 then return jsonb_build_object('code','THROTTLED','retry_after',v_retry); end if;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('sunland-otp:'||p_subject,0));
  v_now:=clock_timestamp();
  select * into v_row from public.sunland_otp_challenges where subject=p_subject for update;
  if p_action='reserve' then
    insert into public.sunland_otp_challenges(subject,request_id,code_hash,state,expires_at,next_send_at,failures)
    values(p_subject,p_request_id,p_code_hash,'ready',v_now+interval '5 minutes',v_now+interval '60 seconds',0)
    on conflict(subject) do update set request_id=excluded.request_id,code_hash=excluded.code_hash,
      state=excluded.state,expires_at=excluded.expires_at,next_send_at=excluded.next_send_at,failures=0;
    return jsonb_build_object('code','OK');
  elsif p_action='challenge' then
    if found and v_row.expires_at>v_now and v_row.state in ('sending','ready') then
      return jsonb_build_object('code','OK','request_id',v_row.request_id);
    end if;
    return jsonb_build_object('code','OK','request_id',pg_catalog.gen_random_uuid());
  end if;
  if not found or v_row.request_id<>p_request_id or v_row.expires_at<=v_now or v_row.state not in ('sending','ready') then
    return jsonb_build_object('code','INVALID');
  end if;
  if v_row.failures>=5 then return jsonb_build_object('code','THROTTLED','retry_after',1); end if;
  if v_row.code_hash<>p_code_hash then
    update public.sunland_otp_challenges set failures=failures+1 where subject=p_subject;
    return jsonb_build_object('code','INVALID');
  end if;
  update public.sunland_otp_challenges set state='consumed' where subject=p_subject;
  return jsonb_build_object('code','OK');
end $function$;
revoke all on function public.sunland_otp(text,text,text,uuid,text,text) from public, anon, authenticated;
grant execute on function public.sunland_otp(text,text,text,uuid,text,text) to service_role;
insert into public.sunland_phone_auth_config values(true,'v1',repeat('c',64));
