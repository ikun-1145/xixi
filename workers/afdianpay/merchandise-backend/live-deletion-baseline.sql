CREATE OR REPLACE FUNCTION public.sunland_delete_account_business_data(p_user_id text)
 RETURNS TABLE(status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'extensions'
AS $function$
begin
  if p_user_id is null or p_user_id !~ '^[A-Za-z0-9][A-Za-z0-9@._+-]{0,127}$' then
    raise exception 'invalid user id' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('sunland-delete-account:' || p_user_id));
  -- This snapshots private Storage paths and consumes any in-flight quota.
  -- Rows can be removed only after the cleanup job is durably inserted.
  perform public.chat_prepare_account_delete(p_user_id);
  delete from public.chat_message_images where user_id = p_user_id;
  delete from public.chat_turns where user_id = p_user_id;
  delete from public.chat_messages where user_id = p_user_id;
  delete from public.chat_usage_entries where user_id = p_user_id;
  delete from public.chat_daily_usage where user_id = p_user_id;
  delete from public.chat_threads where user_id = p_user_id;

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

  update public.pro_payment_orders set bound_user_id = null
    where bound_user_id = p_user_id;
  return query select 'deleted'::text;
end;
$function$;

