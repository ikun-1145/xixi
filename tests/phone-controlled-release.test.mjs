import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { buildControlledRelease, BASELINE_NORMALIZED_SHA, patchOtp } from '../scripts/build-controlled-phone-release.mjs';
import { signedAdmission } from '../workers/phone-auth/otp-admission.js';
import { deploymentPreflight, PHONE_SECRET_NAMES } from '../scripts/check-phone-deployment.mjs';
const built = await buildControlledRelease();
const directory = await mkdtemp(join(tmpdir(), 'sunland-controlled-tests-'));
after(() => rm(directory, { recursive: true, force: true }));
const workers = {};
for (const [name, code] of Object.entries(built.bundles)) {
  const path = join(directory, name + '.mjs'); await writeFile(path, code);
  workers[name] = await import(pathToFileURL(path));
}
test('minimal baseline excludes unrelated changes and retains DO migrations in all fallback profiles', () => {
  assert.equal(built.manifest.baselineNormalizedSha256, BASELINE_NORMALIZED_SHA);
  for (const profile of ['main', 'rollback', 'legacy-bridge']) {
    assert.ok(!built.bundles[profile].includes('api.deepseek.com/v1/web_search'));
    assert.ok(!built.bundles[profile].includes('web_search_status'));
    assert.equal(typeof workers[profile].PhoneAuthCoordinator, 'function');
    assert.equal(typeof workers[profile].default.scheduled, 'function');
    assert.deepEqual(built.configs[profile].durable_objects, built.configs.main.durable_objects);
    assert.deepEqual(built.configs[profile].migrations, built.configs.main.migrations);
    assert.equal(built.configs[profile].keep_vars, true);
    assert.equal(built.configs[profile].no_bundle, true);
    assert.equal(built.configs[profile].vars.PHONE_SMS_ENABLED, 'false');
    assert.deepEqual(built.configs[profile].triggers.crons, ['*/5 * * * *']);
  }
});
test('baseline patch fails closed when an approved anchor is absent or repeated', () => {
  for (const text of ['', '    const body = parsedBody.value;'.repeat(2)]) assert.throws(() => patchOtp(text, text));
});
test('preflight preserves production KV, flags and DO identity, and distinguishes missing runtime provisioning', () => {
  const inventory = { versions: [{ version_id: 'f405a850-780d-483f-8942-83e1798711fe', percentage: 100 }], bindings: built.configs.main.kv_namespaces.map(b => ({ name: b.binding, namespace_id: b.id })) };
  const result = deploymentPreflight(built.configs, inventory, true);
  assert.equal(result.local_configuration_valid, true);
  for (const name of PHONE_SECRET_NAMES) assert.ok(result.production_provisioning_required.phone_canary.includes(name));
  const bad = structuredClone(built.configs); bad.rollback.migrations[0].tag = 'reset';
  assert.equal(deploymentPreflight(bad, inventory).local_configuration_valid, false);
  assert.equal(deploymentPreflight(built.configs, { bindings: [] }).local_configuration_valid, false);
});
const routes = ['send-code', 'verify-code', 'status', 'reauth/email', 'reauth/phone', 'bind', 'change', 'unbind', 'delete-authorize', 'initialize', 'unknown'];
for (const profile of ['main', 'rollback', 'legacy-bridge']) test(`${profile}: every phone entry stays closed; OPTIONS remains harmless`, async t => {
  let calls = 0;
  const network = mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({}); });
  t.after(() => network.mock.restore());
  for (const route of routes) {
    const env = profile === 'main' ? {} : { PHONE_IDENTITY_ENABLED: 'true', PHONE_SMS_ENABLED: 'true' };
    const response = await workers[profile].default.fetch(new Request('https://api.sunland.dev/v1/phone/' + route, { method: 'POST', body: 'not even JSON' }), env, {});
    assert.equal(response.status, 503); assert.equal((await response.json()).code, 'IDENTITY_DISABLED');
  }
  const preflight = await workers[profile].default.fetch(new Request('https://api.sunland.dev/v1/phone/status', { method: 'OPTIONS' }), {}, {});
  assert.equal(preflight.status, 200); assert.equal(calls, 0);
  for (const path of ['/send-code', '/verify-code']) {
    const response = await workers[profile].default.fetch(new Request('https://api.sunland.dev' + path, { method: 'POST', body: '{}' }), {}, {});
    assert.equal(response.status, 503);
  }
  assert.equal(calls, 0);
});
test('main and rollback use actual atomic OTP SQL and preserve email ID/JWT/refresh/database token/Pro', async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
  const root = process.env.SUNLAND_AUTH_WORKER_ROOT || resolve(import.meta.dirname, '../../../sunland_ai_app/worker');
  await db.exec(await readFile(resolve(root, '../supabase/migrations/20261021010000_atomic_email_otp.sql'), 'utf8'));
  await db.exec('set role service_role');
  const env = { OTP_GATEWAY_AUTH_KEY: 'synthetic-ingress-secret-at-least-32-bytes', APP_JWT_LEGACY_SECRET: 'synthetic-jwt-secret',
    SUPABASE_PROJECT_URL: 'https://database.test.invalid', SUPABASE_SECRET_KEY: 'sb_secret_synthetic', SUPABASE_LEGACY_JWT_SECRET: 'synthetic-db-jwt',
    GEETEST_ID: 'synthetic', GEETEST_SERVER_KEY: 'synthetic', RESEND_API_TOKEN: 'synthetic',
    CODE_STORE: { get() { throw Error('KV must not be used'); }, put() { throw Error('KV must not be used'); } } };
  const claimed = new Set();
  env.OTP_MAINTENANCE = { getByName() { return { async fetch(_url, options) {
    const { id } = JSON.parse(options.body);
    if (claimed.has(id)) return new Response(null, { status: 409 });
    claimed.add(id); return new Response(null, { status: 200 });
  } }; } };
  const profile = { user_id: 'existing-owner', email: 'owner@example.test', pro: true, is_banned: false, identity_status: 'active', onboarding_version: 1, onboarding_step: 3 };
  let delivered, mails = 0, unknown = 0;
  const network = mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(input); const args = init.body ? JSON.parse(init.body.startsWith('{') ? init.body : '{}') : {};
    if (url.hostname === 'gcaptcha4.geetest.com') return Response.json({ result: 'success' });
    if (url.hostname === 'api.resend.com') { mails++; delivered = args.html.match(/\b[1-9]\d{5}\b/)[0]; return Response.json({ id: 'synthetic' }); }
    if (url.hostname === 'database.test.invalid') {
      if (url.pathname.endsWith('/rpc/sunland_otp')) {
        const result = await db.query('select public.sunland_otp($1,$2,$3,$4,$5,$6) as value',
          [args.p_action, args.p_subject, args.p_ip, args.p_request_id || null, args.p_code_hash || null, args.p_delivery || null]);
        return Response.json(result.rows[0].value);
      }
      if (url.pathname === '/rest/v1/user_profiles') { assert.ok(!init.method || init.method === 'GET'); return Response.json([profile]); }
    }
    unknown++; return new Response(null, { status: 599 });
  });
  t.after(() => network.mock.restore());
  const decode = jwt => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url'));
  for (const name of ['main', 'rollback']) {
    const email = name + '@example.test';
    const invoke = async (path, body, token, sign = true) => {
      const text = JSON.stringify(body); const headers = { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1' };
      if (token) headers.Authorization = 'Bearer ' + token;
      if (sign) headers['X-Sunland-Otp-Admission'] = await signedAdmission(env.OTP_GATEWAY_AUTH_KEY, path, text, crypto.randomUUID(), 1);
      return workers[name].default.fetch(new Request('https://api.sunland.dev' + path, { method: 'POST', headers, body: text }), env, {});
    };
    assert.equal((await invoke('/send-code', { email }, null, false)).status, 503);
    assert.equal((await invoke('/send-code', { email, token: JSON.stringify({ lot_number: 'fixture', captcha_output: 'fixture', pass_token: 'fixture', gen_time: 'fixture' }) })).status, 200);
    const loggedIn = await invoke('/verify-code', { email, code: delivered }); assert.equal(loggedIn.status, 200);
    const result = await loggedIn.json(); assert.equal(result.user.id, profile.user_id); assert.equal(result.is_new_user, false);
    assert.equal(decode(result.token).id, profile.user_id);
    assert.equal((await invoke('/verify-code', { email, code: delivered })).status, 400);
    const refresh = await invoke('/refresh', {}, result.token); assert.equal(refresh.status, 200);
    assert.equal(decode((await refresh.json()).token).id, profile.user_id);
    const database = await invoke('/v1/database-token', {}, result.token); assert.equal(database.status, 200);
    const dbClaims = decode((await database.json()).token); assert.equal(dbClaims.sub, profile.user_id); assert.equal(dbClaims.role, 'authenticated');
    assert.equal(profile.pro, true);
  }
  assert.equal(mails, 2); assert.equal(unknown, 0);
});
