import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import * as core from '../supabase/functions/sunland-account-delete/account-delete-core.js';

// Exercise the real Edge router and authorization handler with synthetic I/O.
const source = readFileSync(new URL('../supabase/functions/sunland-account-delete/index.ts', import.meta.url), 'utf8')
  .replace(/^import\s+[\s\S]*?\sfrom\s+"[^"]+";\s*$/gm, '');
const userId = '11111111-1111-4111-8111-111111111111';
const foreignId = '22222222-2222-4222-8222-222222222222';
const email = 'new@example.test';

function edge(otpUserId, otpStatus = 200) {
  const jobs = [], calls = [];
  const admin = { from(table) {
    assert.equal(table, 'account_deletion_jobs');
    return { insert(job) {
      jobs.push(job);
      return { select() { return { async single() { return { data: { id: 'fixture-job' }, error: null }; } }; } };
    } };
  } };
  let handler;
  vm.runInNewContext(stripTypeScriptTypes(source), {
    ...core, Request, Response, Headers, URL, TextEncoder, TextDecoder, crypto, Date, Error, btoa, atob,
    createClient: () => admin,
    Deno: { env: { get: () => 'fixture-server-config' }, serve: fn => { handler = fn; } },
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path === '/v1/account-delete/identity') {
        assert.equal(init.headers.Authorization, 'Bearer fixture-session');
        return Response.json({ user_id: userId, identity_status: 'active', is_banned: false });
      }
      assert.equal(path, '/verify-code');
      assert.deepEqual(JSON.parse(init.body), { email, code: '123456' });
      return otpStatus === 200 ? Response.json({ user: { id: otpUserId, email } })
        : Response.json({ error: 'invalid' }, { status: otpStatus });
    },
  });
  return { jobs, calls, authorize: () => handler(new Request('https://offline.test/delete', {
    method: 'POST', headers: { Authorization: 'Bearer fixture-session', 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'authorize', email, code: '123456', user_id: foreignId }),
  })) };
}

test('email verification for the same registered user authorizes that user only', async () => {
  const e = edge(userId);
  const response = await e.authorize();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.deletion_job_id, 'fixture-job');
  assert.equal(body.expires_in, 600);
  assert.equal(e.jobs.length, 1);
  assert.equal(e.jobs[0].user_id, userId);
  assert.equal(e.jobs[0].token_hash, createHash('sha256').update(body.deletion_token).digest('hex'));
  assert.deepEqual(e.calls, ['/v1/account-delete/identity', '/verify-code']);
});

test('email verification belonging to another user cannot authorize deletion', async () => {
  const e = edge(foreignId);
  const response = await e.authorize();
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'identity_mismatch');
  assert.equal(e.jobs.length, 0);
});

test('an invalid email code creates no deletion authorization', async () => {
  const e = edge(userId, 401);
  const response = await e.authorize();
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, 'otp_invalid');
  assert.equal(e.jobs.length, 0);
});
