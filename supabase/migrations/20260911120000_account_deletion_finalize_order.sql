begin;

alter table public.account_deletion_jobs
  add column if not exists identity_retired_at timestamptz,
  add column if not exists profile_sanitized_at timestamptz;

create or replace function public.sunland_delete_account_business_data(
  p_user_id text
)
returns table(status text)
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
begin
  if p_user_id is null or p_user_id !~ '^[A-Za-z0-9][A-Za-z0-9@._+-]{0,127}$' then
    raise exception 'invalid user id' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('sunland-delete-account:' || p_user_id));

  delete from public.sunland_ai_turn_results where user_id = p_user_id;
  delete from public.sunland_ai_migration_receipts where user_id = p_user_id;
  delete from public.sunland_ai_context where user_id = p_user_id;
  delete from public.sunland_ai_knowledge where user_id = p_user_id;
  delete from public.sunland_ai_memory where user_id = p_user_id;
  delete from public.sunland_ai_user_state where user_id = p_user_id;
  delete from public.pro_activations where user_id = p_user_id;
  delete from public.comment_copilot_context where user_id = p_user_id;
  delete from public.comment_copilot_usage where user_id = p_user_id;
  delete from public.conversations where user_id = p_user_id;
  delete from public.deleted_conversations where user_id = p_user_id;
  delete from public.usage where user_id = p_user_id;
  delete from public.usage_logs where user_id::text = p_user_id;
  delete from public.request_logs where user_id::text = p_user_id;
  delete from public.pro_payment_intents where user_id = p_user_id;

  update public.pro_payment_orders
     set bound_user_id = null
   where bound_user_id = p_user_id;

  return query select 'deleted'::text;
end;
$$;

create or replace function public.sunland_delete_account_data(
  p_user_id text
)
returns table(status text)
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
begin
  return query select * from public.sunland_delete_account_business_data(p_user_id);
end;
$$;

revoke all on function public.sunland_delete_account_business_data(text)
  from public, anon, authenticated;
grant execute on function public.sunland_delete_account_business_data(text) to service_role;

revoke all on function public.sunland_delete_account_data(text)
  from public, anon, authenticated;
grant execute on function public.sunland_delete_account_data(text) to service_role;

commit;
