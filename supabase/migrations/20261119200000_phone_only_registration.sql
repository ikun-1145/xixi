-- Review and apply only under a separately authorized production deployment.
-- Phone-only registration: a verified phone creates an account without email.
-- The email trigger stays in force for every other insert path; only this RPC
-- can lift it, for exactly the candidate account it is creating.
begin;

do $$
begin
  if to_regprocedure('public.sunland_phone_identity(text,jsonb)') is null
    or to_regprocedure('public.sunland_phone_require_email()') is null then
    raise exception 'PHONE_ONLY_PREREQUISITES_MISSING';
  end if;
end $$;

create or replace function public.sunland_phone_require_email()
returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $$
begin
  -- Transaction-local marker set by sunland_phone_register_phone_only only.
  if coalesce(current_setting('sunland.phone_only_candidate', true), '') = new.user_id then
    return new;
  end if;
  if not exists(select 1 from public.user_profiles where user_id=new.user_id
    and email is not null and length(btrim(email)) > 0) then
    raise exception 'PHONE_IDENTITY_REQUIRES_EMAIL' using errcode='23514';
  end if;
  return new;
end $$;
revoke all on function public.sunland_phone_require_email() from public, anon, authenticated;

-- Existing phone: logs in. Unknown phone: creates an email-less account with a
-- fresh random user_id. Never links to any email account. Idempotent by
-- operation_id through sunland_phone_identity's operation cache.
create or replace function public.sunland_phone_register_phone_only(p_data jsonb)
returns jsonb language plpgsql security invoker set search_path = pg_catalog, public as $$
declare v_result jsonb;
begin
  if p_data is null or jsonb_typeof(p_data) <> 'object'
    or coalesce(p_data->>'candidate_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_data ? 'email' or p_data ? 'allow_create' then
    return jsonb_build_object('code','INVALID_REQUEST');
  end if;
  perform set_config('sunland.phone_only_candidate', p_data->>'candidate_id', true);
  v_result := public.sunland_phone_identity('login', p_data || jsonb_build_object('allow_create', true));
  perform set_config('sunland.phone_only_candidate', '', true);
  return v_result;
end $$;
revoke all on function public.sunland_phone_register_phone_only(jsonb) from public, anon, authenticated;
grant execute on function public.sunland_phone_register_phone_only(jsonb) to service_role;
notify pgrst, 'reload schema';
commit;
