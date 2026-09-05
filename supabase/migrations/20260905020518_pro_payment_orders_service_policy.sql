begin;

create policy "pro_payment_orders_service_role_only"
  on public.pro_payment_orders
  for all
  to service_role
  using (true)
  with check (true);

commit;
