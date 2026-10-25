import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { buildStandalonePhoneWorker } from '../scripts/build-phone-auth-worker.mjs';

test('standalone phone Worker interoperates with unchanged production KV/AI baseline', async t => {
  const built = await buildStandalonePhoneWorker();
  const dir = await mkdtemp(join(tmpdir(), 'sunland-standalone-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'phone.mjs'), built.code); await writeFile(join(dir, 'ai.mjs'), built.baseline);
  const phone = await import(pathToFileURL(join(dir, 'phone.mjs'))), ai = (await import(pathToFileURL(join(dir, 'ai.mjs')))).default;
  assert.ok(built.code.length < 100000, 'AI/email implementation must tree-shake out');
  for (const marker of ['sunland_otp', 'CODE_STORE', 'OTP_MAINTENANCE', 'api.deepseek.com']) assert.ok(!built.code.includes(marker));
  assert.equal(phone.default.scheduled, undefined);
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create table user_profiles(user_id text primary key,email text,pro boolean not null default false,is_banned boolean not null default false,
      identity_status text not null default 'active',onboarding_version smallint default 0,onboarding_step smallint default 1,created_at timestamptz default now(),
      deletion_job_id uuid,deletion_attempt_id text,deletion_fencing_version bigint default 0,retired_at timestamptz);
    create table account_deletion_jobs(id uuid primary key default gen_random_uuid(),user_id text,token_hash text unique,status text default 'pending',expires_at timestamptz,
      lease_expires_at timestamptz,attempt_id text,fencing_version bigint default 0,data_deleted_at timestamptz,recovery_expires_at timestamptz,created_at timestamptz default now());
    grant select,insert,update,delete on user_profiles,account_deletion_jobs to service_role;
    insert into user_profiles(user_id,email,pro,onboarding_version,onboarding_step) values('existing-email','owner@example.test',true,1,3);`);
  await db.exec(await readFile(new URL('../supabase/migrations/20261024003756_phone_identity.sql', import.meta.url), 'utf8'));
  const secret = 'synthetic-existing-ai-signing-secret';
  let now = Date.now(), captchaAction = 'phone_login', smsCalls = 0, unexpected = 0, mailedCode;
  const env = { APP_JWT_LEGACY_SECRET: secret, SUPABASE_PROJECT_URL: 'https://database.test.invalid', SUPABASE_SECRET_KEY: 'sb_secret_synthetic',
    PHONE_IDENTITY_ENABLED: 'true', PHONE_SMS_ENABLED: 'true', PHONE_NEW_REGISTRATION_ENABLED: 'true',
    PHONE_IDENTITY_LOOKUP_KEY: 'synthetic-lookup-secret-at-least-32-bytes', PHONE_IDENTITY_LOOKUP_KEY_ID: 'v1',
    PHONE_IDENTITY_ENCRYPTION_KEYS: JSON.stringify({ v1: Buffer.alloc(32, 7).toString('base64url') }), PHONE_IDENTITY_ENCRYPTION_KEY_ID: 'v1',
    PHONE_AUTH_HMAC_KEY: 'synthetic-phone-hmac-secret-at-least-32', PHONE_AUTH_HMAC_KEY_ID: 'v1', PHONE_AUTH_ADMIN_TOKEN: 'synthetic-phone-admin-secret-at-least-32',
    PHONE_RELEASE_MODE: 'canary', TURNSTILE_SECRET: 'synthetic', PHONE_TURNSTILE_HOSTNAME: 'sunland.dev',
    PHONE_ALIYUN_ACCESS_KEY_ID: 'synthetic', PHONE_ALIYUN_ACCESS_KEY_SECRET: 'synthetic', PHONE_SMS_SIGN_NAME: 'synthetic', PHONE_SMS_TEMPLATE_CODE: 'synthetic',
    PHONE_AUTH_POLICY: JSON.stringify({ perPhoneDaily: 20, perIpDaily: 40, dailyLimit: 50, unitCostMicros: 1, dailyBudgetMicros: 50, totalBudgetMicros: 100, ipRequestsPerMinute: 100, globalRequestsPerMinute: 200 }) };
  const mac = async (key, value) => Buffer.from(await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), new TextEncoder().encode(value))).toString('hex');
  env.PHONE_SMS_CANARY_PHONE_HASHES = JSON.stringify(await Promise.all(['13800000000', '13800000001'].map(p => mac(env.PHONE_AUTH_HMAC_KEY, 'phone\0' + p))));
  await db.query('update sunland_phone_auth_config set lookup_key_id=$1,lookup_check=$2', ['v1', await mac(env.PHONE_IDENTITY_LOOKUP_KEY, 'sunland-phone-index-canary:v1\0')]);
  await db.exec('set role service_role');
  const kv = new Map(), aiEnv = { ...env, SUPABASE_LEGACY_JWT_SECRET: 'synthetic-db-jwt', RESEND_API_TOKEN: 'synthetic', GEETEST_SERVER_KEY: 'synthetic', GEETEST_ID: 'synthetic', DEEPSEEK_API_KEY: 'synthetic',
    CODE_STORE: { get: async k => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async k => kv.delete(k) } };
  aiEnv.USAGE_KV = aiEnv.CODE_STORE;
  const network = mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(input); const body = typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : {};
    if (url.hostname === 'challenges.cloudflare.com') return Response.json({ success: true, hostname: 'sunland.dev', action: captchaAction, challenge_ts: new Date(now).toISOString() });
    if (url.hostname === 'dypnsapi.aliyuncs.com') { smsCalls++; return Response.json({ Success: true, Code: 'OK', Model: { VerifyResult: 'PASS' } }); }
    if (url.hostname === 'gcaptcha4.geetest.com') return Response.json({ result: 'success' });
    if (url.hostname === 'api.resend.com') { mailedCode = body.html.match(/\b[1-9]\d{5}\b/)[0]; return Response.json({ id: 'synthetic' }); }
    if (url.hostname === 'api.deepseek.com') return new Response('data: {"choices":[{"delta":{"content":"synthetic reply"}}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    if (url.hostname === 'database.test.invalid') {
      if (url.pathname.endsWith('/rpc/sunland_phone_identity')) return Response.json((await db.query('select sunland_phone_identity($1,$2::jsonb) value', [body.p_action, JSON.stringify(body.p_data)])).rows[0].value);
      if (url.pathname === '/rest/v1/user_profiles') {
        assert.ok(!init.method || init.method === 'GET', 'existing profiles must not be mutated by the HTTP adapter');
        const id = url.searchParams.get('user_id')?.slice(3), email = url.searchParams.get('email')?.slice(3);
        return Response.json((await db.query(id ? 'select * from user_profiles where user_id=$1' : 'select * from user_profiles where email=$1', [id || email])).rows);
      }
      if (url.pathname.includes('/rpc/ai_quota_')) {
        const pro = (await db.query('select pro from user_profiles where user_id=$1', [body.p_user_id])).rows[0].pro;
        return Response.json({ code: url.pathname.endsWith('usage') ? 'OK' : url.pathname.endsWith('reserve') ? 'RESERVED' : 'COMMITTED', attempt: 1, date: new Date().toISOString().slice(0, 10), isPro: pro, remain: pro ? -1 : 19, limit: 20 });
      }
    }
    unexpected++; return new Response(null, { status: 599 });
  });
  t.after(() => network.mock.restore());
  const data = new Map(); let tail = Promise.resolve();
  const storage = { async transaction(fn) {
    const previous = tail; let release; tail = new Promise(r => { release = r; }); await previous;
    try { const copy = structuredClone(data); const result = await fn({ get: async k => copy.get(k), put: async (k, v) => copy.set(k, v), delete: async k => copy.delete(k),
      list: async ({ prefix = '', startAfter = '', limit = 32 } = {}) => new Map([...copy].filter(([k]) => k.startsWith(prefix) && k > startAfter).sort().slice(0, limit)) }); data.clear(); for (const pair of copy) data.set(...pair); return result; }
    finally { release(); }
  } };
  const coordinator = new phone.PhoneAuthCoordinator({ storage }, env, { now: () => now });
  env.PHONE_AUTH_COORDINATOR = { getByName() { return { fetch: r => coordinator.fetch(r) }; } };
  const invoke = async (worker, environment, path, body = {}, token) => worker.fetch(new Request('https://api.sunland.dev' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) }), environment, { waitUntil: p => p.catch(() => {}) });
  let token, user, emailToken;
  await t.test('separate Worker cannot serve email/AI or disabled account-linking; admin initializes once', async () => {
    for (const path of ['/send-code', '/verify-code', '/', '/v1/phone/reauth/email', '/v1/phone/bind', '/v1/phone/change', '/v1/phone/unbind']) assert.ok((await invoke(phone.default, env, path)).status >= 400);
    for (const purpose of ['bind', 'change', 'unbind']) assert.equal((await invoke(phone.default, env, '/v1/phone/send-code', { phone: '13800000000', purpose, turnstile_token: 'mock' })).status, 503);
    assert.equal((await invoke(phone.default, env, '/v1/phone/_admin/initialize', {}, 'wrong')).status, 401);
    assert.equal((await invoke(phone.default, env, '/v1/phone/_admin/initialize', {}, env.PHONE_AUTH_ADMIN_TOKEN)).status, 200);
    assert.equal((await invoke(phone.default, env, '/v1/phone/_admin/initialize', {}, env.PHONE_AUTH_ADMIN_TOKEN)).status, 409);
    assert.equal(smsCalls, 0);
  });
  await t.test('unchanged ai baseline still sends and consumes KV email codes', async () => {
    const sent = await invoke(ai, aiEnv, '/send-code', { email: 'owner@example.test', token: JSON.stringify({ lot_number: 'fixture', captcha_output: 'fixture', pass_token: 'fixture', gen_time: 'fixture' }) }); assert.equal(sent.status, 200);
    assert.equal(kv.get('code:owner%40example.test'), mailedCode);
    const verified = await invoke(ai, aiEnv, '/verify-code', { email: 'owner@example.test', code: mailedCode }); assert.equal(verified.status, 200); const login = await verified.json(); assert.equal(login.user.id, 'existing-email'); emailToken = login.token;
    assert.ok(!kv.has('code:owner%40example.test'));
  });
  const send = async number => { const r = await invoke(phone.default, env, '/v1/phone/send-code', { phone: number, purpose: 'login', turnstile_token: 'mock' }); assert.equal(r.status, 200); return (await r.json()).challenge_id; };
  const verify = (number, id) => invoke(phone.default, env, '/v1/phone/verify-code', { phone: number, challenge_id: id, code: '123456', operation_id: crypto.randomUUID() });
  await t.test('phone registration creates a separate null-email ID; replay cannot mint another JWT', async () => {
    const id = await send('13800000000'); const r = await verify('13800000000', id); assert.equal(r.status, 200); const output = await r.json();
    token = output.token; user = output.user.id; assert.notEqual(user, 'existing-email'); assert.equal(output.user.email, null); assert.equal(output.is_new_user, true);
    assert.equal((await verify('13800000000', id)).status, 409);
    assert.equal((await db.query('select count(*)::int n from sunland_phone_identities')).rows[0].n, 1);
    assert.deepEqual((await db.query("select pro,email from user_profiles where user_id='existing-email'")).rows[0], { pro: true, email: 'owner@example.test' });
  });
  await t.test('the production ai baseline accepts phone JWT, profile, database token and Free/Pro usage', async () => {
    for (const path of ['/refresh', '/v1/account/identity', '/v1/database-token']) {
      const r = await invoke(ai, aiEnv, path, {}, token); assert.equal(r.status, 200, path);
      const body = await r.json(); if (path === '/v1/database-token') assert.equal(JSON.parse(Buffer.from(body.token.split('.')[1], 'base64url')).sub, user);
    }
    assert.equal((await (await invoke(ai, aiEnv, '/v1/usage', {}, token)).json()).isPro, false);
    const reply = await invoke(ai, aiEnv, '/', { messages: [{ role: 'user', content: 'synthetic' }], request_id: crypto.randomUUID() }, token);
    assert.equal(reply.status, 200); assert.match(await reply.text(), /synthetic reply/);
    await db.query('update user_profiles set pro=true where user_id=$1', [user]);
    assert.equal((await (await invoke(ai, aiEnv, '/v1/usage', {}, token)).json()).isPro, true);
  });
  await t.test('same number logs into the same account; disabled registration cannot create another', async () => {
    now += 600001; const id = await send('13800000000'); const r = await verify('13800000000', id); const output = await r.json(); assert.equal(output.user.id, user); assert.equal(output.is_new_user, false);
    env.PHONE_NEW_REGISTRATION_ENABLED = 'false'; const denied = await verify('13800000001', await send('13800000001')); assert.equal(denied.status, 403);
    assert.equal((await db.query('select count(*)::int n from user_profiles')).rows[0].n, 2);
    assert.equal((await invoke(phone.default, env, '/v1/phone/send-code', { phone: '13800000001', purpose: 'login', turnstile_token: 'mock' })).status, 429);
  });
  await t.test('phone OFF and RLS fail closed; email session remains usable', async () => {
    env.PHONE_IDENTITY_ENABLED = 'false'; assert.equal((await invoke(phone.default, env, '/v1/phone/verify-code')).status, 503);
    const acl = (await db.query("select has_table_privilege('anon','sunland_phone_identities','SELECT') allowed")).rows[0]; assert.equal(acl.allowed, false);
    const preflight = await phone.default.fetch(new Request('https://api.sunland.dev/v1/phone/send-code', { method: 'OPTIONS' }), env, {}); assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'https://sunland.dev');
    assert.equal((await invoke(ai, aiEnv, '/refresh', {}, token)).status, 200);
    const emailRefresh = await invoke(ai, aiEnv, '/refresh', {}, emailToken); assert.equal(emailRefresh.status, 200); assert.equal((await emailRefresh.json()).user.id, 'existing-email');
  });
  assert.equal(unexpected, 0);
});
