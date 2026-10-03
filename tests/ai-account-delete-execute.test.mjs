import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import test from "node:test";
import * as core from "../supabase/functions/sunland-account-delete/account-delete-core.js";

// Run the complete production Edge router/handleExecute in memory. Only external I/O is stubbed.
const source = readFileSync(new URL("../supabase/functions/sunland-account-delete/index.ts", import.meta.url), "utf8")
  .replace(/^import\s+[\s\S]*?\sfrom\s+"[^"]+";\s*$/gm, "");
const userId = "11111111-1111-4111-8111-111111111111";
const foreignId = "22222222-2222-4222-8222-222222222222";
const owner = core.encodeAvatarOwnerKey(userId);
const deletionToken = "fixture-deletion-token";

function edge({ pathSource = "profile", avatarPath = `${owner}/old avatar`, objects = [],
  invalidEntries = [], stale = false, changingPages = false, failRemoveOnce = false, vanishOnRemove = false } = {}) {
  const job = { id: "fixture-job", user_id: userId, status: "pending",
    token_hash: createHash("sha256").update(deletionToken).digest("hex"),
    legacy_avatar_path: pathSource === "cached job" ? avatarPath : null,
    external_revoked_at: null, data_deleted_at: null, identity_retired_at: null, profile_sanitized_at: null };
  const stored = new Set(objects);
  const removed = [], listCalls = [], rpcCalls = [], externalCalls = [];
  let profileReads = 0, profileExists = true, removeFailed = false;
  const admin = {
    from(table) {
      let patch;
      const filters = [];
      const query = {
        select() { return query; }, eq(key, value) { filters.push([key, value]); return query; },
        is() { return query; }, update(value) { patch = value; return query; },
        async maybeSingle() {
          if (table === "user_profiles") {
            assert.ok(filters.some(([key, value]) => key === "user_id" && value === userId));
            profileReads++;
            return { data: profileExists ? { avatar_path: avatarPath } : null, error: null };
          }
          assert.equal(table, "account_deletion_jobs");
          return { data: { ...job }, error: null };
        },
        then(resolve, reject) {
          assert.equal(table, "account_deletion_jobs");
          if (patch) Object.assign(job, patch);
          return Promise.resolve({ error: null }).then(resolve, reject);
        },
      };
      return query;
    },
    async rpc(name, args) {
      rpcCalls.push(name);
      if (name === "sunland_claim_account_deletion_job") {
        assert.equal(args.p_job_id, job.id);
        assert.equal(args.p_token_hash, job.token_hash);
        job.status = "in_progress";
        job.attempt_id = args.p_attempt_id;
        job.fencing_version = 1;
        return { data: { user_id: userId, attempt_id: args.p_attempt_id, fencing_version: 1 }, error: null };
      }
      assert.equal(args.p_user_id, userId);
      if (name === "sunland_delete_account_business_data") {
        profileExists = false;
        return { error: null };
      }
      assert.equal(name, "sunland_account_delete_sanitize_profile");
      return { data: { code: "sanitized" }, error: null };
    },
    storage: { from(bucket) {
      assert.equal(bucket, "avatars");
      return {
        async list(prefix, { offset, limit }) {
          assert.ok(core.avatarStorageNamespaces(userId).some(root => prefix === root || prefix.startsWith(`${root}/`)));
          listCalls.push({ prefix, offset });
          if (changingPages && prefix === owner) {
            return { data: [{ name: `changing-${listCalls.length}`, id: "fixture", metadata: {} }], error: null };
          }
          if (stale && prefix === owner) return { data: [{ name: "stale object", id: "fixture", metadata: {} }], error: null };
          const entries = new Map();
          for (const path of stored) {
            if (!path.startsWith(`${prefix}/`)) continue;
            const rest = path.slice(prefix.length + 1);
            const name = rest.split("/")[0];
            entries.set(name, rest.includes("/") ? { name, id: null, metadata: null }
              : { name, id: path, metadata: {} });
          }
          const values = [...entries.values(), ...(prefix === owner ? invalidEntries : [])];
          values.sort((a, b) => String(a.name).localeCompare(String(b.name)));
          return { data: values.slice(offset, offset + limit), error: null };
        },
        async remove(paths) {
          for (const path of paths) {
            assert.equal(core.avatarPathBelongsToUser(path, userId), true, path);
            assert.equal(core.avatarPathBelongsToUser(path, foreignId), false, path);
          }
          if (failRemoveOnce && !removeFailed) {
            removeFailed = true;
            return { error: { statusCode: 503, code: "Unavailable" } };
          }
          removed.push(...paths);
          if (vanishOnRemove) paths.forEach(path => stored.delete(path));
          const existed = paths.some(path => stored.has(path));
          paths.forEach(path => stored.delete(path));
          return { error: existed || stale ? null : { statusCode: 404, code: "NoSuchKey" } };
        },
      };
    } },
  };
  let handler;
  vm.runInNewContext(stripTypeScriptTypes(source), {
    ...core, Request, Response, Headers, URL, TextEncoder, TextDecoder, crypto, Date, Error, btoa, atob,
    createClient: () => admin,
    Deno: { env: { get: () => "fixture-server-config" }, serve: fn => { handler = fn; } },
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      externalCalls.push(path);
      if (path === "/v1/account-delete/identity") {
        assert.equal(init.body, "{}");
        return Response.json({ user_id: userId, identity_status: "active", is_banned: false });
      }
      assert.ok(["/v1/account-delete/begin", "/v1/account-delete/finalize"].includes(path));
      const body = JSON.parse(init.body);
      assert.equal(body.user_id, userId);
      assert.equal(body.attempt_id, job.attempt_id);
      assert.equal(body.fencing_version, job.fencing_version);
      return Response.json({ ...body, ok: true });
    },
  });
  const execute = (token = deletionToken) => handler(new Request("https://offline.test/delete", {
    method: "POST", headers: { Authorization: "Bearer fixture-app-token", "Content-Type": "application/json" },
    body: JSON.stringify({ action: "execute", deletion_job_id: job.id, deletion_token: token,
      confirmation: "删除我的账号", user_id: foreignId, avatar_path: `${foreignId}/victim` }),
  }));
  return { execute, job, stored, removed, listCalls, rpcCalls, externalCalls, profileReads: () => profileReads };
}

