import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  deleteAvatarObjectIfExists,
  deleteAvatarPrefixWithPages,
  encodeAvatarOwnerKey as encodeEdgeAvatarOwnerKey,
  extractStableUserId,
  isAlreadyRevokedResponse,
  matchesExternalOwnership,
} from "../supabase/functions/sunland-account-delete/account-delete-core.js";
import { encodeAvatarOwnerKey as encodeFrontendAvatarOwnerKey } from "../ai/avatar-storage-key.js";
import { collectAccountLocalStorageKeys } from "../ai/account-delete.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const migrationSql = readFileSync(
  join(rootDir, "supabase/migrations/20260906010000_account_deletion.sql"),
  "utf8",
);
const finalizeOrderSql = readFileSync(
  join(rootDir, "supabase/migrations/20260911120000_account_deletion_finalize_order.sql"),
  "utf8",
);
const edgeIndex = readFileSync(
  join(rootDir, "supabase/functions/sunland-account-delete/index.ts"),
  "utf8",
);

test("avatar owner key is injective and URL-safe across upload and deletion", () => {
  const ids = ["a.b", "a@b", "a+b", "a_b"];
  const frontendKeys = ids.map(encodeFrontendAvatarOwnerKey);
  const edgeKeys = ids.map(encodeEdgeAvatarOwnerKey);

  assert.deepEqual(frontendKeys, edgeKeys);
  assert.equal(new Set(frontendKeys).size, ids.length);
  for (const key of frontendKeys) {
    assert.match(key, /^[A-Za-z0-9_-]+$/);
  }
});

test("authoritative user id rejects email-only identity responses", () => {
  assert.equal(extractStableUserId({ user: { email: "a@example.com" } }), null);
  assert.equal(extractStableUserId({ token: "a.b.c", user: { email: "a@example.com" } }), null);
  assert.equal(extractStableUserId({ user: { id: "user-a" } }), "user-a");
  assert.equal(extractStableUserId({ token: "a.b.c", sub: "user-b" }), "user-b");
});

test("already_revoked 409 requires matching job id and user id", () => {
  assert.equal(
    isAlreadyRevokedResponse({
      status: 409,
      data: { code: "already_revoked", deletion_job_id: "job-1", user_id: "user-a" },
      jobId: "job-1",
      userId: "user-a",
    }),
    true,
  );
  assert.equal(
    isAlreadyRevokedResponse({
      status: 409,
      data: { code: "already_revoked", deletion_job_id: "job-1", user_id: "user-a" },
      jobId: "job-2",
      userId: "user-a",
    }),
    false,
  );
  assert.equal(
    isAlreadyRevokedResponse({
      status: 409,
      data: { code: "already_revoked", deletion_job_id: "job-1", user_id: "user-a" },
      jobId: "job-1",
      userId: "user-b",
    }),
    false,
  );
  assert.equal(
    isAlreadyRevokedResponse({
      status: 409,
      data: { code: "already_revoked", deletion_job_id: "job-1" },
      jobId: "job-1",
      userId: "user-a",
    }),
    false,
  );
  assert.equal(
    isAlreadyRevokedResponse({
      status: 409,
      data: { code: "conflict", deletion_job_id: "job-1", user_id: "user-a" },
      jobId: "job-1",
      userId: "user-a",
    }),
    false,
  );
});

test("external ownership requires job, user, attempt, and fencing_version to match", () => {
  const base = {
    jobId: "job-1",
    userId: "user-a",
    attemptId: "attempt-BBBBBBBBBBBBBBBB",
    fencingVersion: 2,
  };
  const data = {
    deletion_job_id: "job-1",
    user_id: "user-a",
    attempt_id: "attempt-BBBBBBBBBBBBBBBB",
    fencing_version: 2,
  };

  assert.equal(matchesExternalOwnership({ ...base, data }), true);
  assert.equal(
    matchesExternalOwnership({
      ...base,
      data: { ...data, deletion_job_id: "job-2" },
    }),
    false,
  );
  assert.equal(
    matchesExternalOwnership({
      ...base,
      data: { ...data, user_id: "user-b" },
    }),
    false,
  );
  assert.equal(
    matchesExternalOwnership({
      ...base,
      data: { ...data, attempt_id: "attempt-AAAAAAAAAAAAAAAA" },
    }),
    false,
  );
  assert.equal(
    matchesExternalOwnership({
      ...base,
      data: { ...data, fencing_version: 1 },
    }),
    false,
  );
});

test("avatar prefix deletion pages through more than 1000 objects", async () => {
  const total = 1001;
  const removed = [];
  let listCalls = 0;
  let removeCalls = 0;
  const objects = Array.from({ length: total }, (_, index) => ({
    name: `avatar-${index}.jpg`,
  }));

  const error = await deleteAvatarPrefixWithPages({
    list: async (_prefix, options) => {
      listCalls += 1;
      return {
        data: objects.slice(options.offset, options.offset + options.limit),
        error: null,
      };
    },
    remove: async (paths) => {
      removeCalls += 1;
      removed.push(...paths);
      return { error: null };
    },
    prefix: "owner-key",
  });

  assert.equal(error, null);
  assert.equal(removed.length, total);
  assert.equal(removeCalls, 2);
  assert.equal(listCalls, 2);
});

