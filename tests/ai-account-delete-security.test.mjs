import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

import {
  deleteAvatarObjectIfExists,
  deleteAvatarPrefixWithPages,
  encodeAvatarOwnerKey as encodeEdgeAvatarOwnerKey,
  extractStableUserId,
  isAlreadyRevokedResponse,
  matchesExternalOwnership,
  avatarPathBelongsToUser,
  avatarStorageNamespaces,
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
      assert.equal(options.offset, 0);
      return {
        data: objects.slice(options.offset, options.offset + options.limit),
        error: null,
      };
    },
    remove: async (paths) => {
      removeCalls += 1;
      removed.push(...paths);
      const names = new Set(paths.map((path) => path.split("/").at(-1)));
      for (let index = objects.length - 1; index >= 0; index--) {
        if (names.has(objects[index].name)) objects.splice(index, 1);
      }
      return { error: null };
    },
    prefix: "owner-key",
  });

  assert.equal(error, null);
  assert.equal(removed.length, total);
  assert.equal(removeCalls, 2);
  assert.equal(listCalls, 3);
});

for (const total of [0, 1, 999, 1000, 1001, 1999, 2000, 2001, 3001]) {
  test(`avatar cleanup drains ${total} objects without skipping`, async () => {
    const objects = Array.from({ length: total }, (_, index) => ({ name: `a-${index}` }));
    const removed = [];
    const error = await deleteAvatarPrefixWithPages({
      prefix: "owner-key",
      list: async (_prefix, options) => {
        assert.equal(options.offset, 0);
        return { data: objects.slice(0, options.limit), error: null };
      },
      remove: async (paths) => {
        removed.push(...paths);
        const names = new Set(paths.map((path) => path.slice("owner-key/".length)));
        for (let index = objects.length - 1; index >= 0; index--) {
          if (names.has(objects[index].name)) objects.splice(index, 1);
        }
        return { error: null };
      },
    });
    assert.equal(error, null);
    assert.equal(objects.length, 0);
    assert.equal(new Set(removed).size, total);
  });
}

test("avatar cleanup propagates list and partial remove failures for retry", async () => {
  const objects = [{ name: "a" }, { name: "b" }];
  let failed = false;
  const list = async () => ({ data: objects.slice(), error: null });
  const remove = async (paths) => {
    if (!failed) {
      failed = true;
      objects.shift();
      return { error: { statusCode: 500 } };
    }
    objects.splice(0, objects.length);
    return { error: null };
  };
  const firstError = await deleteAvatarPrefixWithPages({ list, remove, prefix: "owner" });
  assert.equal(firstError?.statusCode, 500);
  const retryError = await deleteAvatarPrefixWithPages({ list, remove, prefix: "owner" });
  assert.equal(retryError, null);
  assert.equal(objects.length, 0);

  const listError = await deleteAvatarPrefixWithPages({
    list: async () => ({ data: null, error: { statusCode: 404 } }),
    remove: async () => { throw new Error("remove should not run"); },
    prefix: "owner",
  });
  assert.equal(listError?.statusCode, 404);
});

test("avatar cleanup fails closed on a middle-page list error then retries", async () => {
  const objects = Array.from({ length: 1001 }, (_, index) => ({ name: `a-${index}` }));
  let listCalls = 0;
  let failMiddlePage = true;
  const list = async () => {
    listCalls++;
    if (failMiddlePage && listCalls === 2) {
      failMiddlePage = false;
      return { data: null, error: { statusCode: 503 } };
    }
    return { data: objects.slice(0, 1000), error: null };
  };
  const remove = async (paths) => {
    const names = new Set(paths.map((path) => path.slice("owner/".length)));
    for (let index = objects.length - 1; index >= 0; index--) {
      if (names.has(objects[index].name)) objects.splice(index, 1);
    }
    return { error: null };
  };
  assert.equal((await deleteAvatarPrefixWithPages({ list, remove, prefix: "owner" }))?.statusCode, 503);
  assert.equal(objects.length, 1);
  assert.equal(await deleteAvatarPrefixWithPages({ list, remove, prefix: "owner" }), null);
  assert.equal(objects.length, 0);
});

test("avatar cleanup rejects unavailable listings and safely bounds duplicate or stale entries", async () => {
  const remove = async () => ({ error: null });
  for (const data of [null, [{ name: "a" }, { name: "a" }], [{ bad: "entry" }]]) {
    const error = await deleteAvatarPrefixWithPages({
      list: async () => ({ data, error: null }), remove, prefix: "owner",
    });
    if (data === null) assert.ok(error);
    else assert.equal(error, null);
  }
  let calls = 0;
  const stale = await deleteAvatarPrefixWithPages({
    list: async () => { calls++; return { data: [{ name: "a" }], error: null }; },
    remove, prefix: "owner",
  });
  assert.equal(stale, null);
  assert.equal(calls, 2);
});

test("avatar cleanup bounds alternating eventually consistent pages", async () => {
  let calls = 0;
  const error = await deleteAvatarPrefixWithPages({
    list: async () => ({ data: [{ name: `stale-${calls++ % 2}` }], error: null }),
    remove: async () => ({ error: null }),
    prefix: "owner", maxPages: 5,
  });
  assert.equal(error, null);
  assert.equal(calls, 3);
});