async function completesTwice(e) {
  const first = await e.execute();
  assert.equal(first.status, 200, JSON.stringify(await first.clone().json()));
  assert.equal(e.job.status, "completed");
  assert.ok(e.job.data_deleted_at && e.job.identity_retired_at && e.job.profile_sanitized_at);
  const calls = e.rpcCalls.length, removes = e.removed.length;
  const second = await e.execute();
  assert.equal(second.status, 200);
  assert.equal((await second.json()).already_completed, true);
  assert.equal(e.rpcCalls.length, calls);
  assert.equal(e.removed.length, removes);
}

for (const pathSource of ["profile", "cached job"]) {
  test(`real handleExecute revalidates ${pathSource} and never removes foreign objects`, async () => {
    const foreign = `${core.encodeAvatarOwnerKey(foreignId)}/victim`;
    const e = edge({ pathSource, avatarPath: foreign, objects: [foreign, `${owner}/unknown?name#50% old`] });
    await completesTwice(e);
    assert.equal(e.stored.has(foreign), true);
    assert.deepEqual(e.removed, [`${owner}/unknown?name#50% old`]);
    assert.equal(e.profileReads(), pathSource === "profile" ? 1 : 0);
  });
  test(`real handleExecute skips escaped or colliding ${pathSource} paths and completes`, async () => {
    for (const avatarPath of [`${owner}-other/victim`, `${owner}/../${foreignId}/victim`,
      `${owner}/%252e%252e/${foreignId}/victim`, `${owner}/x%2f..%2f..%2f${foreignId}/victim`,
      `${owner}/x%5c..%5c${foreignId}/victim`]) {
      const foreign = `${foreignId}/victim`;
      const e = edge({ pathSource, avatarPath, objects: [foreign] });
      await completesTwice(e);
      assert.equal(e.stored.has(foreign), true);
      assert.equal(e.removed.length, 0);
    }
  });
}

test("real handleExecute cleans unknown filenames, nested objects and legacy namespaces", async () => {
  const objects = [`${owner}/旧头像 💙.unknown`, `${owner}/50% off?#old`,
    `${owner}/nested/another/file.without-known-extension`, `${userId}/historical filename.anything`, `${userId}.png`];
  const e = edge({ avatarPath: `${userId}.png`, objects });
  await completesTwice(e);
  assert.equal(e.stored.size, 0);
  assert.deepEqual(new Set(e.removed), new Set(objects));
});

test("real handleExecute skips unsafe listing entries and advances past more than one page", async () => {
  const objects = Array.from({ length: 1001 }, (_, i) => `${owner}/safe-${i}`);
  const invalidEntries = [{ name: ".." }, { name: "%252e%252e/victim" }, { name: "a\\..\\victim" }, { bad: "entry" }];
  const e = edge({ pathSource: "cached job", avatarPath: `${owner}-collision/victim`, objects, invalidEntries });
  await completesTwice(e);
  assert.equal(e.stored.size, 0);
  assert.equal(new Set(e.removed).size, objects.length);
  assert.ok(e.listCalls.some(call => call.offset > 0));
});

test("real handleExecute bounds repeated stale listing pages and still completes", async () => {
  const e = edge({ stale: true, avatarPath: `${core.encodeAvatarOwnerKey(foreignId)}/victim` });
  await completesTwice(e);
  assert.equal(e.listCalls.filter(call => call.prefix === owner).length, 2);
});

test("real handleExecute completes even when stale pages keep changing forever", async () => {
  const e = edge({ changingPages: true, avatarPath: `${foreignId}/victim` });
  await completesTwice(e);
  assert.equal(e.listCalls.filter(call => call.prefix === owner).length, 250);
});

test("real handleExecute missing objects remain idempotent and operational failures retry cached paths", async () => {
  const missing = edge({ avatarPath: `${userId}.png` });
  await completesTwice(missing);
  const e = edge({ avatarPath: `${userId}.png`, objects: [`${userId}.png`], failRemoveOnce: true });
  const failed = await e.execute();
  assert.equal(failed.status, 500);
  assert.equal((await failed.json()).code, "storage_cleanup_failed");
  assert.equal(e.job.data_deleted_at, null);
  assert.equal(e.job.legacy_avatar_path, `${userId}.png`);
  await completesTwice(e);
  assert.equal(e.profileReads(), 1);
  assert.equal(e.stored.size, 0);
});

test("real handleExecute tolerates an object disappearing between listing and remove", async () => {
  const e = edge({ avatarPath: `${foreignId}/victim`, objects: [`${owner}/racing object`], vanishOnRemove: true });
  await completesTwice(e);
  assert.equal(e.stored.size, 0);
});

test("real handleExecute checks deletion token before completed idempotence", async () => {
  const e = edge();
  await completesTwice(e);
  const res = await e.execute("wrong-token");
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "claim_conflict");
});
