-- Local review artifact only. Do not apply to production without a separate approval.
begin;

create table public.sunland_phone_auth_config (
  singleton boolean primary key default true check (singleton),
  lookup_key_id text check (lookup_key_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  lookup_check text check (lookup_check ~ '^[0-9a-f]{64}$')
);
-- No automatic zero-state or key bootstrap: deployment must approve the canary.
insert into public.sunland_phone_auth_config(singleton) values (true);

create table public.sunland_phone_identities (
  user_id text primary key references public.user_profiles(user_id),
  phone_hash text not null unique check (phone_hash ~ '^[0-9a-f]{64}$'),
  lookup_key_id text not null check (lookup_key_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  encrypted_phone text not null check (length(encrypted_phone) between 8 and 4096),
  last4 text not null check (last4 ~ '^[0-9]{4}$'),
  verified_at timestamptz not null default now(),
  bound_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.sunland_phone_auth_state (
  user_id text primary key references public.user_profiles(user_id),
  version bigint not null default 0 check (version >= 0)
);
create table public.sunland_phone_auth_grants (
  proof_hash text primary key check (proof_hash ~ '^[0-9a-f]{64}$'),
  user_id text not null references public.user_profiles(user_id),
  session_hash text not null check (session_hash ~ '^[0-9a-f]{64}$'),
  version bigint not null check (version >= 0),
  purpose text not null check (purpose in ('bind','change','unbind','delete')),
  method text not null check (method in ('email','phone')),
  subject_fingerprint text not null check (subject_fingerprint ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_by uuid,
  check (expires_at > issued_at and expires_at <= issued_at + interval '5 minutes')
);
create index sunland_phone_auth_grants_user_idx on public.sunland_phone_auth_grants(user_id);
create table public.sunland_phone_auth_operations (
  operation_id uuid primary key,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  user_id text not null references public.user_profiles(user_id),
  action text not null check (action in ('login','bind','change','unbind','delete_authorize','release')),
  result jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.sunland_phone_identities enable row level security;
alter table public.sunland_phone_auth_state enable row level security;
alter table public.sunland_phone_auth_grants enable row level security;
alter table public.sunland_phone_auth_operations enable row level security;
alter table public.sunland_phone_auth_config enable row level security;
revoke all on table public.sunland_phone_identities, public.sunland_phone_auth_state,
  public.sunland_phone_auth_grants, public.sunland_phone_auth_operations,
  public.sunland_phone_auth_config from public, anon, authenticated;
grant select, insert, update, delete on table public.sunland_phone_identities,
  public.sunland_phone_auth_state, public.sunland_phone_auth_grants,
  public.sunland_phone_auth_operations to service_role;
-- Runtime cannot change lookup key/canary or bootstrap an empty configuration.
grant select on table public.sunland_phone_auth_config to service_role;

create function public.sunland_phone_identity(p_action text, p_data jsonb)
returns jsonb language plpgsql security invoker
set search_path = pg_catalog, public
as $$
declare
  v_profile public.user_profiles%rowtype;
  v_phone public.sunland_phone_identities%rowtype;
  v_grant public.sunland_phone_auth_grants%rowtype;
  v_operation public.sunland_phone_auth_operations%rowtype;
  v_user text;
  v_version bigint;
  v_result jsonb;
  v_subject text;
  v_subject_fingerprint text;
  v_operation_id uuid;
  v_job uuid;
  v_new boolean := false;
  v_cached_login boolean := false;
  v_onboarding jsonb;
  v_now timestamptz := clock_timestamp();
begin
  if p_data is null or jsonb_typeof(p_data) <> 'object'
    or p_action is null or p_action not in ('status','grant','proof','login','bind','change','unbind','delete_authorize') then
    return jsonb_build_object('code','INVALID_REQUEST');
  end if;
  -- ponytail: low-volume phone identity operations share one lock; profile locks
  -- remain authoritative against concurrent lifecycle changes outside this RPC.
  perform pg_advisory_xact_lock(20261024, 2);
  if not exists (
    select 1 from public.sunland_phone_auth_config
    where singleton and lookup_key_id = p_data->>'lookup_key_id'
      and lookup_check = p_data->>'lookup_check'
      and lookup_key_id is not null and lookup_check is not null
  ) then
    return jsonb_build_object('code','PHONE_KEY_MISMATCH');
  end if;

  if p_action in ('login','bind','change','unbind','delete_authorize') then
    if coalesce(p_data->>'operation_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or coalesce(p_data->>'request_hash','') !~ '^[0-9a-f]{64}$' then
      return jsonb_build_object('code','INVALID_REQUEST');
    end if;
    v_operation_id := (p_data->>'operation_id')::uuid;
    select * into v_operation from public.sunland_phone_auth_operations where operation_id=v_operation_id;
    if found then
      if v_operation.action is distinct from p_action
        or v_operation.request_hash is distinct from p_data->>'request_hash'
        or (p_action <> 'login' and v_operation.user_id is distinct from p_data->>'user_id') then
        return jsonb_build_object('code','OPERATION_CONFLICT');
      end if;
      -- A cached login must not resurrect an identity retired after the first call.
      select * into v_profile from public.user_profiles where user_id=v_operation.user_id for update;
      if not found or v_profile.identity_status <> 'active' then
        return jsonb_build_object('code','ACCOUNT_NOT_ACTIVE');
      end if;
      if p_action <> 'delete_authorize' and v_profile.is_banned then
        return jsonb_build_object('code','ACCOUNT_BANNED');
      end if;
      if p_action='login' and not exists (
        select 1 from public.sunland_phone_identities
        where user_id=v_operation.user_id and phone_hash=p_data->>'phone_hash'
          and lookup_key_id=p_data->>'lookup_key_id'
      ) then
        return jsonb_build_object('code','ACCOUNT_NOT_ACTIVE');
      end if;
      if p_action='login' then
        v_cached_login := true;
        v_user := v_operation.user_id;
        v_new := (v_operation.result->>'is_new_user')::boolean;
      else
        return v_operation.result;
      end if;
    end if;
  end if;

  if p_action in ('login','bind','change') then
    if coalesce(p_data->>'phone_hash','') !~ '^[0-9a-f]{64}$'
      or coalesce(p_data->>'last4','') !~ '^[0-9]{4}$'
      or length(coalesce(p_data->>'encrypted_phone','')) not between 8 and 4096 then
      return jsonb_build_object('code','INVALID_REQUEST');
    end if;
  end if;

  if p_action='login' then
    if coalesce(p_data->>'candidate_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      return jsonb_build_object('code','INVALID_REQUEST');
    end if;
    if not v_cached_login then
      -- Do not lock the mapping before its profile: deletion already owns profile.
      select user_id into v_user from public.sunland_phone_identities where phone_hash=p_data->>'phone_hash';
      if v_user is not null then
        select * into v_profile from public.user_profiles where user_id=v_user for update;
        if not found or v_profile.identity_status <> 'active' then
          return jsonb_build_object('code','ACCOUNT_NOT_ACTIVE');
        end if;
        if v_profile.is_banned then return jsonb_build_object('code','ACCOUNT_BANNED'); end if;
        select * into v_phone from public.sunland_phone_identities where user_id=v_user
          and phone_hash=p_data->>'phone_hash' for update;
        -- A lifecycle retirement may have released the mapping while we waited.
        if not found then return jsonb_build_object('code','ACCOUNT_NOT_ACTIVE'); end if;
        if v_phone.lookup_key_id <> p_data->>'lookup_key_id' then
          return jsonb_build_object('code','PHONE_KEY_MISMATCH');
        end if;
      else
        v_user := p_data->>'candidate_id';
        if exists(select 1 from public.user_profiles where user_id=v_user) then
          return jsonb_build_object('code','OPERATION_CONFLICT');
        end if;
        insert into public.user_profiles(user_id,email,onboarding_version,onboarding_step)
          values(v_user,null,0,1) returning * into v_profile;
        insert into public.sunland_phone_auth_state(user_id) values(v_user);
        insert into public.sunland_phone_identities(user_id,phone_hash,lookup_key_id,encrypted_phone,last4)
          values(v_user,p_data->>'phone_hash',p_data->>'lookup_key_id',p_data->>'encrypted_phone',p_data->>'last4');
        v_new := true;
      end if;
    end if;
    -- Match the existing Worker onboardingState, including historical NULL/NULL.
    if v_profile.onboarding_version is null and v_profile.onboarding_step is null then
      v_onboarding := jsonb_build_object('version',1,'step',3);
    elsif (v_profile.onboarding_version=0 and v_profile.onboarding_step between 1 and 3)
      or (v_profile.onboarding_version=1 and v_profile.onboarding_step=3) then
      v_onboarding := jsonb_build_object('version',v_profile.onboarding_version,'step',v_profile.onboarding_step);
    else
      raise exception 'INVALID_ONBOARDING_STATE' using errcode='22023';
    end if;
    v_result := jsonb_build_object('code','OK','user_id',v_user,'email',v_profile.email,
      'onboarding',v_onboarding,'is_new_user',v_new);
    if v_cached_login then return v_result; end if;
  else
    v_user := p_data->>'user_id';
    if coalesce(v_user,'') !~ '^[A-Za-z0-9][A-Za-z0-9@._+-]{0,127}$' then
      return jsonb_build_object('code','INVALID_REQUEST');
    end if;
    select * into v_profile from public.user_profiles where user_id=v_user for update;
    if not found or v_profile.identity_status <> 'active' then
      return jsonb_build_object('code','ACCOUNT_NOT_ACTIVE');
    end if;
    if v_profile.is_banned and p_action not in ('status','delete_authorize')
      and not (p_action in ('grant','proof') and p_data->>'purpose'='delete') then
      return jsonb_build_object('code','ACCOUNT_BANNED');
    end if;
    insert into public.sunland_phone_auth_state(user_id) values(v_user) on conflict(user_id) do nothing;
    select version into v_version from public.sunland_phone_auth_state where user_id=v_user for update;
    select * into v_phone from public.sunland_phone_identities where user_id=v_user for update;
    v_now := clock_timestamp();
    if p_action='status' then
      return jsonb_build_object('code','OK','user_id',v_user,'email',v_profile.email,'version',v_version,
        'phone',case when v_phone.user_id is null then null else jsonb_build_object(
          'phone_hash',v_phone.phone_hash,'lookup_key_id',v_phone.lookup_key_id,
          'encrypted_phone',v_phone.encrypted_phone,'last4',v_phone.last4) end);
    end if;

    if coalesce(p_data->>'session_hash','') !~ '^[0-9a-f]{64}$'
      or coalesce(p_data->>'proof_hash','') !~ '^[0-9a-f]{64}$' then
      return jsonb_build_object('code','INVALID_REQUEST');
    end if;
    if p_action='grant' then
      if coalesce(p_data->>'purpose','') not in ('bind','change','unbind','delete')
        or coalesce(p_data->>'method','') not in ('email','phone') then
        return jsonb_build_object('code','INVALID_REQUEST');
      end if;
      if p_data->>'purpose'='unbind' and (p_data->>'method'<>'email' or v_profile.email is null) then
        return jsonb_build_object('code','ALTERNATIVE_LOGIN_REQUIRED');
      end if;
      if p_data->>'method'='email' then
        v_subject := lower(btrim(p_data->>'subject'));
        if v_subject is null or v_subject='' or v_profile.email is null
          or v_subject <> lower(btrim(v_profile.email)) then
          return jsonb_build_object('code','REAUTH_INVALID');
        end if;
      else
        v_subject := p_data->>'subject';
        if v_phone.user_id is null or v_subject is null or v_subject <> v_phone.phone_hash then
          return jsonb_build_object('code','REAUTH_INVALID');
        end if;
      end if;
      v_subject_fingerprint := encode(sha256(convert_to(v_subject,'UTF8')),'hex');
      if exists(select 1 from public.sunland_phone_auth_grants where proof_hash=p_data->>'proof_hash') then
        return jsonb_build_object('code','REAUTH_INVALID');
      end if;
      insert into public.sunland_phone_auth_grants(proof_hash,user_id,session_hash,version,purpose,method,
        subject_fingerprint,issued_at,expires_at) values(p_data->>'proof_hash',v_user,p_data->>'session_hash',v_version,
        p_data->>'purpose',p_data->>'method',v_subject_fingerprint,v_now,v_now+interval '5 minutes');
      return jsonb_build_object('code','OK','issued_at',floor(extract(epoch from v_now)*1000)::bigint,
        'expires_in',300,'version',v_version);
    end if;

    select * into v_grant from public.sunland_phone_auth_grants where proof_hash=p_data->>'proof_hash' for update;
    -- Time must be captured after lock waits, never at request/transaction start.
    v_now := clock_timestamp();
    if v_grant.proof_hash is null or v_grant.user_id <> v_user
      or v_grant.session_hash <> p_data->>'session_hash' or v_grant.version <> v_version
      or v_grant.consumed_by is not null or v_grant.expires_at <= v_now
      or v_grant.issued_at > v_now then
      return jsonb_build_object('code','REAUTH_INVALID');
    end if;
    if v_grant.purpose is distinct from (case when p_action='proof' then p_data->>'purpose'
      when p_action='delete_authorize' then 'delete' else p_action end) then
      return jsonb_build_object('code','REAUTH_INVALID');
    end if;
    v_subject := case when v_grant.method='email' then lower(btrim(v_profile.email)) else v_phone.phone_hash end;
    if v_subject is null or v_grant.subject_fingerprint <> encode(sha256(convert_to(v_subject,'UTF8')),'hex') then
      return jsonb_build_object('code','REAUTH_INVALID');
    end if;
    if p_action='proof' then
      return jsonb_build_object('code','OK','issued_at',floor(extract(epoch from v_grant.issued_at)*1000)::bigint,
        'version',v_version,'method',v_grant.method);
    end if;

    if p_action='delete_authorize' then
      if coalesce(p_data->>'token_hash','') !~ '^[0-9a-f]{64}$' then
        return jsonb_build_object('code','INVALID_REQUEST');
      end if;
      if exists(select 1 from public.account_deletion_jobs where user_id=v_user and
        ((status='pending' and expires_at>v_now) or status='in_progress')) then
        return jsonb_build_object('code','DELETION_CONFLICT');
      end if;
      insert into public.account_deletion_jobs(user_id,token_hash,expires_at)
        values(v_user,p_data->>'token_hash',v_now+interval '10 minutes') returning id into v_job;
      v_result := jsonb_build_object('code','OK','user_id',v_user,'deletion_job_id',v_job,'expires_in',600);
    else
      if p_action='bind' and v_phone.user_id is not null then
        return jsonb_build_object('code','PHONE_ALREADY_BOUND');
      end if;
      if p_action in ('change','unbind') and v_phone.user_id is null then
        return jsonb_build_object('code','PHONE_NOT_BOUND');
      end if;
      if p_action in ('bind','change') then
        if exists(select 1 from public.sunland_phone_identities where phone_hash=p_data->>'phone_hash'
          and user_id<>v_user) then
          return jsonb_build_object('code','PHONE_CONFLICT');
        end if;
        if p_action='change' and v_phone.phone_hash=p_data->>'phone_hash' then
          return jsonb_build_object('code','PHONE_ALREADY_BOUND');
        end if;
        insert into public.sunland_phone_identities(user_id,phone_hash,lookup_key_id,encrypted_phone,last4)
          values(v_user,p_data->>'phone_hash',p_data->>'lookup_key_id',p_data->>'encrypted_phone',p_data->>'last4')
          on conflict(user_id) do update set phone_hash=excluded.phone_hash,lookup_key_id=excluded.lookup_key_id,
            encrypted_phone=excluded.encrypted_phone,last4=excluded.last4,verified_at=v_now,updated_at=v_now;
      else
        if v_grant.method <> 'email' or v_profile.email is null then
          return jsonb_build_object('code','ALTERNATIVE_LOGIN_REQUIRED');
        end if;
        delete from public.sunland_phone_identities where user_id=v_user;
      end if;
      update public.sunland_phone_auth_state set version=version+1 where user_id=v_user returning version into v_version;
      v_result := jsonb_build_object('code','OK','user_id',v_user,'version',v_version);
    end if;
    update public.sunland_phone_auth_grants set consumed_by=v_operation_id where proof_hash=v_grant.proof_hash;
  end if;

  insert into public.sunland_phone_auth_operations(operation_id,request_hash,user_id,action,result)
    values(v_operation_id,p_data->>'request_hash',v_user,p_action,
      case when p_action='login' then v_result-'email'-'onboarding' else v_result end);
  return v_result;
end;
$$;
revoke all on function public.sunland_phone_identity(text, jsonb) from public, anon, authenticated;
grant execute on function public.sunland_phone_identity(text, jsonb) to service_role;

create function public.sunland_phone_identity_lifecycle()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, public
as $$
declare
  v_job public.account_deletion_jobs%rowtype;
begin
  if new.identity_status is not distinct from old.identity_status then return new; end if;
  if new.identity_status in ('deleting','retired') then
    -- Existing account deletion holds profile first. Never acquire the phone RPC
    -- advisory lock from this trigger: that would invert the lock hierarchy.
    if exists(select 1 from public.sunland_phone_auth_state where user_id=new.user_id) then
      update public.sunland_phone_auth_state set version=version+1 where user_id=new.user_id;
      delete from public.sunland_phone_auth_grants where user_id=new.user_id;
    end if;
  end if;
  if new.identity_status='retired' then
    -- Wipe historical result snapshots even when the phone was already unbound.
    -- A remaining phone gets only the minimal release audit after validation.
    delete from public.sunland_phone_auth_operations where user_id=new.user_id;
  end if;
  if new.identity_status='retired' and exists(
    select 1 from public.sunland_phone_identities where user_id=new.user_id
  ) then
    select * into v_job from public.account_deletion_jobs where id=new.deletion_job_id for share;
    if old.identity_status <> 'deleting' or v_job.id is null or v_job.user_id <> new.user_id
      or v_job.status <> 'in_progress' or v_job.attempt_id is distinct from new.deletion_attempt_id
      or v_job.fencing_version is distinct from new.deletion_fencing_version
      or v_job.lease_expires_at is null or v_job.lease_expires_at <= clock_timestamp()
      or v_job.recovery_expires_at is null or v_job.recovery_expires_at <= clock_timestamp()
      or v_job.data_deleted_at is null then
      raise exception 'DELETION_CONFLICT' using errcode='55000';
    end if;
    delete from public.sunland_phone_identities where user_id=new.user_id;
    insert into public.sunland_phone_auth_operations(operation_id,request_hash,user_id,action,result)
      values(gen_random_uuid(),encode(sha256(convert_to(new.deletion_job_id::text||':'||new.deletion_fencing_version::text,'UTF8')),'hex'),
        new.user_id,'release',jsonb_build_object('code','OK','released',true));
  end if;
  return new;
end;
$$;
revoke all on function public.sunland_phone_identity_lifecycle() from public, anon, authenticated;
grant execute on function public.sunland_phone_identity_lifecycle() to service_role;
create trigger sunland_phone_identity_lifecycle
  after update of identity_status on public.user_profiles
  for each row execute function public.sunland_phone_identity_lifecycle();

commit;
