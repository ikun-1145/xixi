// Local workerd + SQLite only. Outbound requests are intercepted with synthetic data.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { buildStandalonePhoneWorker } from '../../../scripts/build-phone-auth-worker.mjs';
import { SINGLETON_NAME } from '../coordinator.js';
const project = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(resolve(process.env.SUNLAND_AUTH_WORKER_ROOT || resolve(project, '../../sunland_ai_app/worker'), 'package.json'));
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = require('miniflare');
const { code: script } = await buildStandalonePhoneWorker();
const root = await mkdtemp(join(tmpdir(), 'phone-relay-workerd-'));
const secret = 'synthetic-runtime-hmac-key-at-least-32';
const admin = 'synthetic-runtime-admin-token-at-least-32';
const phones = Array.from({ length: 8 }, (_, i) => `1380000000${i}`);
const bindings = { PHONE_SMS_ENABLED: 'true', PHONE_IDENTITY_ENABLED: 'false', PHONE_NEW_REGISTRATION_ENABLED: 'false',
  PHONE_SMS_PROVIDER: 'relay', SMS_RELAY_URL: 'https://relay.invalid/send', SUNLAND_SMS_RELAY_KEY: 'synthetic-runtime-relay-key',
  PHONE_RELEASE_MODE: 'public', PHONE_AUTH_HMAC_KEY: secret, PHONE_AUTH_HMAC_KEY_ID: 'v1', PHONE_AUTH_ADMIN_TOKEN: admin,
  TURNSTILE_SECRET: 'synthetic', PHONE_TURNSTILE_HOSTNAME: 'sunland.dev',
  PHONE_ALIYUN_ACCESS_KEY_ID: 'synthetic', PHONE_ALIYUN_ACCESS_KEY_SECRET: 'synthetic', PHONE_SMS_SIGN_NAME: 'synthetic', PHONE_SMS_TEMPLATE_CODE: 'synthetic',
  PHONE_AUTH_POLICY: JSON.stringify({ perPhoneDaily: 10, perIpDaily: 20, dailyLimit: 20,
    unitCostMicros: 7, dailyBudgetMicros: 140, totalBudgetMicros: 140, ipRequestsPerMinute: 100, globalRequestsPerMinute: 200 }) };
let runtime, stub, relayCalls = 0, aliyunCalls = 0, unexpected = 0, failure = false, timeout = false;
const messages = new Map();
const options = { name: 'phone-auth', script, modules: true, compatibilityDate: '2026-03-21',
  host: '127.0.0.1', port: 0, log: new Log(LogLevel.ERROR), cf: false, bindings,
  durableObjects: { PHONE_AUTH_COORDINATOR: { className: 'PhoneAuthCoordinator', useSQLite: true } },
  resourcePersistencePath: join(root, 'state'), outboundService: async request => {
    const url = new URL(request.url);
    if (url.hostname === 'challenges.cloudflare.com') {
      const body = await request.json();
      return Response.json({ success: true, hostname: 'sunland.dev', action: `phone_${body.response}`, challenge_ts: new Date().toISOString() });
    }
    if (url.hostname === 'relay.invalid') {
      relayCalls++; const body = await request.json();
      assert.deepEqual(Object.keys(body).sort(), ['api_key', 'code', 'phone', 'scene']);
      assert.equal(body.api_key, bindings.SUNLAND_SMS_RELAY_KEY); assert.equal(body.scene, 'login'); assert.match(body.code, /^\d{6}$/);
      messages.set(body.phone, body.code);
      if (timeout) return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{')); } }));
      return Response.json({ ok: failure ? 0 : 1 });
    }
    if (url.hostname === 'dypnsapi.aliyuncs.com') {
      aliyunCalls++; return Response.json({ Success: true, Code: 'OK', Model: { VerifyResult: 'PASS' } });
    }
    unexpected++; throw Error('Unexpected network request blocked');
  } };
async function start() {
  runtime = new Miniflare(convertV4MiniflareOptions(options));
  stub = (await runtime.getDurableObjectNamespace('PHONE_AUTH_COORDINATOR')).getByName(SINGLETON_NAME);
}
async function restart() { await runtime.dispose(); runtime = undefined; await start(); }
const post = (path, body = {}) => stub.fetch('https://internal/' + path, { method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + admin }, body: JSON.stringify(body) });
const context = { ip: '192.0.2.1' };
const send = (phone, purpose = 'login', ctx = context) => post('send', { input: { phone, purpose, turnstile_token: purpose }, context: ctx });
const check = (phone, id, code = messages.get(phone), purpose = 'login', ctx = context) => post('check', {
  input: { phone, purpose, code, challenge_id: id }, context: ctx });
