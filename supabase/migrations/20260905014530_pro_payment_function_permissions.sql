begin;

revoke all on function public.sunland_get_or_create_pro_payment_intent() from public, anon, authenticated;
revoke all on function public.sunland_activate_pro_from_payment(text, text, text, text, numeric, timestamptz) from public, anon, authenticated;
revoke all on function public.sunland_resolve_pro_payment(text, text) from public, anon, authenticated;

grant execute on function public.sunland_get_or_create_pro_payment_intent() to authenticated;
grant execute on function public.sunland_activate_pro_from_payment(text, text, text, text, numeric, timestamptz) to service_role;
grant execute on function public.sunland_resolve_pro_payment(text, text) to service_role;

commit;
