import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PhoneAuthCoordinator, LEDGER_KEY, SINGLETON_NAME } from '../workers/phone-auth/coordinator.js';
import { sendPhoneCode, checkPhoneCode } from '../workers/phone-auth/service.js';

mock.method(globalThis, 'fetch', async () => { throw new Error('Live network is forbidden in SMS tests'); });
const contract = JSON.parse(readFileSync(new URL('../docs/full-stack-development/requirements/mainland-phone-auth/phase-1-contract.schema.json', import.meta.url)));
function assertContract(name, value) {
  const schema = contract.$defs[name];
  for (const key of schema.required) assert.ok(Object.hasOwn(value, key), `${name}.${key} is required`);
  for (const [key, data] of Object.entries(value)) {
    const rule = schema.properties[key];
    assert.ok(rule, `${name}.${key} must be documented`);
    if (Object.hasOwn(rule, 'const')) assert.equal(data, rule.const);
    if (rule.type === 'integer') assert.ok(Number.isInteger(data) && data >= rule.minimum && data <= rule.maximum);
    if (rule.type === 'string') assert.equal(typeof data, 'string');
    if (rule.pattern) assert.match(data, new RegExp(rule.pattern));
    if (rule.enum) assert.ok(rule.enum.includes(data));
  }
}

const START = Date.parse('2026-10-24T00:00:00Z');
const POLICY = { perPhoneDaily: 2, perIpDaily: 3, dailyLimit: 4, unitCostMicros: 100000,
  dailyBudgetMicros: 400000, totalBudgetMicros: 500000, ipRequestsPerMinute: 20, globalRequestsPerMinute: 100 };
const ctx = { ip: '192.0.2.1' };
const phone = '13800000000';
const sensitive = { ...ctx, userId: 'existing-user', sessionId: 'server-token-digest-1234', identityStatus: 'active', reauthenticatedAt: START };
const input = (n = phone, purpose = 'login') => ({ phone: n, purpose, turnstile_token: 'mock-turnstile' });

// Shared transactional store models separate requests/object reconstructions;
// it is deliberately not presented as Cloudflare runtime acceptance.
class MockStorage {
  constructor() {
    this.data = new Map([[LEDGER_KEY, { schema: 1, enabled: true, keyId: 'test-v1',
      totalMicros: 0, day: Math.floor(START / 86400000), dayCount: 0, dayMicros: 0,
      minute: Math.floor(START / 60000), minuteCount: 0, lastNow: START }]]);
    this.tail = Promise.resolve();
  }
  async transaction(fn) {
    const before = this.tail;
    let release;
    this.tail = new Promise(r => { release = r; });
    await before;
    try {
      if (this.fail) throw new Error('private storage diagnostic');
      const copy = structuredClone(this.data);
      const tx = { get: async k => structuredClone(copy.get(k)),
        put: async (k, v) => { copy.set(k, structuredClone(v)); },
        delete: async k => copy.delete(k),
        list: async ({ prefix = '', startAfter = '', limit = 32 } = {}) => new Map([...copy]
          .filter(([k]) => k.startsWith(prefix) && k > startAfter).sort(([a], [b]) => a < b ? -1 : 1).slice(0, limit)) };
      const out = await fn(tx);
      this.data = copy;
      return out;
    } finally { release(); }
  }
}

