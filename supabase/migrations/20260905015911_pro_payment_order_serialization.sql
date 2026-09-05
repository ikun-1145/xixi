begin;

create or replace function public.sunland_serialize_pro_payment_order_insert()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  perform pg_advisory_xact_lock(hashtext(new.order_id));
  if exists (select 1 from public.pro_payment_orders where order_id = new.order_id) then
    return null;
  end if;
  return new;
end;
$$;

create trigger pro_payment_orders_serialize_insert
before insert on public.pro_payment_orders
for each row
execute function public.sunland_serialize_pro_payment_order_insert();

revoke all on function public.sunland_serialize_pro_payment_order_insert() from public, anon, authenticated;
grant execute on function public.sunland_serialize_pro_payment_order_insert() to service_role;

commit;
