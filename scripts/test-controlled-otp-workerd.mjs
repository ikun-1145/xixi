import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { buildControlledRelease } from './build-controlled-phone-release.mjs';
import { validAdmission, bodyHash } from '../workers/phone-auth/otp-admission.js';
const workerRoot = process.env.SUNLAND_AUTH_WORKER_ROOT || resolve(import.meta.dirname, '../../..', 'sunland_ai_app/worker');
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = createRequire(resolve(workerRoot, 'package.json'))('miniflare');
const root = await mkdtemp(join(tmpdir(), 'sunland-otp-gate-'));
const admin = 'synthetic-otp-admin-independent-32-bytes';
const ingress = 'synthetic-otp-ingress-independent-32-bytes';
const phoneAdmin = 'synthetic-phone-admin-independent-32-bytes';
let runtime, originCalls = 0, failOrigin = false, resume, began, waitForOrigin, originAuthority = 'legacy';
try {
  const release = await buildControlledRelease();
  const options = { host: '127.0.0.1', port: 0, cf: false, log: new Log(LogLevel.ERROR), resourcePersistencePath: join(root, 'state'), workers: [
    { name: 'sunland-otp-entry', script: release.bundles.gateway, modules: true, compatibilityDate: '2026-03-21',
      bindings: { OTP_GATEWAY_ADMIN_TOKEN: admin, OTP_GATEWAY_AUTH_KEY: ingress, OTP_TEST_EMAIL: 'operator@example.test', OTP_TEST_IPS: '192.0.2.1,127.0.0.1', PHONE_AUTH_ADMIN_TOKEN: phoneAdmin },
      durableObjects: { OTP_MAINTENANCE: { className: 'OtpMaintenanceGate', useSQLite: true },
        PHONE_AUTH_COORDINATOR: { className: 'PhoneAuthCoordinator', scriptName: 'ai', useSQLite: true } },
      serviceBindings: { ORIGIN: async request => {
        originCalls++;
        if (!new URL(request.url).pathname.startsWith('/send-code') && !new URL(request.url).pathname.startsWith('/verify-code')) return new Response('existing-business');
        assert.equal(request.headers.has('Authorization'), false, 'operator credential must not reach origin');
        const text = await request.text();
        assert.equal(await validAdmission(ingress, request, text), true);
        const [id, generation] = request.headers.get('X-Sunland-Otp-Admission').split('.');
        const namespace = await runtime.getDurableObjectNamespace('OTP_MAINTENANCE', 'sunland-otp-entry');
        const stub = namespace.getByName('sunland-otp-gate-v1');
        const claim = async (authority = originAuthority) => stub.fetch('https://otp-gate.internal/__internal/claim', { method: 'POST',
          headers: { Authorization: 'Bearer ' + ingress },
          body: JSON.stringify({ id, generation: Number(generation), path: new URL(request.url).pathname, hash: await bodyHash(text, ingress), authority }) });
        assert.equal((await claim(originAuthority === 'legacy' ? 'rpc' : 'legacy')).status, 409);
        assert.equal((await claim()).status, 200); assert.equal((await claim()).status, 409);
        if (waitForOrigin) { began(); await new Promise(r => { resume = r; }); }
        if (failOrigin) throw Error('synthetic transport failure');
        return Response.json({ ok: true });
      } }, outboundService: () => { throw Error('Live network forbidden'); } },
    { name: 'ai', script: release.bundles.main, modules: true, compatibilityDate: '2026-03-21',
      bindings: { PHONE_AUTH_ADMIN_TOKEN: phoneAdmin, PHONE_AUTH_HMAC_KEY: 'synthetic-phone-hmac-key-at-least-32-bytes', PHONE_AUTH_HMAC_KEY_ID: 'test-v1',
        PHONE_RELEASE_MODE: 'canary', PHONE_SMS_CANARY_PHONE_HASHES: JSON.stringify(['a'.repeat(64)]), PHONE_SMS_ENABLED: 'false', PHONE_IDENTITY_ENABLED: 'false' },
      durableObjects: { PHONE_AUTH_COORDINATOR: { className: 'PhoneAuthCoordinator', useSQLite: true } },
      outboundService: () => { throw Error('Live network forbidden'); } },
  ] };
  runtime = new Miniflare(convertV4MiniflareOptions(options));
  const request = (path, body = {}, token) => runtime.dispatchFetch('https://api.sunland.dev' + path, { method: 'POST', headers: {
    'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
  const command = (action, body = {}, token = admin) => request('/__ops/otp/' + action, body, token);
  const status = async () => { const r = await command('status'); assert.equal(r.status, 200); return r.json(); };
  assert.equal((await request('/send-code')).status, 503); assert.equal(originCalls, 0);
  assert.equal((await command('open', {}, 'wrong')).status, 401);
  assert.equal((await command('open', { generation: 1 })).status, 503);
  assert.equal((await status()).legacy_before_gateway, 'UNKNOWN');
  assert.equal((await command('resume-legacy', { generation: 1 })).status, 200);
  assert.equal((await request('/send-code', { email: 'operator@example.test' })).status, 200);
  assert.equal((await command('close')).status, 200);
  assert.equal((await status()).legacy_before_gateway, 'UNKNOWN');
  assert.equal((await command('attest-legacy', { version: 'wrong', reference: 'synthetic://external-proof' })).status, 503);
  // Synthetic external attestation is local fixture data, never a production proof.
  assert.equal((await command('attest-legacy', { version: 'f405a850-780d-483f-8942-83e1798711fe', reference: 'synthetic://external-proof' })).status, 200);
  assert.equal((await command('canary', { generation: 99 })).status, 503);
  assert.equal((await command('canary', { generation: (await status()).generation })).status, 200);
  assert.equal((await request('/send-code', { email: 'operator@example.test' })).status, 503);
  assert.equal((await request('/send-code', { email: 'other@example.test' }, admin)).status, 503);
  assert.equal(originCalls, 1);
  assert.equal((await request('/send-code', { email: 'operator@example.test' }, admin)).status, 200);
  assert.equal((await status()).terminal, 2);
  assert.equal((await command('close')).status, 200);
  const closed = await status(); assert.equal(closed.drained, true);
  const switched = await (await command('switch-rpc', { generation: closed.generation })).json();
  assert.equal(switched.authority, 'rpc'); originAuthority = 'rpc';
  assert.equal((await command('resume-legacy', { generation: switched.generation })).status, 503);
  assert.equal((await command('open', { generation: switched.generation })).status, 200);
  waitForOrigin = new Promise(r => { began = r; });
  const pending = request('/verify-code', { email: 'operator@example.test', code: '123456' });
  await waitForOrigin;
  assert.equal((await command('close')).status, 200);
  const busy = await status(); assert.equal(busy.pending, 1); assert.equal(busy.drained, false);
  assert.equal((await command('open', { generation: busy.generation })).status, 503);
  assert.equal((await request('/send-code')).status, 503);
  waitForOrigin = null; resume(); resume = undefined;
  assert.equal((await pending).status, 200);
  const drained = await status(); assert.equal(drained.pending, 0); assert.equal(drained.drained, true);
  assert.equal((await request('/__ops/phone/initialize', {}, 'wrong')).status, 401);
  assert.equal((await request('/__ops/phone/initialize', {}, phoneAdmin)).status, 200);
  assert.equal((await request('/__ops/phone/initialize', {}, phoneAdmin)).status, 409);
  const ledger = await (await request('/__ops/phone/status', {}, phoneAdmin)).json(); assert.equal(ledger.total_micros, 0);
  await runtime.dispose(); runtime = new Miniflare(convertV4MiniflareOptions(options));
  assert.deepEqual(await status(), drained);
  assert.equal((await command('open', { generation: drained.generation })).status, 200);
  failOrigin = true;
  assert.equal((await request('/send-code', { email: 'operator@example.test' })).status, 503);
  assert.equal((await command('close')).status, 200);
  const unknown = await status(); assert.equal(unknown.unknown, 1); assert.equal(unknown.pending, 1); assert.equal(unknown.drained, false);
  await runtime.dispose(); runtime = new Miniflare(convertV4MiniflareOptions(options));
  assert.deepEqual(await status(), unknown);
  assert.equal((await command('open', { generation: unknown.generation })).status, 503);
  console.log(JSON.stringify({ passed: true, runtime: 'workerd SQLite', default_block: true, private_canary: true,
    admitted_before_effect: true, close_fences_new_work: true, unknown_survives_restart: true, phone_private_initialization: true,
    legacy_proof: 'synthetic fixture only; production remains UNKNOWN', real_network_calls: 0 }));
} finally {
  resume?.();
  if (runtime) await runtime.dispose();
  await rm(root, { recursive: true, force: true });
}