function harness(overrides = {}) {
  const storage = new MockStorage();
  let now = START;
  const calls = [];
  const env = { PHONE_SMS_ENABLED: 'true', PHONE_AUTH_HMAC_KEY: 'mock-only-hmac-key-at-least-32-characters',
    PHONE_AUTH_HMAC_KEY_ID: 'test-v1', PHONE_AUTH_POLICY: JSON.stringify(POLICY),
    TURNSTILE_SECRET: 'mock-secret', PHONE_TURNSTILE_HOSTNAME: 'sunland.dev',
    PHONE_ALIYUN_ACCESS_KEY_ID: 'mock-id', PHONE_ALIYUN_ACCESS_KEY_SECRET: 'mock-secret',
    PHONE_SMS_SIGN_NAME: 'mock-sign', PHONE_SMS_TEMPLATE_CODE: 'mock-template', ...overrides };
  const h = { storage, env, calls, captchaPosts: [], captcha: {}, send: {}, check: {},
    advance(ms) { now += ms; }, setTime(ms) { now = ms; } };
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    calls.push(parsed.hostname === 'challenges.cloudflare.com' ? 'captcha' : options.headers['x-acs-action']);
    if (parsed.hostname === 'challenges.cloudflare.com') {
      h.captchaPosts.push(JSON.parse(options.body));
      return Response.json({ success: true, hostname: 'sunland.dev', action: 'phone_login',
        challenge_ts: new Date(now).toISOString(), ...h.captcha });
    }
    assert.equal(parsed.hostname, 'dypnsapi.aliyuncs.com');
    if (options.headers['x-acs-action'] === 'SendSmsVerifyCode') {
      if (h.beforeSend) await h.beforeSend();
      return Response.json({ Success: true, Code: 'OK', ...h.send });
    }
    if (h.beforeCheck) await h.beforeCheck();
    return Response.json({ Success: true, Code: 'OK', Model: { VerifyResult: 'PASS' }, ...h.check });
  };
  h.rebuild = () => new PhoneAuthCoordinator({ storage }, env, { now: () => now, fetchImpl });
  h.coordinator = h.rebuild();
  if (!Object.hasOwn(overrides, 'PHONE_AUTH_COORDINATOR')) env.PHONE_AUTH_COORDINATOR = { getByName(name) {
    assert.equal(name, SINGLETON_NAME);
    return { fetch: request => h.coordinator.fetch(request) };
  } };
  h.sendCode = (data = input(), context = ctx) => sendPhoneCode(env, data, context);
  h.checkCode = (sent, data = {}, context = ctx) => checkPhoneCode(env, {
    phone, purpose: 'login', challenge_id: sent.challenge_id, code: '123456', ...data }, context);
  return h;
}
const rejects = (promise, code) => assert.rejects(promise, e => e.code === code && !/private|13800000000|123456/.test(e.message));

test('default OFF, absent binding/config/ledger and corrupt ledger fail closed without SMS', async () => {
  for (const env of [{ PHONE_SMS_ENABLED: undefined }, { PHONE_AUTH_COORDINATOR: undefined },
    { PHONE_AUTH_HMAC_KEY: '' }, { PHONE_AUTH_POLICY: '{}' }, { TURNSTILE_SECRET: '' }]) {
    const h = harness(env);
    await assert.rejects(h.sendCode());
    assert.equal(h.calls.length, 0);
  }
  for (const value of [undefined, {}, { schema: 1, enabled: true, totalMicros: -1 }]) {
    const h = harness();
    h.storage.data.set(LEDGER_KEY, value);
    await rejects(h.sendCode(), 'SERVICE_UNAVAILABLE');
    assert.equal(h.calls.length, 0);
  }
});

test('send + check use same fixed coordinator and consume once without issuing identity', async () => {
  const h = harness();
  const sent = await h.sendCode(input('+8613800000000'));
  assertContract('sendResult', sent);
  assert.equal(sent.success, true);
  assert.equal(sent.expires_in, 300);
  assert.equal(sent.retry_after, 600);
  const checked = await h.checkCode(sent);
  assertContract('checkResult', checked);
  assert.deepEqual(checked, { success: true, verified: true });
  await rejects(h.checkCode(sent), 'CHALLENGE_USED');
  assert.deepEqual(h.calls, ['captcha', 'SendSmsVerifyCode', 'CheckSmsVerifyCode']);
  assert.equal(h.storage.data.get(LEDGER_KEY).totalMicros, 100000);
  const persisted = JSON.stringify([...h.storage.data]);
  for (const raw of [phone, ctx.ip, '123456', 'mock-turnstile', 'mock-secret']) assert.equal(persisted.includes(raw), false);
  assert.equal(Object.hasOwn(sent, 'token'), false);
});