try {
  await start(); assert.equal((await post('initialize')).status, 200);
  const sends = await Promise.all([send(phones[0]), send(phones[0])]);
  assert.equal(sends.filter(r => r.status === 200).length, 1);
  // During the supplier call the existing phone lock is still quarantined;
  // after completion it is rate limited. Both reject duplicate sends.
  assert.ok(sends.some(r => [429, 503].includes(r.status))); assert.equal(relayCalls, 1);
  const first = await sends.find(r => r.status === 200).json();
  await restart(); assert.equal((await post('initialize')).status, 409);
  const checks = await Promise.all([check(phones[0], first.challenge_id), check(phones[0], first.challenge_id)]);
  assert.deepEqual(checks.map(r => r.status).sort(), [200, 409]);
  assert.equal((await check(phones[0], first.challenge_id)).status, 409);

  const second = await (await send(phones[1])).json();
  const correct = messages.get(phones[1]), wrong = correct === '000000' ? '000001' : '000000';
  for (let i = 0; i < 5; i++) assert.equal((await check(phones[1], second.challenge_id, wrong)).status, 400);
  assert.equal((await check(phones[1], second.challenge_id)).status, 409);

  const third = await (await send(phones[2])).json();
  bindings.PHONE_SMS_PROVIDER = 'aliyun'; delete bindings.SMS_RELAY_URL; delete bindings.SUNLAND_SMS_RELAY_KEY;
  await restart(); assert.equal((await check(phones[2], third.challenge_id)).status, 200); assert.equal(aliyunCalls, 0);
  const fourth = await (await send(phones[3])).json(); assert.equal(aliyunCalls, 1);
  bindings.PHONE_SMS_PROVIDER = 'relay'; bindings.SMS_RELAY_URL = 'https://relay.invalid/send'; bindings.SUNLAND_SMS_RELAY_KEY = 'synthetic-runtime-relay-key';
  await restart(); assert.equal((await check(phones[3], fourth.challenge_id, '123456')).status, 200); assert.equal(aliyunCalls, 2);

  const auth = { ...context, userId: 'user', sessionId: 'synthetic-session-1234', identityStatus: 'active', reauthentication: true };
  const reauth = await (await send(phones[4], 'reauth', auth)).json();
  assert.equal((await check(phones[4], reauth.challenge_id)).status, 400);
  assert.equal((await check(phones[4], reauth.challenge_id, messages.get(phones[4]), 'reauth', auth)).status, 200);

  failure = true; assert.equal((await send(phones[5])).status, 503);
  const before = await (await post('status')).json(); assert.equal(before.total_micros, 42);
  await restart(); assert.deepEqual(await (await post('status')).json(), before);
  assert.equal((await send(phones[5])).status, 503); assert.equal(relayCalls, 5);
  failure = false;
  delete bindings.SUNLAND_SMS_RELAY_KEY; await restart();
  assert.equal((await send(phones[6])).status, 503); assert.equal(relayCalls, 5);
  assert.equal((await post('status')).status, 200); assert.equal((await (await post('status')).json()).total_micros, 42);
  bindings.SUNLAND_SMS_RELAY_KEY = 'synthetic-runtime-relay-key'; await restart();
  timeout = true; const started = Date.now();
  const timedOut = await send(phones[6]);
  assert.equal(timedOut.status, 504); assert.equal((await timedOut.json()).code, 'UPSTREAM_TIMEOUT');
  assert.ok(Date.now() - started >= 7900); assert.equal(relayCalls, 6);
  timeout = false; await restart();
  assert.equal((await send(phones[6])).status, 503); assert.equal(relayCalls, 6);
  assert.equal((await (await post('status')).json()).total_micros, 49);
  bindings.PHONE_SMS_ENABLED = 'false'; await restart();
  assert.equal((await send(phones[7])).status, 503); assert.equal(unexpected, 0);
  console.log(JSON.stringify({ passed: true, runtime: 'local workerd + SQLite DO',
    concurrent_send: true, concurrent_consume: true, five_attempt_limit: true, restart: true,
    provider_switch_and_rollback: true, reauth_isolation: true, retained_budget: true,
    quarantine: true, missing_config: true, eight_second_body_timeout: true, emergency_off: true, real_network_calls: 0 }));
} finally {
  if (runtime) await runtime.dispose();
  await rm(root, { recursive: true, force: true });
}
