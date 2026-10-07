-- DRAFT ONLY. Stop the new Afdian Worker/entry first. Do not delete evidence or rights.
-- Application rollback must not return to any snapshot with unsafe grant fallbacks.
begin;
revoke execute on function public.sunland_process_verified_pro_order(jsonb,text,uuid,boolean) from service_role;
revoke execute on function public.sunland_record_pro_payment_hints(text[],text,uuid) from service_role;
revoke execute on function public.sunland_claim_pro_payment_order_query(text) from service_role;
revoke execute on function public.sunland_note_pro_payment_retry(text,text,text,uuid) from service_role;
revoke execute on function public.sunland_get_pro_payment_backoff() from service_role;
revoke execute on function public.sunland_set_pro_payment_backoff(integer) from service_role;
revoke execute on function public.sunland_claim_pro_payment_scan(text) from service_role;
revoke execute on function public.sunland_complete_pro_payment_scan(text,uuid,bigint,integer,integer,text[]) from service_role;
revoke execute on function public.sunland_release_pro_payment_scan(text,uuid,bigint) from service_role;
-- Keep columns, cursor, trigger and records for recovery and erasure. No pro=false.
commit;