test("avatar cleanup can finish after an already-deleted object", async () => {
  let calls = 0;
  const error = await deleteAvatarPrefixWithPages({
    list: async () => ({ data: calls++ === 0 ? [{ name: "gone" }] : [], error: null }),
    remove: async () => ({ data: [], error: null }),
    prefix: "owner",
  });
  assert.equal(error, null);
  assert.equal(calls, 2);
});

test("exact legacy avatar path deletion is idempotent on missing objects", async () => {
  const removed = [];
  let error = await deleteAvatarObjectIfExists({
    remove: async (paths) => {
      removed.push(...paths);
      return { error: null };
    },
    userId: "legacy",
    path: "legacy.png",
  });

  assert.equal(error, null);
  assert.deepEqual(removed, ["legacy.png"]);

  error = await deleteAvatarObjectIfExists({
    remove: async () => ({ error: { statusCode: 404, code: "NoSuchKey" } }),
    userId: "legacy",
    path: "legacy.png",
  });
  assert.equal(error, null);

  error = await deleteAvatarObjectIfExists({
    remove: async () => ({ error: { statusCode: 404, code: "NoSuchBucket" } }),
    userId: "legacy",
    path: "legacy.png",
  });
  assert.equal(error?.code, "NoSuchBucket");
});

test("avatar deletion validates ownership for encoded and unambiguous legacy paths", () => {
  const userId = "a@b.example";
  const owner = encodeEdgeAvatarOwnerKey(userId);
  const uuid = "11111111-1111-4111-8111-111111111111";
  for (const path of [
    `${owner}/photo.png`, `${userId}.png`, `${owner}/unknown extension.weird`,
    `${owner}/旧头像 💙.jpeg`, `${owner}/photo.png?other`, `${owner}/50% off#old`,
    `${owner}/nested/unknown`, `${owner}/photo%2fpng`,
  ]) {
    assert.equal(avatarPathBelongsToUser(path, userId), true);
  }
  assert.equal(avatarPathBelongsToUser(`${uuid}/photo.jpg`, uuid), true);
  for (const path of [
    "victim.png", `${encodeEdgeAvatarOwnerKey("victim")}/photo.png`,
    `${userId}/photo.png`, `${owner}-other/photo.png`,
    `${owner}/../victim.png`, `${owner}/..`, `${owner}/.`,
    `${owner}/%2e%2e`, `${owner}/%252e%252e/victim`, `${owner}/photo\\png`,
    `${owner}/%252f..%252fvictim`, `${owner}/a%5c..%5cvictim`,
    `${owner}/photo\u0000.png`, `/${owner}/photo.png`,
    `https://example.test/${owner}/photo.png`,
    "", null, 123,
  ]) assert.equal(avatarPathBelongsToUser(path, userId), false, String(path));
  assert.equal(avatarPathBelongsToUser(`${owner}/photo.png`, "../victim"), false);
  assert.equal(avatarPathBelongsToUser("null.png", null), false);
});

test("foreign paths from a profile or cached deletion job never reach service-role remove", async () => {
  const deleteAvatarsSource = edgeIndex.slice(
    edgeIndex.indexOf("async function deleteAvatars("),
    edgeIndex.indexOf("async function handleAuthorize("),
  );
  const deleteAvatars = vm.runInNewContext(
    `${stripTypeScriptTypes(deleteAvatarsSource)}; deleteAvatars`,
    {
      encodeAvatarOwnerKey: encodeEdgeAvatarOwnerKey,
      avatarStorageNamespaces,
      deleteAvatarPrefixWithPages,
      deleteAvatarObjectIfExists,
      AVATAR_BUCKET: "avatars",
    },
  );
  for (const source of ["profile", "cached job"]) {
    let removes = 0;
    const admin = { storage: { from(bucket) {
      assert.equal(bucket, "avatars");
      return {
        list: async (prefix) => {
          assert.equal(prefix, encodeEdgeAvatarOwnerKey("user-a"));
          return { data: [], error: null };
        },
        remove: async () => { removes += 1; return { error: null }; },
      };
    } } };
    const error = await deleteAvatars(
      admin, "user-a", `${encodeEdgeAvatarOwnerKey("user-b")}/photo.png`, async () => true,
    );
    assert.equal(error, null, source);
    assert.equal(removes, 0, source);
  }
  assert.match(edgeIndex, /path: legacyAvatarPath,\s*userId,/);
});

test("avatar prefix cleanup skips traversal entries without blocking deletion", async () => {
  for (const name of ["..", "../victim.png", "photo\\png", "%2e%2e", "%252e%252e/victim", "photo\u0000.png"]) {
    let removes = 0;
    const error = await deleteAvatarPrefixWithPages({
      prefix: encodeEdgeAvatarOwnerKey("user-a"),
      list: async () => ({ data: [{ name }], error: null }),
      remove: async () => { removes++; return { error: null }; },
    });
    assert.equal(error, null);
    assert.equal(removes, 0, name);
  }
});

test("owned avatar removal still honors the deletion lease", async () => {
  let removes = 0;
  const error = await deleteAvatarObjectIfExists({
    userId: "user-a", path: "user-a.png", renewLease: async () => false,
    remove: async () => { removes += 1; return { error: null }; },
  });
  assert.equal(error.message, "lease lost");
  assert.equal(removes, 0);
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
