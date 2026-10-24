-- Isolated synthetic baseline reconstructed from reviewed Phase 2 catalog metadata.
-- Not a full production schema dump. No real user rows, tokens, or credentials.
-- Phase 2 evidence omits pg_policies.permissive: active_* policy mode is NOT guessed here.
-- Only own-id SELECT/UPDATE and audited column grants are reconstructed; active helper is tested directly.
create schema extensions;
create extension pgcrypto with schema extensions;
create schema auth;
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
grant usage on schema public,auth,extensions to anon,authenticated,service_role;
grant execute on function auth.jwt() to anon,authenticated,service_role;
create table public.user_profiles (
  user_id text not null,
  avatar_url text,
  avatar_path text,
  updated_at timestamp with time zone default now(),
  name text,
  pro boolean default false not null,
  email text,
  created_at timestamp with time zone default now(),
  is_banned boolean default false not null,
  ban_reason text,
  identity_status text default 'active'::text not null,
  deletion_job_id uuid,
  deletion_attempt_id text,
  deletion_fencing_version bigint default 0 not null,
  deletion_started_at timestamp with time zone,
  retired_at timestamp with time zone,
  profile_sanitized_at timestamp with time zone,
  onboarding_version smallint default 0 not null,
  onboarding_step smallint default 1 not null,
  constraint user_profiles_identity_status_check CHECK ((identity_status = ANY (ARRAY['active'::text, 'deleting'::text, 'retired'::text]))),
  constraint user_profiles_onboarding_state_check CHECK ((((onboarding_version = 0) AND ((onboarding_step >= 1) AND (onboarding_step <= 3))) OR ((onboarding_version = 1) AND (onboarding_step = 3)))),
  constraint user_profiles_pkey PRIMARY KEY (user_id)
);
CREATE UNIQUE INDEX user_profiles_email_unique_idx ON public.user_profiles USING btree (lower(email)) WHERE ((email IS NOT NULL) AND (identity_status IS DISTINCT FROM 'retired'::text));
grant select,insert,update,delete on public.user_profiles to service_role;
alter table public.user_profiles enable row level security;
grant select on public.user_profiles to authenticated;
grant update(avatar_url,avatar_path,updated_at,name) on public.user_profiles to authenticated;
CREATE OR REPLACE FUNCTION public.sunland_account_delete_begin(p_user_id text, p_deletion_job_id uuid, p_attempt_id text, p_fencing_version bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'extensions'
AS $function$
declare
  v_status text;
  v_job uuid;
  v_attempt text;
  v_version bigint;
begin
  if p_user_id is null
    or p_user_id !~ '^[A-Za-z0-9][A-Za-z0-9@._+-]{0,127}$'
    or p_deletion_job_id is null
    or p_attempt_id is null
    or p_attempt_id !~ '^[A-Za-z0-9_-]{16,128}$'
    or p_fencing_version is null
    or p_fencing_version < 1 then
    return jsonb_build_object('code', 'invalid_request');
  end if;

  select identity_status, deletion_job_id, deletion_attempt_id, deletion_fencing_version
    into v_status, v_job, v_attempt, v_version
  from public.user_profiles
  where user_id = p_user_id
  for update;

  if not found then
    return jsonb_build_object(
      'code', 'user_not_found',
      'deletion_job_id', p_deletion_job_id::text,
      'user_id', p_user_id
    );
  end if;

  if v_status = 'retired' then
    return jsonb_build_object(
      'code', 'retired',
      'deletion_job_id', p_deletion_job_id::text,
      'user_id', p_user_id,
      'attempt_id', v_attempt,
      'fencing_version', v_version
    );
  end if;

  if v_status = 'deleting' then
    if v_job is distinct from p_deletion_job_id then
      return jsonb_build_object(
        'code', 'deletion_conflict',
        'deletion_job_id', p_deletion_job_id::text,
        'user_id', p_user_id,
        'attempt_id', v_attempt,
        'fencing_version', v_version
      );
    end if;

    if p_fencing_version < v_version then
      return jsonb_build_object(
        'code', 'stale_attempt',
        'deletion_job_id', p_deletion_job_id::text,
        'user_id', p_user_id,
        'attempt_id', v_attempt,
        'fencing_version', v_version
      );
    end if;

    if p_fencing_version = v_version then
      if p_attempt_id is distinct from v_attempt then
        return jsonb_build_object(
          'code', 'fencing_conflict',
          'deletion_job_id', p_deletion_job_id::text,
          'user_id', p_user_id,
          'attempt_id', v_attempt,
          'fencing_version', v_version
        );
      end if;

      return jsonb_build_object(
        'code', 'already_revoked',
        'deletion_job_id', p_deletion_job_id::text,
        'user_id', p_user_id,
        'attempt_id', v_attempt,
        'fencing_version', v_version
      );
    end if;

    update public.user_profiles
       set deletion_attempt_id = p_attempt_id,
           deletion_fencing_version = p_fencing_version,
           deletion_started_at = now()
     where user_id = p_user_id;

    return jsonb_build_object(
      'code', 'ownership_transferred',
      'deletion_job_id', p_deletion_job_id::text,
      'user_id', p_user_id,
      'attempt_id', p_attempt_id,
      'fencing_version', p_fencing_version
    );
  end if;

  if v_status = 'active' then
    update public.user_profiles
       set identity_status = 'deleting',
           deletion_job_id = p_deletion_job_id,
           deletion_attempt_id = p_attempt_id,
           deletion_fencing_version = p_fencing_version,
           deletion_started_at = now()
     where user_id = p_user_id;

    return jsonb_build_object(
      'code', 'revoked',
      'deletion_job_id', p_deletion_job_id::text,
      'user_id', p_user_id,
      'attempt_id', p_attempt_id,
      'fencing_version', p_fencing_version
    );
  end if;

  return jsonb_build_object(
    'code', 'invalid_state',
    'deletion_job_id', p_deletion_job_id::text,
    'user_id', p_user_id,
    'attempt_id', v_attempt,
    'fencing_version', v_version
  );
end;
$function$
;
revoke all on function public.sunland_account_delete_begin(text,uuid,text,bigint) from public,anon,authenticated;
grant execute on function public.sunland_account_delete_begin(text,uuid,text,bigint) to service_role;
CREATE OR REPLACE FUNCTION public.sunland_account_delete_finalize(p_user_id text, p_deletion_job_id uuid, p_attempt_id text, p_fencing_version bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'extensions'
AS $function$
declare
  v_status text;
  v_job uuid;
  v_attempt text;
  v_version bigint;
begin
  if p_user_id is null
    or p_user_id !~ '^[A-Za-z0-9][A-Za-z0-9@._+-]{0,127}$'
    or p_deletion_job_id is null
    or p_attempt_id is null
    or p_attempt_id !~ '^[A-Za-z0-9_-]{16,128}$'
    or p_fencing_version is null
    or p_fencing_version < 1 then
    return jsonb_build_object('code', 'invalid_request');
  end if;

  select identity_status, deletion_job_id, deletion_attempt_id, deletion_fencing_version
    into v_status, v_job, v_attempt, v_version
  from public.user_profiles
  where user_id = p_user_id
  for update;

  if not found then
    return jsonb_build_object(
      'code', 'user_not_found',
      'deletion_job_id', p_deletion_job_id::text,
      'user_id', p_user_id,
      'attempt_id', v_attempt,
      'fencing_version', v_version
    );
  end if;

  if v_status = 'retired' then
    if v_job = p_deletion_job_id
      and v_attempt = p_attempt_id
      and v_version = p_fencing_version then
      return jsonb_build_object(
        'code', 'already_retired',
        'deletion_job_id', p_deletion_job_id::text,
        'user_id', p_user_id,
        'attempt_id', v_attempt,
        'fencing_version', v_version
      );
    end if;

    return jsonb_build_object(
      'code', 'stale_attempt',
      'deletion_job_id', p_deletion_job_id::text,
      'user_id', p_user_id,
      'attempt_id', v_attempt,
      'fencing_version', v_version
    );
  end if;

  if v_status = 'active' then
    return jsonb_build_object(
      'code', 'not_deleting',
      'deletion_job_id', p_deletion_job_id::text,
      'user_id', p_user_id,
      'attempt_id', v_attempt,
      'fencing_version', v_version
    );
  end if;

  if v_status = 'deleting' then
    if v_job is distinct from p_deletion_job_id then
      return jsonb_build_object(
        'code', 'deletion_conflict',
        'deletion_job_id', p_deletion_job_id::text,
        'user_id', p_user_id,
        'attempt_id', v_attempt,
        'fencing_version', v_version
      );
    end if;

    if p_fencing_version is distinct from v_version then
      return jsonb_build_object(
        'code', 'stale_attempt',
        'deletion_job_id', p_deletion_job_id::text,
        'user_id', p_user_id,
        'attempt_id', v_attempt,
        'fencing_version', v_version
      );
    end if;

    if p_attempt_id is distinct from v_attempt then
      return jsonb_build_object(
        'code', 'fencing_conflict',
        'deletion_job_id', p_deletion_job_id::text,
        'user_id', p_user_id,
        'attempt_id', v_attempt,
        'fencing_version', v_version
      );
    end if;

    update public.user_profiles
       set identity_status = 'retired',
           retired_at = now()
     where user_id = p_user_id;

    return jsonb_build_object(
      'code', 'retired',
      'deletion_job_id', p_deletion_job_id::text,
      'user_id', p_user_id,
      'attempt_id', v_attempt,
      'fencing_version', v_version
    );
  end if;

  return jsonb_build_object(
    'code', 'invalid_state',
    'deletion_job_id', p_deletion_job_id::text,
    'user_id', p_user_id,
    'attempt_id', v_attempt,
    'fencing_version', v_version
  );
end;
$function$
;
revoke all on function public.sunland_account_delete_finalize(text,uuid,text,bigint) from public,anon,authenticated;
grant execute on function public.sunland_account_delete_finalize(text,uuid,text,bigint) to service_role;
CREATE OR REPLACE FUNCTION public.sunland_account_delete_sanitize_profile(p_user_id text, p_deletion_job_id uuid, p_attempt_id text, p_fencing_version bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'extensions'
AS $function$
declare
  v_status text;
  v_job uuid;
  v_attempt text;
  v_version bigint;
  v_sanitized_at timestamptz;
begin
  if p_user_id is null
    or p_user_id !~ '^[A-Za-z0-9][A-Za-z0-9@._+-]{0,127}$'
    or p_deletion_job_id is null
    or p_attempt_id is null
    or p_attempt_id !~ '^[A-Za-z0-9_-]{16,128}$'
    or p_fencing_version is null
    or p_fencing_version < 1 then
    return jsonb_build_object('code', 'invalid_request');
  end if;

  select identity_status, deletion_job_id, deletion_attempt_id, deletion_fencing_version, profile_sanitized_at
    into v_status, v_job, v_attempt, v_version, v_sanitized_at
  from public.user_profiles
  where user_id = p_user_id
  for update;

  if not found then
    return jsonb_build_object(
      'code', 'user_not_found',
      'deletion_job_id', p_deletion_job_id::text,
      'user_id', p_user_id,
      'attempt_id', p_attempt_id,
      'fencing_version', p_fencing_version
    );
  end if;

  if v_status is distinct from 'retired' then
    return jsonb_build_object(
      'code', 'not_retired',
      'deletion_job_id', p_deletion_job_id::text,
      'user_id', p_user_id,
      'attempt_id', v_attempt,
      'fencing_version', v_version
    );
  end if;

  if v_job is distinct from p_deletion_job_id
    or v_version is distinct from p_fencing_version then
    return jsonb_build_object(
      'code', 'stale_attempt',
      'deletion_job_id', p_deletion_job_id::text,
      'user_id', p_user_id,
      'attempt_id', v_attempt,
      'fencing_version', v_version
    );
  end if;

  if v_attempt is distinct from p_attempt_id then
    return jsonb_build_object(
      'code', 'fencing_conflict',
      'deletion_job_id', p_deletion_job_id::text,
      'user_id', p_user_id,
      'attempt_id', v_attempt,
      'fencing_version', v_version
    );
  end if;

  if v_sanitized_at is not null then
    return jsonb_build_object(
      'code', 'already_sanitized',
      'deletion_job_id', p_deletion_job_id::text,
      'user_id', p_user_id,
      'attempt_id', v_attempt,
      'fencing_version', v_version
    );
  end if;

  update public.user_profiles
     set email = null,
         avatar_url = null,
         avatar_path = null,
         name = null,
         pro = false,
         is_banned = false,
         ban_reason = null,
         updated_at = now(),
         profile_sanitized_at = now()
   where user_id = p_user_id;

  return jsonb_build_object(
    'code', 'sanitized',
    'deletion_job_id', p_deletion_job_id::text,
    'user_id', p_user_id,
    'attempt_id', p_attempt_id,
    'fencing_version', p_fencing_version
  );
end;
$function$
;
revoke all on function public.sunland_account_delete_sanitize_profile(text,uuid,text,bigint) from public,anon,authenticated;
grant execute on function public.sunland_account_delete_sanitize_profile(text,uuid,text,bigint) to service_role;
CREATE OR REPLACE FUNCTION public.sunland_authenticated_identity_is_active(p_user_id text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_claimed_user_id text;
  v_identity_status text;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'authenticated' then
    return false;
  end if;
  v_claimed_user_id := nullif((select auth.jwt() ->> 'id'), '');
  if v_claimed_user_id is distinct from p_user_id then
    return false;
  end if;

  select identity_status into v_identity_status
    from public.user_profiles
   where user_id = p_user_id
   for no key update;
  return found and v_identity_status = 'active';
end;
$function$
;
revoke all on function public.sunland_authenticated_identity_is_active(text) from public,anon,authenticated;
grant execute on function public.sunland_authenticated_identity_is_active(text) to service_role;
grant execute on function public.sunland_authenticated_identity_is_active(text) to authenticated;
create policy user_profiles_select_own on public.user_profiles as permissive for SELECT to authenticated using ((( SELECT (auth.jwt() ->> 'id'::text)) = user_id));
create policy user_profiles_update_own on public.user_profiles as permissive for UPDATE to authenticated using ((( SELECT (auth.jwt() ->> 'id'::text)) = user_id)) with check ((( SELECT (auth.jwt() ->> 'id'::text)) = user_id));
