-- Review and apply only under a separately authorized production deployment.
begin;

-- Email-login creates profiles outside the phone lock; its unique index must
-- arbitrate races with this transaction. Refuse migration on schema drift.
do $$
begin
  if to_regprocedure('public.sunland_phone_identity(text,jsonb)') is null or not exists (
    select 1 from pg_catalog.pg_index i
    where i.indexrelid = to_regclass('public.user_profiles_email_unique_idx')
      and i.indrelid = 'public.user_profiles'::regclass and i.indisunique and i.indisvalid and i.indisready
      and i.indnkeyatts = 1 and pg_get_indexdef(i.indexrelid,1,true) = 'lower(email)'
      and regexp_replace(pg_get_expr(i.indpred,i.indrelid), '[[:space:]()]', '', 'g') =
        'emailISNOTNULLANDidentity_statusISDISTINCTFROM''retired''::text'
  ) then raise exception 'PHONE_REGISTER_PREREQUISITES_MISSING'; end if;
end $$;

-- Prevent older workers from creating phone-only identities during rollout.
-- Existing rows are not touched; ordinary email-backed phone bindings remain.
create or replace function public.sunland_phone_require_email()
returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $$
begin
  if not exists(select 1 from public.user_profiles where user_id=new.user_id
    and email is not null and length(btrim(email)) > 0) then
    raise exception 'PHONE_IDENTITY_REQUIRES_EMAIL' using errcode='23514';
  end if;
  return new;
end $$;
revoke all on function public.sunland_phone_require_email() from public, anon, authenticated;
drop trigger if exists sunland_phone_require_email on public.sunland_phone_identities;
create trigger sunland_phone_require_email before insert on public.sunland_phone_identities
  for each row execute function public.sunland_phone_require_email();

-- A new RPC, so an older deployed identity function cannot silently ignore
-- the verified email and create a phone-only account during staged rollout.
create or replace function public.sunland_phone_register(p_data jsonb)
returns jsonb language plpgsql security invoker
set search_path = pg_catalog, public
as $$
declare
  v_user text;
  v_email text;
  v_result jsonb;
begin
  if p_data is null or jsonb_typeof(p_data) <> 'object'
    or coalesce(p_data->>'candidate_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or coalesce(p_data->>'operation_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or coalesce(p_data->>'request_hash','') !~ '^[0-9a-f]{64}$'
    or coalesce(p_data->>'phone_hash','') !~ '^[0-9a-f]{64}$'
    or coalesce(p_data->>'last4','') !~ '^[0-9]{4}$'
    or length(coalesce(p_data->>'encrypted_phone','')) not between 8 and 4096
    or length(coalesce(p_data->>'email','')) > 254
    or coalesce(p_data->>'email','') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or p_data->>'email' <> lower(btrim(p_data->>'email')) then
    return jsonb_build_object('code','INVALID_REQUEST');
  end if;
  -- Same lock as the existing phone identity RPC, including bind and deletion.
  perform pg_advisory_xact_lock(20261024, 2);
  if not exists(select 1 from public.sunland_phone_auth_config where singleton
    and lookup_key_id = p_data->>'lookup_key_id' and lookup_check = p_data->>'lookup_check'
    and lookup_key_id is not null and lookup_check is not null) then
    return jsonb_build_object('code','PHONE_KEY_MISMATCH');
  end if;
  v_user := p_data->>'candidate_id';
  v_email := p_data->>'email';
  if exists(select 1 from public.sunland_phone_auth_operations where operation_id=(p_data->>'operation_id')::uuid) then
    return jsonb_build_object('code','OPERATION_CONFLICT');
  end if;
  if exists(select 1 from public.sunland_phone_identities where phone_hash=p_data->>'phone_hash') then
    return jsonb_build_object('code','PHONE_CONFLICT');
  end if;
  if exists(select 1 from public.user_profiles where lower(email)=v_email and identity_status is distinct from 'retired') then
    return jsonb_build_object('code','EMAIL_CONFLICT');
  end if;
  begin
    insert into public.user_profiles(user_id,email,onboarding_version,onboarding_step) values(v_user,v_email,0,1);
    insert into public.sunland_phone_auth_state(user_id) values(v_user);
    insert into public.sunland_phone_identities(user_id,phone_hash,lookup_key_id,encrypted_phone,last4)
      values(v_user,p_data->>'phone_hash',p_data->>'lookup_key_id',p_data->>'encrypted_phone',p_data->>'last4');
    v_result := jsonb_build_object('code','OK','user_id',v_user,'email',v_email,
      'onboarding',jsonb_build_object('version',0,'step',1),'is_new_user',true);
    insert into public.sunland_phone_auth_operations(operation_id,request_hash,user_id,action,result)
      values((p_data->>'operation_id')::uuid,p_data->>'request_hash',v_user,'login',v_result-'email'-'onboarding');
  exception when unique_violation then
    -- The existing case-insensitive active-email unique index arbitrates races
    -- with email-login account creation outside the phone advisory lock.
    if exists(select 1 from public.user_profiles where lower(email)=v_email and identity_status is distinct from 'retired') then
      return jsonb_build_object('code','EMAIL_CONFLICT');
    end if;
    if exists(select 1 from public.sunland_phone_identities where phone_hash=p_data->>'phone_hash') then
      return jsonb_build_object('code','PHONE_CONFLICT');
    end if;
    return jsonb_build_object('code','OPERATION_CONFLICT');
  end;
  return v_result;
end;
$$;
revoke all on function public.sunland_phone_register(jsonb) from public, anon, authenticated;
grant execute on function public.sunland_phone_register(jsonb) to service_role;
notify pgrst, 'reload schema';
commit;
