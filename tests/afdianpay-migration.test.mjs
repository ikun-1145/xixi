import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const file = readdirSync(new URL('../supabase/migrations/', import.meta.url)).find(name => name.endsWith('_verified_pro_payment_reconciliation.sql'));
const sql = readFileSync(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8');
const body = name => sql.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?as \\$\\$([\\s\\S]*?)\\$\\$;`, 'i'))?.[1] || '';

test('verified payment migration keeps payment facts separate and its order lock first', () => {
  assert.match(sql, /payment_status text not null default 'unknown'/);
  assert.match(sql, /verified_binding_reference text/);
  const v2 = body('sunland_process_verified_pro_order');
  assert.ok(v2.includes('pg_advisory_xact_lock(hashtext(v_order_id))'));
  assert.ok(v2.indexOf('pg_advisory_xact_lock(hashtext(v_order_id))') < v2.indexOf('from public.pro_payment_orders'));
  assert.ok(v2.indexOf('for update') < v2.indexOf('set pro = true'));
  assert.doesNotMatch(v2, /set pro = false|insert into public.user_profiles/i);
  const cached = v2.slice(v2.indexOf('if p_use_cached then'), v2.indexOf('  else\n    if jsonb_typeof'));
  assert.match(cached, /'PROVIDER_VERIFICATION_REQUIRED'/);
  assert.match(cached, /return jsonb_build_object/);
  assert.doesNotMatch(cached, /v_status := 'activated'|set pro = true|v_payment_status := v_existing.payment_status/);
  assert.match(v2, /BINDING_CONFLICT/);
  assert.match(v2, /v_existing\.binding_source in \('intent', 'legacy', 'support'\)/);
  assert.match(v2, /v_reason := 'OWNER_ANONYMIZED'/);
  assert.match(v2, /Rejected observations must not introduce references/);
  assert.equal((v2.match(/v_reference := lower\(v_reference\)/g) || []).length, 1);
  assert.match(v2, /select attempt_count into v_attempt_count from public\.pro_payment_orders/);
  assert.equal((v2.match(/'state_before', v_existing\.status/g) || []).length, 2);
  assert.equal((v2.match(/'attempt_count', v_attempt_count/g) || []).length, 2);
});

test('all payment overloads lose direct grant while the fresh deletion body keeps existing tables', () => {
  const old = sql.slice(sql.indexOf('-- Legacy payment entry points'), sql.indexOf('-- Current production deletion function'));
  assert.doesNotMatch(old, /set pro\s*=\s*true|insert into public.user_profiles/i);
  assert.match(old, /sunland_resolve_pro_payment\(/);
  const sixParameter = old.slice(0, old.indexOf('create or replace function public.sunland_activate_pro_from_payment(p_user_id'));
  assert.match(sixParameter, /then 'ineligible'::text else 'unresolved'::text/);
  assert.doesNotMatch(sixParameter, /'verification_required'/);
  const cleanup = body('sunland_delete_account_business_data');
  for (const table of ['chat_message_images', 'chat_turns', 'chat_messages', 'chat_usage_entries', 'chat_daily_usage', 'chat_threads', 'sunland_ai_turn_results', 'sunland_ai_migration_receipts', 'sunland_ai_context', 'sunland_ai_knowledge', 'sunland_ai_memory', 'sunland_ai_user_state', 'pro_activations', 'comment_copilot_context', 'comment_copilot_usage', 'conversations', 'deleted_conversations', 'usage', 'usage_logs', 'request_logs', 'pro_payment_intents']) {
    assert.match(cleanup, new RegExp(`delete from public\\.${table}\\b`));
  }
  assert.ok(cleanup.indexOf('for update') < cleanup.indexOf('chat_prepare_account_delete'));
  assert.ok(cleanup.indexOf('verified_binding_reference = null') < cleanup.indexOf('delete from public.pro_payment_intents'));
  assert.match(cleanup, /ACCOUNT_DELETION_NOT_STARTED/);
  assert.match(cleanup, /DATA_DELETED/);
  assert.match(cleanup, /then last_error_code else 'DATA_DELETED' end/);
});

test('new payment RPCs are service-only and scheduler uses a fenced persistent cursor', () => {
  for (const name of ['sunland_process_verified_pro_order', 'sunland_record_pro_payment_hints', 'sunland_claim_pro_payment_order_query', 'sunland_claim_pro_payment_scan', 'sunland_complete_pro_payment_scan', 'sunland_release_pro_payment_scan', 'sunland_note_pro_payment_retry', 'sunland_set_pro_payment_backoff', 'sunland_get_pro_payment_backoff']) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${name}\\([^;]+from public, anon, authenticated`, 'i'));
    assert.match(sql, new RegExp(`grant execute on function public\\.${name}\\([^;]+to service_role`, 'i'));
  }
  assert.match(sql, /alter table public\.pro_payment_reconciliation_state enable row level security/);
  assert.match(body('sunland_complete_pro_payment_scan'), /lease_token = p_lease_token[\s\S]*generation = p_generation/);
  assert.match(body('sunland_complete_pro_payment_scan'), /PAGE_NOT_DURABLE/);
  assert.doesNotMatch(sql, /minute_lane_counts|hour_lane_counts|per_user_cooldown/);
  assert.doesNotMatch(sql, /create or replace function public\.sunland_get_or_create_pro_payment_intent/);
});

test('order query claims fence signed webhook replays without altering verified facts', () => {
  const claim = body('sunland_claim_pro_payment_order_query');
  assert.ok(claim.indexOf('pg_advisory_xact_lock(hashtext(p_order_id))') < claim.indexOf('from public.pro_payment_orders'));
  assert.match(claim, /next_retry_at is null/);
  assert.match(claim, /last_seen_at \+ interval '20 seconds'/);
  assert.match(claim, /next_retry_at = case when status = 'unresolved'/);
  assert.doesNotMatch(claim, /last_verified_at\s*=|verified_binding_reference\s*=|set pro\s*=/i);
  assert.doesNotMatch(body('sunland_record_pro_payment_hints'), /update public\.pro_payment_orders/);
  const note = body('sunland_note_pro_payment_retry');
  assert.doesNotMatch(note.slice(0, note.indexOf('perform pg_advisory')), /'PROVIDER_FACT_CONFLICT'/);
});