test("exact legacy avatar path deletion is idempotent on missing objects", async () => {
  const removed = [];
  let error = await deleteAvatarObjectIfExists({
    remove: async (paths) => {
      removed.push(...paths);
      return { error: null };
    },
    path: "legacy/avatar.jpg",
  });

  assert.equal(error, null);
  assert.deepEqual(removed, ["legacy/avatar.jpg"]);

  error = await deleteAvatarObjectIfExists({
    remove: async () => ({ error: { statusCode: 404 } }),
    path: "legacy/missing.jpg",
  });
  assert.equal(error, null);
});

test("migration enforces service_role-only RLS and definer permissions", () => {
  assert.match(migrationSql, /alter table public\.account_deletion_jobs enable row level security;/);
  assert.match(
    migrationSql,
    /revoke all on table public\.account_deletion_jobs from public, anon, authenticated;/,
  );
  assert.match(
    migrationSql,
    /grant select, insert, update, delete on table public\.account_deletion_jobs to service_role;/,
  );
  assert.match(
    migrationSql,
    /revoke all on function public\.sunland_claim_account_deletion_job\(uuid, text, text\)/,
  );
  assert.match(
    migrationSql,
    /grant execute on function public\.sunland_claim_account_deletion_job\(uuid, text, text\) to service_role;/,
  );
  assert.match(migrationSql, /security definer/);
  assert.match(migrationSql, /set search_path = pg_catalog, public, extensions/);
});

test("claim SQL uses attempt_id, lease expiry, and recovery expiry", () => {
  assert.match(migrationSql, /attempt_id = p_attempt_id/);
  assert.match(migrationSql, /lease_expires_at < v_now/);
  assert.match(migrationSql, /recovery_expires_at > v_now/);
  assert.match(migrationSql, /expires_at > v_now/);
  assert.match(migrationSql, /fencing_version bigint not null default 0/);
  assert.match(
    migrationSql,
    /fencing_version = fencing_version \+\s*case\s+when status = 'pending' or attempt_id is distinct from p_attempt_id then 1\s+else 0\s+end/,
  );
  assert.match(migrationSql, /returning user_id, attempt_id, fencing_version/);
  assert.match(migrationSql, /jsonb_build_object\(\s*'user_id', v_user_id/);
});

test("finalize-order migration preserves the identity row until after finalize", () => {
  assert.match(finalizeOrderSql, /create or replace function public\.sunland_delete_account_business_data/);
  assert.match(finalizeOrderSql, /delete from public\.conversations/);
  assert.match(finalizeOrderSql, /update public\.pro_payment_orders/);
  assert.doesNotMatch(finalizeOrderSql, /delete from public\.user_profiles/);
  assert.match(finalizeOrderSql, /identity_retired_at timestamptz/);
  assert.match(finalizeOrderSql, /profile_sanitized_at timestamptz/);
});

test("delete data function covers uuid and text user_id tables idempotently", () => {
  assert.match(migrationSql, /delete from public\.usage_logs where user_id::text = p_user_id;/);
  assert.match(migrationSql, /delete from public\.request_logs where user_id::text = p_user_id;/);
  assert.match(migrationSql, /delete from public\.user_profiles where user_id = p_user_id;/);
  assert.match(migrationSql, /pg_advisory_xact_lock\(hashtext\('sunland-delete-account:' \|\| p_user_id\)\);/);
});

test("edge execute validates token before completed and returns authoritative user id", () => {
  assert.match(edgeIndex, /if \(job\.token_hash !== tokenHash\)/);
  assert.match(edgeIndex, /already_completed: true, user_id: job\.user_id/);
  assert.match(edgeIndex, /return json\(\{ ok: true, user_id: userId \}\);/);
  assert.match(edgeIndex, /const fencingVersion = claim\.fencingVersion as number;/);
  assert.match(edgeIndex, /fencing_version: fencingVersion/);
  assert.match(edgeIndex, /\.eq\("fencing_version", fencingVersion\)/);
  assert.match(edgeIndex, /matchesExternalOwnership\(\{/);
  assert.match(edgeIndex, /sunland_delete_account_business_data/);
  assert.match(edgeIndex, /sunland_account_delete_sanitize_profile/);
  assert.match(edgeIndex, /identity_retired_at/);
  assert.match(edgeIndex, /profile_sanitized_at/);
});

test("frontend local key collection uses normalizeUserId and rejects padded ids", () => {
  assert.deepEqual(collectAccountLocalStorageKeys("user-a"), [
    "token",
    "user",
    "conversations_user-a",
    "current_conversation_user-a",
    "xixi_profile_user-a",
    "sunland_knowledge_user-a",
    "sunland_knowledge_user-a::memory",
    "sunland_remote_legacy_knowledge_user-a",
    "sunland_remote_legacy_memory_user-a",
    "sunland_remote_legacy_conversations_user-a",
    "sunland_remote_migration_user-a",
    "sunland:pro-payment-pending:user-a",
  ]);
  assert.deepEqual(collectAccountLocalStorageKeys("  user-a  "), []);
});