test('malformed inputs, extra user_id, unknown purpose and untrusted context are rejected', async () => {
  const h = harness();
  for (const data of [null, [], {}, input('12800000000'), input('138000000000'), input(13800000000),
    input('＋8613800000000'), input('13800000000', 'admin'), { ...input(), user_id: 'victim' },
    { ...input(), turnstile_token: 'a'.repeat(2049) }]) await assert.rejects(h.sendCode(data));
  for (const context of [{}, { ip: 'invalid' }, { ip: '192.0.2.1, 192.0.2.2' }]) await assert.rejects(h.sendCode(input(), context));
  for (const purpose of ['bind', 'change', 'unbind', 'reauth']) await rejects(h.sendCode(input(phone, purpose)), 'REAUTH_REQUIRED');
  for (const context of [{ ...sensitive, identityStatus: 'deleting' }, { ...sensitive, reauthenticatedAt: START - 300001 },
    { ...sensitive, reauthenticatedAt: START + 1 }]) await rejects(h.sendCode(input(phone, 'bind'), context), 'REAUTH_REQUIRED');
  assert.equal(h.calls.length, 0);
});

test('Turnstile checks success, hostname, action and timestamp before any paid reservation', async () => {
  for (const captcha of [{ success: false }, { hostname: 'evil.test' }, { action: 'email_login' },
    { challenge_ts: 'invalid' }, { challenge_ts: new Date(START - 300001).toISOString() },
    { challenge_ts: new Date(START + 30001).toISOString() }]) {
    const h = harness(); h.captcha = captcha;
    await rejects(h.sendCode(), 'CAPTCHA_FAILED');
    assert.deepEqual(h.calls, ['captcha']);
    assert.equal(h.storage.data.get(LEDGER_KEY).totalMicros, 0);
  }
});

test('concurrent sends including different purposes reserve only one SMS for entire phone', async () => {
  const h = harness();
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => h.sendCode()));
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(h.calls.filter(x => x === 'SendSmsVerifyCode').length, 1);
  h.captcha.action = 'phone_bind';
  await rejects(h.sendCode(input(phone, 'bind'), sensitive), 'RATE_LIMITED');
  h.advance(60000);
  await rejects(h.sendCode(input(phone, 'bind'), sensitive), 'RATE_LIMITED');
  assert.equal(h.storage.data.get(LEDGER_KEY).dayCount, 1);
});

test('purpose/phone/session mismatch cannot use an existing challenge; stale/retired context rejected', async () => {
  const h = harness(); h.captcha.action = 'phone_bind';
  const sent = await h.sendCode(input(phone, 'bind'), sensitive);
  for (const [data, context] of [[{ purpose: 'login' }, ctx], [{ purpose: 'bind', phone: '13900000000' }, sensitive],
    [{ purpose: 'bind' }, { ...sensitive, userId: 'victim' }],
    [{ purpose: 'bind' }, { ...sensitive, sessionId: 'another-token-digest-1234' }]]) {
    await rejects(h.checkCode(sent, data, context), 'CHALLENGE_INVALID');
  }
  await rejects(h.checkCode(sent, { purpose: 'bind' }, { ...sensitive, identityStatus: 'retired' }), 'REAUTH_REQUIRED');
  assert.deepEqual(await h.checkCode(sent, { purpose: 'bind' }, sensitive), { success: true, verified: true });
});

