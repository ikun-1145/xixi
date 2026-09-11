begin;

create table public.account_deletion_jobs (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id text not null check (user_id ~ '^[A-Za-z0-9][A-Za-z0-9@._+-]{0,127}$'),
  token_hash text not null unique,
  status text not null default 'pending' check (status in ('pending', 'in_progress', 'completed')),
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  attempt_id text,
  fencing_version bigint not null default 0,
  expires_at timestamptz not null,
  recovery_expires_at timestamptz,
  legacy_avatar_path text,
  external_revoked_at timestamptz,
  data_deleted_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index account_deletion_jobs_user_id_idx
  on public.account_deletion_jobs (user_id);

create index account_deletion_jobs_status_expires_idx
  on public.account_deletion_jobs (status, expires_at);

create index account_deletion_jobs_recovery_expires_idx
  on public.account_deletion_jobs (recovery_expires_at)
  where recovery_expires_at is not null;

alter table public.account_deletion_jobs enable row level security;

revoke all on table public.account_deletion_jobs from public, anon, authenticated;
grant select, insert, update, delete on table public.account_deletion_jobs to service_role;

create or replace function public.sunland_claim_account_deletion_job(
  p_job_id uuid,
  p_token_hash text,
  p_attempt_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_user_id text;
  v_attempt_id text;
  v_fencing_version bigint;
  v_now timestamptz := now();
begin
  if p_job_id is null or p_token_hash is null or p_attempt_id is null then
    return null;
  end if;

  if p_attempt_id !~ '^[A-Za-z0-9_-]{16,128}$' then
    return null;
  end if;

  update public.account_deletion_jobs
     set status = 'in_progress',
         claimed_at = v_now,
         lease_expires_at = v_now + interval '90 seconds',
         attempt_id = p_attempt_id,
         fencing_version = fencing_version +
           case
             when status = 'pending' or attempt_id is distinct from p_attempt_id then 1
             else 0
           end,
         recovery_expires_at = v_now + interval '7 days'
   where id = p_job_id
     and token_hash = p_token_hash
     and (
       (
         status = 'pending'
         and expires_at > v_now
       )
       or (
         status = 'in_progress'
         and (
           attempt_id = p_attempt_id
           or lease_expires_at is null
           or lease_expires_at < v_now
         )
         and recovery_expires_at > v_now
       )
     )
  returning user_id, attempt_id, fencing_version
    into v_user_id, v_attempt_id, v_fencing_version;

  if v_user_id is null then
    return null;
  end if;

  return jsonb_build_object(
    'user_id', v_user_id,
    'attempt_id', v_attempt_id,
    'fencing_version', v_fencing_version
  );
end;
$$;

revoke all on function public.sunland_claim_account_deletion_job(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.sunland_claim_account_deletion_job(uuid, text, text) to service_role;

create or replace function public.sunland_delete_account_data(
  p_user_id text
)
returns table(status text)
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_existed boolean := false;
begin
  if p_user_id is null or p_user_id !~ '^[A-Za-z0-9][A-Za-z0-9@._+-]{0,127}$' then
    raise exception 'invalid user id' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('sunland-delete-account:' || p_user_id));

  select exists(select 1 from public.user_profiles where user_id = p_user_id) into v_existed;

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

  delete from public.user_profiles where user_id = p_user_id;

  if v_existed then
    return query select 'deleted'::text;
  else
    return query select 'already_deleted'::text;
  end if;
end;
$$;

revoke all on function public.sunland_delete_account_data(text)
  from public, anon, authenticated;
grant execute on function public.sunland_delete_account_data(text) to service_role;

commit;
