-- Apply only after isolated verification and separate production authorization.
begin;
create or replace function public.sunland_phone_register_unified(
  p_data jsonb, p_subject text, p_ip text, p_request_id uuid, p_code_hash text
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_cached public.sunland_phone_auth_operations%rowtype; v_profile public.user_profiles%rowtype;
  v_otp jsonb; v_result jsonb; v_onboarding jsonb;
begin
  if p_data is null or jsonb_typeof(p_data) <> 'object' or
     coalesce(p_data->>'operation_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' or
     coalesce(p_data->>'request_hash','') !~ '^[0-9a-f]{64}$' or
     coalesce(p_data->>'phone_hash','') !~ '^[0-9a-f]{64}$' or
     length(coalesce(p_data->>'email','')) > 254 or
     coalesce(p_data->>'email','') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or
     p_data->>'email' <> lower(btrim(p_data->>'email')) or
     p_subject is null or p_subject !~ '^[0-9a-f]{64}$' or
     p_ip is null or p_ip !~ '^[0-9a-f]{64}$' or p_request_id is null or
     p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('code','INVALID_REQUEST');
  end if;
  -- Serialize cached-result detection and registration with the existing RPC.
  perform pg_advisory_xact_lock(20261024, 2);
  if not exists(select 1 from public.sunland_phone_auth_config where singleton and
    lookup_key_id = p_data->>'lookup_key_id' and lookup_check = p_data->>'lookup_check') then
    return jsonb_build_object('code','PHONE_KEY_MISMATCH');
  end if;
  select * into v_cached from public.sunland_phone_auth_operations
    where operation_id = (p_data->>'operation_id')::uuid;
  if found then
    if v_cached.request_hash <> p_data->>'request_hash' or v_cached.action <> 'login' or
       not exists(select 1 from public.sunland_phone_identities
         where user_id=v_cached.user_id and phone_hash=p_data->>'phone_hash') then
      return jsonb_build_object('code','OPERATION_CONFLICT');
    end if;
    select * into v_profile from public.user_profiles where user_id=v_cached.user_id;
    if not found or v_profile.identity_status is distinct from 'active' or v_profile.is_banned or
       lower(v_profile.email) is distinct from p_data->>'email' then return jsonb_build_object('code','ACCOUNT_NOT_ACTIVE'); end if;
    if v_profile.onboarding_version is null and v_profile.onboarding_step is null then
      v_onboarding := jsonb_build_object('version',1,'step',3);
    elsif (v_profile.onboarding_version=0 and v_profile.onboarding_step between 1 and 3)
       or (v_profile.onboarding_version=1 and v_profile.onboarding_step=3) then
      v_onboarding := jsonb_build_object('version',v_profile.onboarding_version,'step',v_profile.onboarding_step);
    else raise exception 'INVALID_ONBOARDING_STATE' using errcode='22023'; end if;
    return jsonb_build_object('code','OK','user_id',v_cached.user_id,'email',v_profile.email,
      'onboarding',v_onboarding,'is_new_user',true);
  end if;
  v_otp := public.sunland_otp('consume',p_subject,p_ip,p_request_id,p_code_hash,null);
  if v_otp->>'code' <> 'OK' then return v_otp; end if;
  -- Same database transaction: unexpected failure rolls back OTP consumption.
  v_result := public.sunland_phone_register(p_data);
  return v_result;
end $$;
revoke all on function public.sunland_phone_register_unified(jsonb,text,text,uuid,text) from public, anon, authenticated;
grant execute on function public.sunland_phone_register_unified(jsonb,text,text,uuid,text) to service_role;
notify pgrst, 'reload schema';
commit;