test('five wrong codes exhaust attempts and concurrent correct checks can only consume once', async () => {
  const h = harness(); const sent = await h.sendCode();
  h.check = { Model: { VerifyResult: 'UNKNOWN' } };
  for (let i = 0; i < 5; i++) await rejects(h.checkCode(sent), 'CODE_INVALID');
  h.check = {};
  await rejects(h.checkCode(sent), 'CHALLENGE_USED');
  assert.equal(h.calls.filter(x => x === 'CheckSmsVerifyCode').length, 5);
  const h2 = harness(); const sent2 = await h2.sendCode();
  const results = await Promise.allSettled([h2.checkCode(sent2), h2.checkCode(sent2)]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(h2.calls.filter(x => x === 'CheckSmsVerifyCode').length, 1);
});

test('expiry boundary, replay, restart and storage failure never produce a verification grant', async () => {
  const h = harness(); const sent = await h.sendCode();
  h.coordinator = h.rebuild();
  h.advance(300000);
  await rejects(h.checkCode(sent), 'CHALLENGE_EXPIRED');
  assert.equal(h.calls.filter(x => x === 'CheckSmsVerifyCode').length, 0);
  const h2 = harness(); const s2 = await h2.sendCode();
  h2.beforeCheck = async () => { h2.storage.fail = true; };
  await rejects(h2.checkCode(s2), 'SERVICE_UNAVAILABLE');
  h2.storage.fail = false; h2.coordinator = h2.rebuild();
  await rejects(h2.checkCode(s2), 'CHALLENGE_USED');
  const h3 = harness(); const s3 = await h3.sendCode();
  h3.beforeCheck = async () => { h3.advance(300000); };
  await rejects(h3.checkCode(s3), 'CHALLENGE_EXPIRED');
});

test('supplier failure and unknown send outcome retain budget and phone lock', async () => {
  const h = harness(); h.send = { Success: false, Code: 'isp.SYSTEM_ERROR', Message: phone + '123456' };
  await assert.rejects(h.sendCode());
  assert.equal(h.storage.data.get(LEDGER_KEY).totalMicros, 100000);
  h.send = {}; h.advance(60000); h.coordinator = h.rebuild();
  await rejects(h.sendCode(), 'SERVICE_UNAVAILABLE');
  assert.equal(h.calls.filter(x => x === 'SendSmsVerifyCode').length, 1);
  h.advance(86400000);
  await rejects(h.sendCode(), 'SERVICE_UNAVAILABLE');
  const h2 = harness(); h2.send = { Success: false, Code: 'FREQUENCY_FAIL' };
  await rejects(h2.sendCode(), 'PROVIDER_RATE_LIMITED');
  h2.advance(60000);
  await rejects(h2.sendCode(), 'RATE_LIMITED');
});

test('phone/IP daily quotas, global atomic daily count and daily amount budget', async () => {
  const h = harness();
  await h.sendCode(); h.advance(600000); await h.sendCode(); h.advance(600000);
  await rejects(h.sendCode(), 'RATE_LIMITED');
  await h.sendCode(input('13900000000'));
  await rejects(h.sendCode(input('13700000000')), 'RATE_LIMITED');
  await h.sendCode(input('13700000000'), { ip: '192.0.2.2' });
  await rejects(h.sendCode(input('13600000000'), { ip: '192.0.2.3' }), 'BUDGET_EXCEEDED');
  assert.equal(h.storage.data.get(LEDGER_KEY).dayCount, 4);
  const h2 = harness({ PHONE_AUTH_POLICY: JSON.stringify({ ...POLICY, dailyBudgetMicros: 100000 }) });
  const results = await Promise.allSettled([h2.sendCode(), h2.sendCode(input('13900000000'))]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(h2.calls.filter(x => x === 'SendSmsVerifyCode').length, 1);
});

test('lifetime budget survives UTC day rollover and rebuilding the coordinator', async () => {
  const h = harness({ PHONE_AUTH_POLICY: JSON.stringify({ ...POLICY, totalBudgetMicros: 100000 }) });
  await h.sendCode(); h.advance(86400000); h.coordinator = h.rebuild();
  await rejects(h.sendCode(input('13900000000')), 'BUDGET_EXCEEDED');
  assert.equal(h.storage.data.get(LEDGER_KEY).totalMicros, 100000);
});

test('request limits block captcha flooding, normalize equivalent IPv6 and preserve persistent budget during cleanup', async () => {
  const h = harness({ PHONE_AUTH_POLICY: JSON.stringify({ ...POLICY, ipRequestsPerMinute: 1 }) });
  h.captcha.success = false;
  await rejects(h.sendCode(input(), { ip: '2001:db8::1' }), 'CAPTCHA_FAILED');
  await rejects(h.sendCode(input(), { ip: '2001:0db8:0:0:0:0:0:1' }), 'RATE_LIMITED');
  assert.deepEqual(h.calls, ['captcha']);
  h.storage.data.set('t:expired', { deleteAfter: START - 1 });
  h.advance(60000);
  await rejects(h.sendCode(), 'CAPTCHA_FAILED');
  assert.equal(h.storage.data.has('t:expired'), false);
  assert.equal(h.storage.data.has(LEDGER_KEY), true);
});

test('coordinator private transport refuses unknown paths, oversized bodies and malformed JSON', async () => {
  const h = harness();
  for (const [path, body] of [['/unknown', '{}'], ['/send', '{'], ['/send', 'x'.repeat(9000)]]) {
    const response = await h.coordinator.fetch(new Request('https://phone-auth.internal' + path, { method: 'POST', body }));
    assert.ok(response.status >= 400);
    assert.equal((await response.text()).includes('SyntaxError'), false);
  }
  assert.equal(h.calls.length, 0);
});

test('unknown verification outcome closes challenge; unfinished send remains quarantined after restart', async () => {
  const h = harness(); const sent = await h.sendCode();
  h.beforeCheck = async () => { throw new Error('private supplier diagnostic'); };
  await rejects(h.checkCode(sent), 'UPSTREAM_UNAVAILABLE');
  h.beforeCheck = undefined;
  await rejects(h.checkCode(sent), 'CHALLENGE_USED');
  const h2 = harness();
  h2.beforeSend = async () => { h2.storage.fail = true; throw new Error('process interrupted'); };
  await rejects(h2.sendCode(), 'SERVICE_UNAVAILABLE');
  h2.storage.fail = false; h2.beforeSend = undefined;
  h2.advance(86400000); h2.coordinator = h2.rebuild();
  await rejects(h2.sendCode(), 'SERVICE_UNAVAILABLE');
  assert.equal(h2.calls.filter(x => x === 'SendSmsVerifyCode').length, 1);
  assert.equal(h2.storage.data.get(LEDGER_KEY).totalMicros, 100000);
});

test('atomic global daily quota across different phones/objects and minute request limit', async () => {
  const h = harness({ PHONE_AUTH_POLICY: JSON.stringify({ ...POLICY, dailyLimit: 1 }) });
  const other = h.rebuild();
  const results = await Promise.allSettled([h.coordinator.send(input(), ctx),
    other.send(input('13900000000'), { ip: '192.0.2.2' })]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(h.storage.data.get(LEDGER_KEY).dayCount, 1);
  const h2 = harness({ PHONE_AUTH_POLICY: JSON.stringify({ ...POLICY, globalRequestsPerMinute: 1 }) });
  h2.captcha.success = false;
  await rejects(h2.sendCode(), 'CAPTCHA_FAILED');
  await rejects(h2.sendCode(input('13900000000'), { ip: '192.0.2.2' }), 'RATE_LIMITED');
  h2.advance(60000);
  await rejects(h2.sendCode(input('13900000000'), { ip: '192.0.2.2' }), 'CAPTCHA_FAILED');
});

test('HMAC key rotation or lost phone-lock record cannot restore a verification grant', async () => {
  const h = harness(); const sent = await h.sendCode();
  h.env.PHONE_AUTH_HMAC_KEY_ID = 'other-version';
  await rejects(h.checkCode(sent), 'SERVICE_UNAVAILABLE');
  h.env.PHONE_AUTH_HMAC_KEY_ID = 'test-v1';
  for (const key of h.storage.data.keys()) if (key.startsWith('t:phone:')) h.storage.data.delete(key);
  await rejects(h.checkCode(sent), 'SERVICE_UNAVAILABLE');
  assert.equal(h.calls.filter(x => x === 'CheckSmsVerifyCode').length, 0);
});

test('siteverify receives a normalized bare IPv6 address', async () => {
  const h = harness();
  await h.sendCode(input(), { ip: '2001:0db8:0:0:0:0:0:1' });
  assert.equal(h.captchaPosts[0].remoteip, '2001:db8::1');
});

test('private service validates and whitelists coordinator results rather than forwarding unexpected data', async () => {
  const h = harness();
  h.env.PHONE_AUTH_COORDINATOR = { getByName: () => ({ fetch: async () => Response.json({
    success: true, verified: true, phone, code: '123456', token: 'not-an-identity-grant' }) }) };
  assert.deepEqual(await h.checkCode({ challenge_id: crypto.randomUUID() }), { success: true, verified: true });
  await rejects(h.sendCode(), 'SERVICE_UNAVAILABLE');
});

test('server authenticated reauth can establish its own proof without a circular recent-proof requirement', async () => {
  const h = harness(); h.captcha.action = 'phone_reauth';
  const context = { ...sensitive, reauthenticatedAt: undefined, reauthentication: true };
  const sent = await h.sendCode(input(phone, 'reauth'), context);
  assert.deepEqual(await h.checkCode(sent, {purpose:'reauth'}, context), {success:true,verified:true});
  const bad = harness(); bad.captcha.action = 'phone_bind';
  await rejects(bad.sendCode(input(phone,'bind'),context),'REAUTH_REQUIRED');
  await rejects(bad.sendCode(input(phone,'reauth'),{...context,identityStatus:'deleting'}),'REAUTH_REQUIRED');
});
