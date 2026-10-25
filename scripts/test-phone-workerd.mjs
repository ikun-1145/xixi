// Real local workerd + SQLite DO. All outbound traffic is intercepted below.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { preparePhoneWorker } from './prepare-phone-worker.mjs';
import { prepareStandalonePhoneWorker } from './build-phone-auth-worker.mjs';
import { SINGLETON_NAME } from '../workers/phone-auth/coordinator.js';

const require = createRequire(process.env.SUNLAND_AUTH_WORKER_ROOT
  ? resolve(process.env.SUNLAND_AUTH_WORKER_ROOT, 'package.json')
  : new URL('../../../sunland_ai_app/worker/package.json', import.meta.url));
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = require('miniflare');
const root = await mkdtemp(join(tmpdir(), 'sunland-phone-workerd-'));
const secret = 'synthetic-workerd-hmac-secret-at-least-32';
const admin = 'synthetic-workerd-admin-token-at-least-32';
let runtime, supplierCalls = 0, captchaCalls = 0, unexpectedOutbound = 0;
try {
  const prepare = process.argv.includes('--standalone') ? prepareStandalonePhoneWorker : preparePhoneWorker;
  const prepared = await prepare(join(root, 'prepared'));
  await assert.rejects(prepare(join(root, 'prepared')), { code: 'EEXIST' });
  for (const key of ['PHONE_IDENTITY_ENABLED', 'PHONE_SMS_ENABLED', 'PHONE_NEW_REGISTRATION_ENABLED']) {
    assert.equal(prepared.config.vars[key], 'false');
  }
  assert.deepEqual(prepared.config.routes, process.argv.includes('--standalone') ? [{ pattern: 'api.sunland.dev/v1/phone/*', zone_name: 'sunland.dev' }] : []);
  assert.deepEqual(prepared.config.triggers.crons, []);
  assert.equal(prepared.config.workers_dev, false);
  assert.ok(!prepared.config.kv_namespaces && !prepared.config.services);

  const phones = ['13800000000', '13800000001', '13800000002', '13800000003'];
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const hashes = await Promise.all(phones.map(async p => Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`phone\0${p}`))).toString('hex')));
  const bindings = { ...prepared.config.vars, PHONE_RELEASE_MODE: 'canary',
    PHONE_AUTH_HMAC_KEY: secret, PHONE_AUTH_HMAC_KEY_ID: 'synthetic-v1', PHONE_AUTH_ADMIN_TOKEN: admin,
    PHONE_SMS_CANARY_PHONE_HASHES: JSON.stringify(hashes), TURNSTILE_SECRET: 'synthetic-only', PHONE_TURNSTILE_HOSTNAME: 'sunland.dev',
    PHONE_ALIYUN_ACCESS_KEY_ID: 'synthetic', PHONE_ALIYUN_ACCESS_KEY_SECRET: 'synthetic',
    PHONE_SMS_SIGN_NAME: 'synthetic', PHONE_SMS_TEMPLATE_CODE: 'synthetic',
    PHONE_AUTH_POLICY: JSON.stringify({ perPhoneDaily: 10, perIpDaily: 20, dailyLimit: 20,
      unitCostMicros: 1, dailyBudgetMicros: 20, totalBudgetMicros: 100, ipRequestsPerMinute: 50, globalRequestsPerMinute: 100 }) };
  const options = { name: prepared.config.name, script: prepared.code, modules: true,
    compatibilityDate: prepared.config.compatibility_date, host: '127.0.0.1', port: 0,
    log: new Log(LogLevel.ERROR), cf: false, bindings,
    durableObjects: { PHONE_AUTH_COORDINATOR: { className: 'PhoneAuthCoordinator', useSQLite: true } },
    resourcePersistencePath: join(root, 'state'),
    outboundService: async request => {
      const url = new URL(request.url);
      if (url.hostname === 'challenges.cloudflare.com') {
        captchaCalls++;
        return Response.json({ success: true, hostname: 'sunland.dev', action: 'phone_login', challenge_ts: new Date().toISOString() });
      }
      if (url.hostname !== 'dypnsapi.aliyuncs.com') {
        unexpectedOutbound++;
        throw Error('unexpected outbound traffic blocked');
      }
      supplierCalls++;
      return Response.json({ Success: true, Code: 'OK', Model: { VerifyResult: 'PASS' } });
    } };
  runtime = new Miniflare(convertV4MiniflareOptions(options));
  const publicRequest = path => runtime.dispatchFetch('http://local.test' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const off = await publicRequest('/v1/phone/send-code');
  assert.equal(off.status, 503); assert.equal((await off.json()).code, 'IDENTITY_DISABLED');
  assert.equal(supplierCalls + captchaCalls, 0);
  let namespace = await runtime.getDurableObjectNamespace('PHONE_AUTH_COORDINATOR');
  let stub = namespace.getByName(SINGLETON_NAME);
  const post = (path, body = {}, token = admin) => stub.fetch('https://phone-auth.internal/' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
  assert.equal((await post('status')).status, 503); // No implicit fresh ledger.
  assert.equal((await post('initialize', {}, 'wrong')).status, 401);
  const initialized = await Promise.all([post('initialize'), post('initialize')]);
  assert.deepEqual(initialized.map(r => r.status).sort(), [200, 409]);
  assert.equal((await post('send', { input: { phone: phones[0], purpose: 'login', turnstile_token: 'synthetic' }, context: { ip: '192.0.2.1' } })).status, 503);
  assert.equal(supplierCalls + captchaCalls, 0);

  // A fresh runtime reopens the same SQLite store. Only synthetic SMS gate changes.
  await runtime.dispose(); runtime = undefined;
  bindings.PHONE_SMS_ENABLED = 'true';
  runtime = new Miniflare(convertV4MiniflareOptions(options));
  namespace = await runtime.getDurableObjectNamespace('PHONE_AUTH_COORDINATOR'); stub = namespace.getByName(SINGLETON_NAME);
  assert.equal((await post('initialize')).status, 409);
  const sends = await Promise.all(phones.map(phone => post('send', { input: { phone, purpose: 'login', turnstile_token: 'synthetic' }, context: { ip: '192.0.2.1' } })));
  assert.equal(sends.filter(r => r.status === 200).length, 3);
  assert.equal(sends.filter(r => r.status === 429).length, 1);
  assert.equal(supplierCalls, 3);
  const i = sends.findIndex(r => r.status === 200), challenge = await sends[i].json();
  const check = () => post('check', { input: { phone: phones[i], purpose: 'login', challenge_id: challenge.challenge_id, code: '123456' }, context: { ip: '192.0.2.1' } });
  const checks = await Promise.all([check(), check()]);
  assert.deepEqual(checks.map(r => r.status).sort(), [200, 409]);
  assert.equal(supplierCalls, 4);
  assert.equal(unexpectedOutbound, 0);
  const before = await (await post('status')).json(); assert.equal(before.test_reserved, 3); assert.equal(before.total_micros, 3);
  await runtime.dispose(); runtime = new Miniflare(convertV4MiniflareOptions(options));
  namespace = await runtime.getDurableObjectNamespace('PHONE_AUTH_COORDINATOR'); stub = namespace.getByName(SINGLETON_NAME);
  assert.equal((await post('initialize')).status, 409);
  assert.deepEqual(await (await post('status')).json(), before);
  const capped = await post('send', { input: { phone: phones[3], purpose: 'login', turnstile_token: 'synthetic' }, context: { ip: '192.0.2.1' } });
  assert.equal(capped.status, 429); assert.equal((await capped.json()).code, 'CANARY_LIMITED');
  assert.equal(supplierCalls, 4);
  console.log(JSON.stringify({ passed: true, runtime: 'local workerd SQLite DO', default_off: true,
    persistent_ledger: true, concurrent_init: true, canary_cap: true, concurrent_replay_rejected: true,
    real_network_calls: 0, production_resources_used: false }));
} finally {
  if (runtime) await runtime.dispose();
  await rm(root, { recursive: true, force: true });
}
