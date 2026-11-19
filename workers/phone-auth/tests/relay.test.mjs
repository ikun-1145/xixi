import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { SmsRelayClient, smsProvider } from '../relay.js';
import { PhoneAuthCoordinator, LEDGER_KEY } from '../coordinator.js';

mock.method(globalThis, 'fetch', async () => { throw Error('Live network forbidden'); });
const START = Date.parse('2026-11-04T00:00:00Z');
const phone = '13800000000';
const context = { ip: '192.0.2.1' };
const env = () => ({ PHONE_SMS_ENABLED: 'true', PHONE_SMS_PROVIDER: 'relay',
  SMS_RELAY_URL: 'https://relay.invalid/send', SUNLAND_SMS_RELAY_KEY: 'synthetic-relay-key',
  PHONE_RELEASE_MODE: 'public', PHONE_AUTH_HMAC_KEY: 'synthetic-hmac-key-at-least-32-characters',
  PHONE_AUTH_HMAC_KEY_ID: 'test-v1', PHONE_AUTH_ADMIN_TOKEN: 'synthetic-admin-token-at-least-32-characters',
  TURNSTILE_SECRET: 'synthetic-turnstile', PHONE_TURNSTILE_HOSTNAME: 'sunland.dev',
  PHONE_ALIYUN_ACCESS_KEY_ID: 'synthetic', PHONE_ALIYUN_ACCESS_KEY_SECRET: 'synthetic',
  PHONE_SMS_SIGN_NAME: 'synthetic', PHONE_SMS_TEMPLATE_CODE: 'synthetic',
  PHONE_AUTH_POLICY: JSON.stringify({ perPhoneDaily: 10, perIpDaily: 20, dailyLimit: 20,
    unitCostMicros: 7, dailyBudgetMicros: 140, totalBudgetMicros: 140, ipRequestsPerMinute: 100, globalRequestsPerMinute: 200 }) });
const input = { phone, code: '012345', purpose: 'login' };
class Storage {
  data = new Map(); tail = Promise.resolve();
  sql = { exec: () => ({ toArray: () => [{ name:'_cf_KV' }] }) };
  async getCurrentBookmark() { return 'synthetic-bookmark'; }
  async transaction(fn) {
    const previous = this.tail; let release;
    this.tail = new Promise(r => { release = r; }); await previous;
    try {
      if (this.fail) throw Error('synthetic private storage failure');
      const data = structuredClone(this.data);
      const tx = { get: async k => structuredClone(data.get(k)), put: async (k, v) => data.set(k, structuredClone(v)),
        delete: async k => data.delete(k), getAlarm: async () => null, list: async ({ prefix = '', startAfter = '', limit = 32 } = {}) =>
          new Map([...data].filter(([k]) => k.startsWith(prefix) && k > startAfter).sort().slice(0, limit)) };
      const result = await fn(tx); this.data = data; return result;
    } finally { release(); }
  }
}
async function fixture(overrides = {}) {
  const h = { env: { ...env(), ...overrides }, storage: new Storage(), now: START, calls: [], messages: [] };
  const publicV2 = h.env.PHONE_RELEASE_MODE === 'public';
  const publicEnv = { ...h.env };
  if (publicV2) {
    h.env.PHONE_RELEASE_MODE = 'canary';
    h.env.PHONE_SMS_CANARY_PHONE_HASHES = JSON.stringify([createHmac('sha256',h.env.PHONE_AUTH_HMAC_KEY).update(`phone\0${phone}`).digest('hex')]);
  }
  const fetchImpl = async (url, options) => {
    h.calls.push(new URL(url).hostname);
    if (new URL(url).hostname === 'challenges.cloudflare.com') {
      assert.equal(options.cache, 'no-store');
      if (h.turnstileReply) return h.turnstileReply(options);
      return Response.json({ success: true, hostname: 'sunland.dev', action: `phone_${JSON.parse(options.body).response.split(':')[0]}`,
        challenge_ts: new Date(h.now).toISOString(), ...(h.turnstileResponse || {}) });
    }
    if (new URL(url).hostname === 'relay.invalid') {
      h.messages.push(JSON.parse(options.body));
      return h.reply ? h.reply(options) : Response.json({ ok: 1, msg: '验证码已发送', request_id: 'synthetic' });
    }
    assert.equal(new URL(url).hostname, 'dypnsapi.aliyuncs.com');
    return Response.json({ Success: true, Code: 'OK', Model: { VerifyResult: 'PASS' } });
  };
  h.rebuild = () => { h.coordinator = new PhoneAuthCoordinator({ storage: h.storage }, h.env, { now: () => h.now, fetchImpl }); };
  h.rebuild();
  const initialized = await h.coordinator.fetch(new Request('https://internal/initialize', {
    method: 'POST', headers: { Authorization: 'Bearer ' + h.env.PHONE_AUTH_ADMIN_TOKEN }, body: '{}' }));
  assert.equal(initialized.status, 200);
  if (publicV2) {
    const policy = {...JSON.parse(publicEnv.PHONE_AUTH_POLICY),dailyLimit:100};
    Object.assign(h.env,{PHONE_IDENTITY_ENABLED:'false',PHONE_SMS_ENABLED:'false',PHONE_NEW_REGISTRATION_ENABLED:'false',
      PHONE_ACCOUNT_MANAGEMENT_ENABLED:'false',PHONE_EMAIL_REAUTH_ENABLED:'false',PHONE_TURNSTILE_DIAGNOSTICS_ENABLED:'false',
      PHONE_LOGIN_EXTRA_CANARY_ENABLED:'false',PHONE_AUTH_V2_POLICY:JSON.stringify(policy)});
    const migrated = await h.coordinator.fetch(new Request('https://internal/migrate-v2',{method:'POST',
      headers:{Authorization:'Bearer '+h.env.PHONE_AUTH_ADMIN_TOKEN},body:'{}'}));
    assert.equal(migrated.status,200);
    // Isolated fixture starts in the first full UTC+8 day after migration.
    h.storage.data.get(LEDGER_KEY).dayCount = 0;
    Object.assign(h.env,publicEnv,{PHONE_AUTH_POLICY:JSON.stringify(policy),PHONE_LOGIN_EXTRA_CANARY_ENABLED:'false'});
    h.rebuild();
  }
  let tokenSequence = 0;
  h.send = (number = phone, purpose = 'login', ctx = context, challengeId, token = `${purpose}:${++tokenSequence}`) => h.coordinator.send({ phone: number, purpose, turnstile_token: token,
    ...(challengeId !== undefined ? { challenge_id: challengeId } : {}) }, ctx);
  h.check = (sent, code = h.messages.at(-1)?.code, purpose = 'login', ctx = context, number = phone) =>
    h.coordinator.check({ phone: number, purpose, challenge_id: sent.challenge_id, code }, ctx);
  h.row = id => h.storage.data.get('t:challenge:' + id);
  return h;
}

test('protected export captures all KV records without changing data and fails closed', async () => {
  const h = await fixture({PHONE_RELEASE_MODE:'canary', PHONE_SMS_CANARY_PHONE_HASHES:JSON.stringify(['a'.repeat(64)])});
  Object.assign(h.env, {PHONE_LEDGER_EXPORT_ENABLED:'true', PHONE_IDENTITY_ENABLED:'false', PHONE_SMS_ENABLED:'false',
    PHONE_NEW_REGISTRATION_ENABLED:'false', PHONE_ACCOUNT_MANAGEMENT_ENABLED:'false', PHONE_EMAIL_REAUTH_ENABLED:'false',
    PHONE_TURNSTILE_DIAGNOSTICS_ENABLED:'false', PHONE_LOGIN_EXTRA_CANARY_ENABLED:'false'});
  for (let i = 0; i < 300; i++) h.storage.data.set('t:test:' + String(i).padStart(4, '0'), {deleteAfter:i});
  const before = structuredClone(h.storage.data);
  const call = token => h.coordinator.fetch(new Request('https://internal/export-ledger', {method:'POST', headers:{Authorization:'Bearer '+token}, body:'{}'}));
  assert.equal((await call('wrong-token')).status,401);
  const response = await call(h.env.PHONE_AUTH_ADMIN_TOKEN);
  assert.equal(response.status,200);
  const data = await response.json();
  assert.equal(data.bookmark,'synthetic-bookmark'); assert.equal(data.alarm,null);
  assert.deepEqual(new Map(data.records), before); assert.deepEqual(h.storage.data,before);
  h.env.PHONE_SMS_ENABLED='true'; assert.equal((await call(h.env.PHONE_AUTH_ADMIN_TOKEN)).status,503);
  h.env.PHONE_SMS_ENABLED='false'; h.storage.sql.exec=()=>({toArray:()=>[{name:'unexpected_table'}]});
  assert.equal((await call(h.env.PHONE_AUTH_ADMIN_TOKEN)).status,503);
  h.storage.sql.exec=()=>({toArray:()=>[{name:'_cf_KV'},{name:'_cf_unexpected'}]});
  assert.equal((await call(h.env.PHONE_AUTH_ADMIN_TOKEN)).status,503);
  h.storage.sql.exec=()=>({toArray:()=>[{name:'_cf_KV'}]}); h.storage.data.set('unsupported',new Uint8Array([1]));
  assert.equal((await call(h.env.PHONE_AUTH_ADMIN_TOKEN)).status,503);
});

test('relay blocks unapproved purposes before Turnstile and budget even when management is enabled', async () => {
  const h = await fixture();
  const auth = { ...context, userId: 'user', sessionId: 'synthetic-session-1234', identityStatus: 'active', reauthenticatedAt: START };
  h.env.PHONE_ACCOUNT_MANAGEMENT_ENABLED = 'true';
  for (const purpose of ['bind','change','reauth','unbind']) await assert.rejects(h.send(phone, purpose, auth), {code:'IDENTITY_DISABLED'});
  assert.equal(h.messages.length, 0); assert.equal(h.calls.length, 0);
  assert.equal(h.storage.data.get(LEDGER_KEY).totalMicros, 0);
});

test('Turnstile rejects wrong hostname, action and expiry before relay or budget reservation', async () => {
  for (const response of [{hostname:'other.example'}, {action:'phone_reauth'},
    {challenge_ts:new Date(START - 301000).toISOString()}, {success:false}]) {
    const h = await fixture(); h.turnstileResponse = response;
    await assert.rejects(h.send(), {code:'CAPTCHA_FAILED'});
    assert.equal(h.messages.length, 0); assert.equal(h.storage.data.get(LEDGER_KEY).totalMicros, 0);
  }
});

test('one Turnstile token cannot reserve twice across numbers, purposes or restart', async () => {
  const h = await fixture(); const token = 'login:synthetic-single-use';
  await h.send(phone, 'login', context, undefined, token);
  const auth = { ...context, userId:'user', sessionId:'synthetic-session-1234', identityStatus:'active', reauthentication:true };
  h.rebuild();
  await assert.rejects(h.send('13900000000', 'login', context, undefined, token), {code:'CAPTCHA_FAILED'});
  await assert.rejects(h.send('13900000000', 'reauth', auth, undefined, token), {code:'IDENTITY_DISABLED'});
  h.env.PHONE_SMS_PROVIDER = 'aliyun'; h.rebuild();
  await assert.rejects(h.send('13900000000', 'login', context, undefined, token), {code:'CAPTCHA_FAILED'});
  assert.equal(h.calls.filter(name => name === 'challenges.cloudflare.com').length, 1);
  assert.equal(h.messages.length, 1);
  assert.equal(h.storage.data.get(LEDGER_KEY).totalMicros, 7);
  assert.equal(h.storage.data.get(LEDGER_KEY).minuteCount, 3);
  assert.equal(JSON.stringify([...h.storage.data]).includes(token), false);
  const marker = [...h.storage.data].find(([key]) => key.startsWith('t:turnstile:'));
  assert.ok(marker); assert.equal(marker[1].deleteAfter, START + 340000);
});

test('simultaneous reuse and failed verification remain fail closed', async t => {
  const h = await fixture(); const token = 'login:synthetic-concurrent';
  const results = await Promise.allSettled([
    h.send(phone, 'login', context, undefined, token),
    h.send('13900000000', 'login', context, undefined, token),
  ]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.filter(x => x.status === 'rejected' && x.reason.code === 'CAPTCHA_FAILED').length, 1);
  assert.equal(h.calls.filter(name => name === 'challenges.cloudflare.com').length, 1);
  assert.equal(h.messages.length, 1); assert.equal(h.storage.data.get(LEDGER_KEY).totalMicros, 7);

  const failed = await fixture(); failed.turnstileResponse = { success:false };
  await assert.rejects(failed.send(phone, 'login', context, undefined, token), {code:'CAPTCHA_FAILED'});
  failed.rebuild(); failed.turnstileResponse = undefined; failed.now += 339999;
  await assert.rejects(failed.send('13900000000', 'login', context, undefined, token), {code:'CAPTCHA_FAILED'});
  assert.equal(failed.calls.filter(name => name === 'challenges.cloudflare.com').length, 1);
  assert.equal(failed.messages.length, 0); assert.equal(failed.storage.data.get(LEDGER_KEY).totalMicros, 0);

  const unavailable = await fixture(); unavailable.turnstileReply = () => { throw Error('synthetic upstream error'); };
  await assert.rejects(unavailable.send(phone, 'login', context, undefined, token), {code:'UPSTREAM_UNAVAILABLE'});
  unavailable.rebuild(); unavailable.turnstileReply = undefined;
  await assert.rejects(unavailable.send('13900000000', 'login', context, undefined, token), {code:'CAPTCHA_FAILED'});
  assert.equal(unavailable.calls.filter(name => name === 'challenges.cloudflare.com').length, 1);
  assert.equal(unavailable.storage.data.get(LEDGER_KEY).totalMicros, 0);

  t.mock.timers.enable({ apis:['setTimeout'] });
  const timedOut = await fixture(); let notifyStarted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  timedOut.turnstileReply = () => { notifyStarted(); return new Promise(() => {}); };
  const sending = timedOut.send(phone, 'login', context, undefined, token);
  await started; t.mock.timers.tick(5000);
  await assert.rejects(sending, {code:'UPSTREAM_TIMEOUT'});
  timedOut.rebuild(); timedOut.turnstileReply = undefined;
  await assert.rejects(timedOut.send('13900000000', 'login', context, undefined, token), {code:'CAPTCHA_FAILED'});
  assert.equal(timedOut.calls.filter(name => name === 'challenges.cloudflare.com').length, 1);
  assert.equal(timedOut.storage.data.get(LEDGER_KEY).totalMicros, 0);
});

test('expired replay markers are cleaned without making an expired token valid', async () => {
  const h = await fixture(); const token = 'login:synthetic-expired';
  h.turnstileResponse = { success:false };
  await assert.rejects(h.send(phone, 'login', context, undefined, token), {code:'CAPTCHA_FAILED'});
  const markerKey = [...h.storage.data.keys()].find(key => key.startsWith('t:turnstile:'));
  h.now += 340000;
  await assert.rejects(h.send('13900000000', 'login', context, undefined, token), {code:'CAPTCHA_FAILED'});
  assert.equal(h.storage.data.has(markerKey), false);
  h.turnstileResponse = { challenge_ts:new Date(START).toISOString() };
  await assert.rejects(h.send('13900000000', 'login', context, undefined, token), {code:'CAPTCHA_FAILED'});
  assert.equal(h.messages.length, 0); assert.equal(h.storage.data.get(LEDGER_KEY).totalMicros, 0);
});

test('client challenge survives a lost send response and pending checks never consume attempts', async () => {
  const h = await fixture(); const id = crypto.randomUUID();
  let started; const ready = new Promise(resolve => { started = resolve; });
  let finish; h.reply = () => { started(); return new Promise(resolve => { finish = resolve; }); };
  const sending = h.send(phone, 'login', context, id); await ready;
  const sent = { challenge_id: id }; const code = h.messages[0].code;
  await assert.rejects(h.check(sent, code), { code: 'CHALLENGE_PENDING' });
  assert.equal(h.row(id).attempts, 0);
  finish(Response.json({ ok: 1 }));
  assert.equal((await sending).challenge_id, id); // The HTTP response may be lost after this point.
  h.rebuild();
  assert.deepEqual(await h.check(sent, code), { success: true, verified: true });
  await assert.rejects(h.check(sent, code), { code: 'CHALLENGE_USED' });
  assert.equal(h.messages.length, 1);
});

test('client challenge ID collision is atomic and never spends a second reservation', async () => {
  const h = await fixture(); const id = crypto.randomUUID();
  let started; const ready = new Promise(resolve => { started = resolve; });
  let finish; h.reply = () => { started(); return new Promise(resolve => { finish = resolve; }); };
  const first = h.send(phone, 'login', context, id); await ready;
  const saved = structuredClone(h.row(id));
  await assert.rejects(h.send('13900000000', 'login', context, id), { code: 'OPERATION_CONFLICT' });
  assert.deepEqual(h.row(id), saved);
  assert.equal(h.storage.data.get(LEDGER_KEY).totalMicros, 7);
  assert.equal(h.messages.length, 1);
  finish(Response.json({ ok: 1 })); await first;
});

test('concurrent requests using the same client challenge reserve at most once', async () => {
  const h = await fixture(); const id = crypto.randomUUID();
  const results = await Promise.allSettled([
    h.send(phone, 'login', context, id), h.send('13900000000', 'login', context, id),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected' && r.reason.code === 'OPERATION_CONFLICT').length, 1);
  assert.equal(h.messages.length, 1);
  assert.equal(h.storage.data.get(LEDGER_KEY).totalMicros, 7);
});

test('unknown relay outcome never makes a client challenge usable or permits automatic resend', async () => {
  const h = await fixture(); const id = crypto.randomUUID();
  h.reply = () => Response.json({ ok: 0 });
  await assert.rejects(h.send(phone, 'login', context, id), { code: 'PROVIDER_UNAVAILABLE' });
  assert.equal(h.row(id).status, 'failed');
  await assert.rejects(h.check({ challenge_id: id }, h.messages[0].code), { code: 'SERVICE_UNAVAILABLE' });
  await assert.rejects(h.send('13900000000', 'login', context, id), { code: 'OPERATION_CONFLICT' });
  assert.equal(h.messages.length, 1);
  assert.equal(h.storage.data.get(LEDGER_KEY).totalMicros, 7);
});

test('malformed client challenge IDs are rejected before outgoing requests', async () => {
  for (const id of ['', null, 1, '12345678-1234-1234-8234-123456789abc', '12345678-1234-4234-7234-123456789abc']) {
    const h = await fixture();
    await assert.rejects(h.send(phone, 'login', context, id), { code: 'INVALID_REQUEST' });
    assert.equal(h.calls.length, 0); assert.equal(h.storage.data.get(LEDGER_KEY).totalMicros, 0);
  }
});

test('relay sends exact JSON once, accepts only numeric ok=1 with HTTP 2xx, and sanitizes failures', async () => {
  for (const status of [200, 201, 299]) {
    let calls = 0;
    const client = new SmsRelayClient(env(), { fetchImpl: async (url, options) => {
      calls++; assert.equal(url, env().SMS_RELAY_URL); assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'manual'); assert.ok(options.signal instanceof AbortSignal);
      assert.deepEqual(JSON.parse(options.body), { api_key: env().SUNLAND_SMS_RELAY_KEY, phone, code: '012345', scene: 'login' });
      return Response.json({ ok: 1, msg: 'synthetic', request_id: 'id' }, { status });
    } });
    assert.deepEqual(await client.send(input), { accepted: true }); assert.equal(calls, 1);
  }
  const replies = [() => Response.json({ ok: 0, msg: phone + input.code }),
    ...[true, '1', null, undefined].map(ok => () => Response.json({ ok })),
    ...[400, 401, 403, 429, 500, 503].map(status => () => Response.json({ ok: 1 }, { status })),
    () => new Response('', { status: 302, headers: { location: 'https://other.invalid/' } }),
    () => new Response('sensitive invalid json'), () => Response.json([]), () => Response.json(null),
    () => new Response(null, { status: 204 }), () => { throw Error(phone + input.code + env().SUNLAND_SMS_RELAY_KEY); }];
  for (const reply of replies) {
    let calls = 0;
    const client = new SmsRelayClient(env(), { fetchImpl: async () => { calls++; return reply(); } });
    await assert.rejects(client.send(input), e => e.code && ![phone, input.code, env().SUNLAND_SMS_RELAY_KEY].some(s => e.message.includes(s)));
    assert.equal(calls, 1);
  }
});

test('relay acceptance does not expose or persist supplier message and request ID', async () => {
  const h = await fixture();
  const requestId = 'sensitive-relay-request-id';
  h.reply = () => Response.json({ ok: 1, request_id: requestId, msg: `private ${phone} ${h.messages[0].code}` });
  const result = await h.send();
  const exposed = JSON.stringify({ result, ledger: [...h.storage.data] });
  for (const value of [requestId, phone, h.messages[0].code, h.env.SUNLAND_SMS_RELAY_KEY]) {
    assert.equal(exposed.includes(JSON.stringify(value)), false);
  }
  assert.equal(h.calls.filter(name => name === 'relay.invalid').length, 1);
  assert.deepEqual(Object.keys(result).sort(), ['challenge_id', 'expires_in', 'retry_after', 'success']);
});

test('relay uses login scene only and rejects account management and reauthentication', async () => {
  const localEnv = { ...env(), PHONE_ACCOUNT_MANAGEMENT_ENABLED: 'true' };
  for (const purpose of ['login', 'reauth', 'bind', 'change']) {
    let requests = 0;
    const client = new SmsRelayClient(localEnv, { fetchImpl: async (_url, options) => {
      requests++; assert.equal(JSON.parse(options.body).scene, 'login');
      return Response.json({ ok: 1, request_id: 'opaque-relay-id' });
    } });
    if (purpose === 'login') { assert.deepEqual(await client.send({ ...input, purpose }), { accepted: true }); assert.equal(requests, 1); }
    else { await assert.rejects(client.send({ ...input, purpose }), {code:'IDENTITY_DISABLED'}); assert.equal(requests, 0); }
  }
});

test('login template permits login whether registration is disabled or enabled', async () => {
  for (const registration of ['false','true']) {
    let calls=0;
    const client=new SmsRelayClient({...env(),PHONE_NEW_REGISTRATION_ENABLED:registration},{fetchImpl:async (_url,options)=>{
      calls++; assert.equal(JSON.parse(options.body).scene,'login'); return Response.json({ok:1});
    }});
    assert.deepEqual(await client.send(input),{accepted:true}); assert.equal(calls,1);
  }
});

test('relay fixed eight-second deadline covers fetch and body, aborts once without retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const body of [false, true]) {
    let calls = 0, signal;
    const client = new SmsRelayClient(env(), { fetchImpl: async (_url, options) => {
      calls++; signal = options.signal;
      return body ? new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{')); } })) : new Promise(() => {});
    } });
    const result = assert.rejects(client.send(input), { code: 'UPSTREAM_TIMEOUT' });
    await Promise.resolve(); await Promise.resolve();
    t.mock.timers.tick(7999); assert.equal(signal.aborted, false);
    t.mock.timers.tick(1); await result; assert.equal(signal.aborted, true); assert.equal(calls, 1);
  }
});

test('provider selection and relay configuration fail closed before paid sends', async () => {
  assert.equal(smsProvider({}), 'aliyun');
  for (const value of ['', 'RELAY', 'unknown', null]) {
    assert.throws(() => smsProvider({ PHONE_SMS_PROVIDER: value }), { code: 'SMS_CONFIG' });
  }
  for (const override of [{ SMS_RELAY_URL: undefined }, { SMS_RELAY_URL: 'http://relay.invalid/' },
    { SMS_RELAY_URL: 'https://user:pass@relay.invalid/' }, { SMS_RELAY_URL: 'https://relay.invalid/#fragment' },
    { SUNLAND_SMS_RELAY_KEY: undefined }, { SUNLAND_SMS_RELAY_KEY: '' }, { SUNLAND_SMS_RELAY_KEY: ' bad ' }, { SUNLAND_SMS_RELAY_KEY: 'bad\nkey' },
    { PHONE_SMS_PROVIDER: '' }, { PHONE_SMS_PROVIDER: 'unknown' }]) {
    const h = await fixture(); Object.assign(h.env, override);
    await assert.rejects(h.send(), { code: 'SMS_CONFIG' });
    assert.equal(h.calls.length, 0); assert.equal(h.storage.data.get(LEDGER_KEY).totalMicros, 0);
  }
  const client = new SmsRelayClient(env());
  for (const purpose of ['register', 'bind', 'change', 'unbind', 'unknown']) await assert.rejects(client.send({ ...input, purpose }), { code: 'INVALID_REQUEST' });
  client.env.PHONE_SMS_ENABLED = 'false'; await assert.rejects(client.send(input), { code: 'SMS_DISABLED' });
});

test('relay randomness rejects biased tail and preserves six-digit leading zeroes', async t => {
  const h = await fixture(); const values = [4294000000, 7];
  t.mock.method(crypto, 'getRandomValues', bytes => { bytes[0] = values.shift(); return bytes; });
  const sent = await h.send(); assert.equal(h.messages[0].code, '000007'); assert.equal(values.length, 0);
  await h.check(sent, '000007');
});

test('v2 rejects budget drift and legacy canary retains its three-send cap', async () => {
  const h = await fixture(); const policy = JSON.parse(h.env.PHONE_AUTH_POLICY);
  h.env.PHONE_AUTH_POLICY = JSON.stringify({ ...policy, totalBudgetMicros: 7 });
  await assert.rejects(h.send(), {code:'RELEASE_CONFIG'}); assert.equal(h.messages.length,0);
  const numbers = ['13800000000', '13800000001', '13800000002', '13800000003'];
  const hashes = numbers.map(number=>createHmac('sha256',env().PHONE_AUTH_HMAC_KEY).update(`phone\0${number}`).digest('hex'));
  const c = await fixture({PHONE_RELEASE_MODE:'canary',PHONE_SMS_CANARY_PHONE_HASHES:JSON.stringify(hashes)});
  const sent = await Promise.allSettled(numbers.map(number => c.send(number)));
  assert.equal(sent.filter(r => r.status === 'fulfilled').length, 3); assert.equal(c.messages.length, 3);
  c.now += 86400000; c.rebuild();
  const denied = sent.findIndex(r => r.status === 'rejected');
  await assert.rejects(c.send(numbers[denied]), { code: 'CANARY_LIMITED' });
  assert.equal(c.storage.data.get(LEDGER_KEY).totalMicros, 21);
});

async function extraCanaryFixture() {
  const key = 'synthetic-hmac-key-at-least-32-characters';
  const hash = (domain,value) => createHmac('sha256',key).update(`${domain}\0${value}`).digest('hex');
  const policy = { perPhoneDaily:3, perIpDaily:3, dailyLimit:3, unitCostMicros:200000,
    dailyBudgetMicros:600000, totalBudgetMicros:600000, ipRequestsPerMinute:10, globalRequestsPerMinute:20 };
  const h = await fixture({PHONE_AUTH_POLICY:JSON.stringify(policy), PHONE_RELEASE_MODE:'canary',
    PHONE_SMS_CANARY_PHONE_HASHES:JSON.stringify([hash('phone',phone)]), PHONE_IDENTITY_ENABLED:'true',
    PHONE_NEW_REGISTRATION_ENABLED:'false', PHONE_ACCOUNT_MANAGEMENT_ENABLED:'false',
    PHONE_EMAIL_REAUTH_ENABLED:'false', PHONE_TURNSTILE_DIAGNOSTICS_ENABLED:'false',
    PHONE_LOGIN_EXTRA_CANARY_ENABLED:'true'});
  const account = h.storage.data.get(LEDGER_KEY);
  Object.assign(account,{testReserved:3,totalMicros:600000,dayCount:3,dayMicros:600000});
  h.storage.data.set('t:phone:'+hash('phone',phone),{day:account.day,count:3,lockUntil:START-1,quarantined:false});
  h.storage.data.set('t:ip:'+hash('ip',context.ip),{day:account.day,count:3,deleteAfter:START+86400000});
  return h;
}

test('one additional canary login reservation is atomic, preserves the original ledger and survives restart', async () => {
  const h=await extraCanaryFixture(), before=structuredClone(h.storage.data.get(LEDGER_KEY));
  const results=await Promise.allSettled([h.send(),h.send()]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.filter(r=>r.status==='rejected' && r.reason.code==='CANARY_LIMITED').length,1);
  const after=h.storage.data.get(LEDGER_KEY);
  assert.equal(after.testReserved,3);assert.equal(after.initConfig,before.initConfig);
  assert.equal(after.totalMicros,800000);assert.equal(after.dayMicros,800000);assert.equal(after.dayCount,4);
  assert.equal(h.messages.length,1);h.rebuild();h.now+=600000;
  await assert.rejects(h.send(),{code:'CANARY_LIMITED'});assert.equal(h.messages.length,1);
  h.env.PHONE_LOGIN_EXTRA_CANARY_ENABLED='false';h.rebuild();
  await assert.rejects(h.send(),{code:'CANARY_LIMITED'});assert.equal(h.storage.data.get(LEDGER_KEY).totalMicros,800000);
});

test('additional canary fails closed on configuration drift, incompatible data and unknown relay outcome', async () => {
  for (const change of [h=>{h.env.PHONE_NEW_REGISTRATION_ENABLED='true';},
    h=>{h.env.PHONE_ACCOUNT_MANAGEMENT_ENABLED='true';},h=>{h.env.PHONE_TURNSTILE_DIAGNOSTICS_ENABLED='true';},
    h=>{h.env.PHONE_RELEASE_MODE='public';},h=>{h.storage.data.get(LEDGER_KEY).initConfig='f'.repeat(64);},
    h=>{h.storage.data.set('canary:login-extra:v1',{schema:1,used:2});}]) {
    const h=await extraCanaryFixture();change(h);await assert.rejects(h.send());
    assert.equal(h.messages.length,0);assert.equal(h.storage.data.get(LEDGER_KEY).totalMicros,600000);
  }
  const h=await extraCanaryFixture();h.reply=()=>Response.json({ok:0});
  await assert.rejects(h.send(),{code:'PROVIDER_UNAVAILABLE'});h.now+=86400000;h.rebuild();
  await assert.rejects(h.send());assert.equal(h.messages.length,1);
  assert.equal(h.storage.data.get(LEDGER_KEY).testReserved,3);assert.equal(h.storage.data.get(LEDGER_KEY).totalMicros,800000);
});

test('extra canary configuration drift leaves all stored state unchanged and never calls Siteverify', async () => {
  for (const change of [
    h => { h.storage.data.get(LEDGER_KEY).initConfig = 'f'.repeat(64); },
    h => { h.storage.data.get(LEDGER_KEY).testReserved = 2; },
    h => { const policy = JSON.parse(h.env.PHONE_AUTH_POLICY); policy.ipRequestsPerMinute++; h.env.PHONE_AUTH_POLICY = JSON.stringify(policy); },
  ]) {
    const h = await extraCanaryFixture(); change(h); h.now += 60000;
    const before = structuredClone(h.storage.data);
    await assert.rejects(h.send(), { code:'RELEASE_CONFIG' });
    assert.deepEqual(h.storage.data, before);
    assert.equal(h.calls.length, 0);
  }
});

// The v2 release tests run against the serialized in-memory DO transaction
// implementation above. All upstream requests are handled by fetchImpl.
async function migratedPublicFixture({knownHistory=false} = {}) {
  const h = await extraCanaryFixture();
  Object.assign(h.env, { PHONE_IDENTITY_ENABLED:'false', PHONE_SMS_ENABLED:'false',
    PHONE_LOGIN_EXTRA_CANARY_ENABLED:'false', PHONE_NEW_REGISTRATION_ENABLED:'false',
    PHONE_ACCOUNT_MANAGEMENT_ENABLED:'false', PHONE_EMAIL_REAUTH_ENABLED:'false',
    PHONE_TURNSTILE_DIAGNOSTICS_ENABLED:'false' });
  const before = h.storage.data.get(LEDGER_KEY);
  Object.assign(before, { totalMicros:800000, dayMicros:800000, dayCount:knownHistory ? 4 : 5 });
  h.storage.data.set('canary:login-extra:v1', {schema:1,used:1});
  h.storage.data.set('t:turnstile:synthetic-prior', {deleteAfter:START + 340000});
  const policy = { perPhoneDaily:3, perIpDaily:3, dailyLimit:100, unitCostMicros:200000,
    dailyBudgetMicros:20000000, totalBudgetMicros:600000, ipRequestsPerMinute:1000, globalRequestsPerMinute:1000 };
  h.env.PHONE_AUTH_V2_POLICY = JSON.stringify(policy);
  h.migrate = () => h.coordinator.fetch(new Request('https://internal/migrate-v2', {
    method:'POST', headers:{Authorization:'Bearer ' + h.env.PHONE_AUTH_ADMIN_TOKEN}, body:'{}' }));
  h.activate = () => { Object.assign(h.env, {PHONE_RELEASE_MODE:'public', PHONE_AUTH_POLICY:JSON.stringify(policy),
    PHONE_IDENTITY_ENABLED:'true', PHONE_SMS_ENABLED:'true'}); h.rebuild(); };
  h.legacySnapshot = structuredClone(h.storage.data);
  return h;
}

test('v2 migration preserves four legacy reservations and conservatively fills the uncertain UTC+8 day', async () => {
  const h=await migratedPublicFixture({knownHistory:true});
  assert.equal((await h.migrate()).status,200);
  assert.equal(h.storage.data.get(LEDGER_KEY).dayCount,100);
  assert.equal(h.storage.data.get(LEDGER_KEY).totalMicros,800000);
  assert.deepEqual(h.storage.data.get('account:v1:backup'),h.legacySnapshot.get(LEDGER_KEY));
  h.activate(); await assert.rejects(h.send('13900000150','login',{ip:'198.51.100.150'}),{code:'BUDGET_EXCEEDED'});
  assert.equal(h.storage.data.get(LEDGER_KEY).dayCount,100);
});

test('v2 migration is idempotent, preserves the legacy account and replay records, and never refills the migration day', async () => {
  const h = await migratedPublicFixture();
  assert.equal((await h.migrate()).status, 200);
  const after = structuredClone(h.storage.data);
  assert.deepEqual(after.get('account:v1:backup'), h.legacySnapshot.get(LEDGER_KEY));
  assert.equal(after.get(LEDGER_KEY).totalMicros, 800000);
  assert.equal(after.get(LEDGER_KEY).dayCount, 100);
  assert.deepEqual(after.get('t:turnstile:synthetic-prior'),h.legacySnapshot.get('t:turnstile:synthetic-prior'));
  assert.deepEqual(after.get('canary:login-extra:v1'),h.legacySnapshot.get('canary:login-extra:v1'));
  assert.equal((await h.migrate()).status, 200);
  assert.deepEqual(h.storage.data, after);
  h.activate();
  await assert.rejects(h.send('13900000000','login',{ip:'198.51.100.1'}), {code:'BUDGET_EXCEEDED'});
  assert.equal(h.messages.length,0);
});

test('concurrent v2 migrations are idempotent and invalid legacy fingerprint is rejected without mutation', async () => {
  const h = await migratedPublicFixture();
  const responses = await Promise.all([h.migrate(),h.migrate()]);
  assert.deepEqual(responses.map(r=>r.status),[200,200]);
  assert.deepEqual(h.storage.data.get('account:v1:backup'),h.legacySnapshot.get(LEDGER_KEY));
  const bad = await migratedPublicFixture(); bad.storage.data.get(LEDGER_KEY).initConfig = 'f'.repeat(64);
  const before = structuredClone(bad.storage.data);
  assert.notEqual((await bad.migrate()).status,200);
  assert.deepEqual(bad.storage.data,before);
});

test('v2 concurrent competition for the final daily reservation admits exactly one', async () => {
  const h = await migratedPublicFixture(); assert.equal((await h.migrate()).status,200);
  h.activate(); h.now = Math.floor((h.now + 8*3600000)/86400000)*86400000 - 8*3600000 + 86400000;
  // Start the new day through a legitimate reservation, then model 98 prior
  // successful reservations in the protected isolated test ledger.
  await h.send('13900000200','login',{ip:'198.51.100.200'});
  h.storage.data.get(LEDGER_KEY).dayCount = 99;
  const results = await Promise.allSettled([
    h.send('13900000201','login',{ip:'198.51.100.201'}),
    h.send('13900000202','login',{ip:'198.51.100.202'})]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(results.filter(x=>x.status==='rejected' && x.reason.code==='BUDGET_EXCEEDED').length,1);
  assert.equal(h.storage.data.get(LEDGER_KEY).dayCount,100);
});

test('v2 global UTC+8 quota is atomic under contention and resets at midnight', async () => {
  const h = await migratedPublicFixture(); assert.equal((await h.migrate()).status,200);
  h.activate(); h.now = Math.floor((h.now + 8*3600000)/86400000)*86400000 - 8*3600000 + 86400000;
  const attempts = await Promise.allSettled(Array.from({length:105},(_,i) =>
    h.send('139'+String(i).padStart(8,'0'),'login',{ip:`198.51.100.${i+1}`})));
  assert.equal(attempts.filter(x=>x.status==='fulfilled').length,100);
  assert.equal(attempts.filter(x=>x.status==='rejected' && x.reason.code==='BUDGET_EXCEEDED').length,5);
  assert.equal(h.messages.length,100); assert.equal(h.storage.data.get(LEDGER_KEY).dayCount,100);
  h.now += 86400000; h.rebuild(); await h.send('13900000108','login',{ip:'198.51.100.200'});
  assert.equal(h.storage.data.get(LEDGER_KEY).dayCount,1);
});

test('v2 unknown provider result consumes quota; configuration drift and emergency close fail closed', async () => {
  const h = await migratedPublicFixture(); assert.equal((await h.migrate()).status,200); h.activate();
  h.now = Math.floor((h.now + 8*3600000)/86400000)*86400000 - 8*3600000 + 86400000;
  h.reply = () => { throw Error('synthetic unknown delivery'); };
  await assert.rejects(h.send('13900000110','login',{ip:'198.51.100.10'}));
  assert.equal(h.messages.length,1); assert.equal(h.storage.data.get(LEDGER_KEY).dayCount,1);
  h.now += 600000; h.rebuild(); await assert.rejects(h.send('13900000110','login',{ip:'198.51.100.10'}));
  assert.equal(h.messages.length,1);
  const original = h.env.PHONE_AUTH_POLICY, p = JSON.parse(original); p.dailyLimit = 101;
  h.env.PHONE_AUTH_POLICY = JSON.stringify(p); h.rebuild();
  await assert.rejects(h.send('13900000111','login',{ip:'198.51.100.11'}));
  h.env.PHONE_AUTH_POLICY = original; h.env.PHONE_SMS_ENABLED = 'false'; h.rebuild();
  await assert.rejects(h.send('13900000112','login',{ip:'198.51.100.12'}));
  assert.equal(h.messages.length,1);
});

async function temporaryQuotaFixture() {
  const h = await migratedPublicFixture();
  h.now = Date.parse('2026-11-19T04:00:00Z');
  assert.equal((await h.migrate()).status, 200);
  h.activate(); h.env.PHONE_TEMPORARY_SMS_20261119_ENABLED = 'true'; h.rebuild();
  return h;
}

test('temporary migration-day allowance is global and atomically caps concurrent sends at 20', async () => {
  const h = await temporaryQuotaFixture();
  const before = structuredClone(h.storage.data.get('account:v1:backup'));
  const sends = await Promise.allSettled(Array.from({length:25}, (_,i) =>
    h.send('139'+String(i).padStart(8,'0'),'login',{ip:`198.51.100.${i+1}`})));
  assert.equal(sends.filter(x=>x.status==='fulfilled').length,20);
  assert.equal(sends.filter(x=>x.status==='rejected' && x.reason.code==='BUDGET_EXCEEDED').length,5);
  assert.equal(h.messages.length,20);
  assert.equal(h.storage.data.get(LEDGER_KEY).dayCount,100);
  assert.equal(h.storage.data.get('quota:temporary:2026-11-19').used,20);
  assert.deepEqual(h.storage.data.get('account:v1:backup'),before);
  h.rebuild();
  await assert.rejects(h.send('13900000301','login',{ip:'198.51.100.201'}),{code:'BUDGET_EXCEEDED'});
  assert.equal(h.messages.length,20);
});

test('temporary quota survives restarts and cannot be duplicated by changing switch', async () => {
  const h = await temporaryQuotaFixture();
  await h.send('13900000302','login',{ip:'198.51.100.202'});
  assert.equal(h.storage.data.get('quota:temporary:2026-11-19').used,1);
  h.env.PHONE_TEMPORARY_SMS_20261119_ENABLED='false'; h.rebuild();
  await assert.rejects(h.send('13900000303','login',{ip:'198.51.100.203'}),{code:'BUDGET_EXCEEDED'});
  h.env.PHONE_TEMPORARY_SMS_20261119_ENABLED='true'; h.rebuild();
  await h.send('13900000304','login',{ip:'198.51.100.204'});
  assert.equal(h.storage.data.get('quota:temporary:2026-11-19').used,2);
  assert.equal(h.storage.data.get(LEDGER_KEY).dayCount,100);
});

test('temporary quota expires at UTC+8 midnight; next day uses only normal quota', async () => {
  const h = await temporaryQuotaFixture();
  h.now=Date.parse('2026-11-19T15:59:59.999Z');
  await h.send('13900000305','login',{ip:'198.51.100.205'});
  assert.equal(h.storage.data.get('quota:temporary:2026-11-19').used,1);
  h.now=Date.parse('2026-11-19T16:00:00.000Z'); h.rebuild();
  await h.send('13900000306','login',{ip:'198.51.100.206'});
  assert.equal(h.storage.data.get(LEDGER_KEY).dayCount,1);
  assert.equal(h.storage.data.get('quota:temporary:2026-11-19').used,1);
  h.storage.data.get(LEDGER_KEY).dayCount=100;
  await assert.rejects(h.send('13900000307','login',{ip:'198.51.100.207'}),{code:'BUDGET_EXCEEDED'});
});

test('temporary quota counts unknown sends and obeys emergency closure', async () => {
  const h = await temporaryQuotaFixture();
  h.reply=()=>{throw Error('synthetic unknown delivery')};
  await assert.rejects(h.send('13900000308','login',{ip:'198.51.100.208'}));
  assert.equal(h.messages.length,1);
  assert.equal(h.storage.data.get('quota:temporary:2026-11-19').used,1);
  h.now+=600000; h.rebuild();
  await assert.rejects(h.send('13900000308','login',{ip:'198.51.100.208'}));
  assert.equal(h.messages.length,1);
  h.env.PHONE_SMS_ENABLED='false'; h.rebuild();
  await assert.rejects(h.send('13900000309','login',{ip:'198.51.100.209'}));
  assert.equal(h.storage.data.get('quota:temporary:2026-11-19').used,1);
});

test('temporary quota status is read-only and corrupted counters fail closed', async () => {
  const h=await temporaryQuotaFixture();
  const status=()=>h.coordinator.fetch(new Request('https://internal/status',{method:'POST',
    headers:{Authorization:'Bearer '+h.env.PHONE_AUTH_ADMIN_TOKEN},body:'{}'}));
  const first=await (await status()).json();
  assert.equal(first.temporary_limit,20); assert.equal(first.temporary_used,0);
  assert.equal(h.storage.data.has('quota:temporary:2026-11-19'),false);
  await h.send('13900000310','login',{ip:'198.51.100.210'});
  assert.equal((await (await status()).json()).temporary_used,1);
  h.storage.data.get('quota:temporary:2026-11-19').used=0;
  await assert.rejects(h.send('13900000311','login',{ip:'198.51.100.211'}),{code:'SERVICE_UNAVAILABLE'});
  assert.equal(h.messages.length,1);
});

test('relay DO persists only bound MAC, survives restart, consumes once under concurrency', async () => {
  const h = await fixture(); const sent = await h.send(); const code = h.messages[0].code;
  assert.match(code, /^\d{6}$/); assert.equal(h.row(sent.challenge_id).provider, 'relay');
  assert.match(h.row(sent.challenge_id).otpMac, /^[0-9a-f]{64}$/);
  const stored = JSON.stringify([...h.storage.data]);
  for (const raw of [phone, h.env.SUNLAND_SMS_RELAY_KEY, h.env.PHONE_AUTH_HMAC_KEY, context.ip]) assert.equal(stored.includes(raw), false);
  // Check string values rather than substrings of timestamps/random MACs.
  for (const row of h.storage.data.values()) {
    assert.equal(Object.hasOwn(row, 'code'), false);
    assert.equal(Object.values(row).includes(code), false);
  }
  h.rebuild();
  const checks = await Promise.allSettled([h.check(sent, code), h.check(sent, code)]);
  assert.equal(checks.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(h.row(sent.challenge_id).status, 'consumed');
  await assert.rejects(h.check(sent, code), { code: 'CHALLENGE_USED' });
  assert.deepEqual(h.calls, ['challenges.cloudflare.com', 'relay.invalid']);
});

test('relay exhaustion, expiry, purpose/phone/session binding and storage failure fail closed', async () => {
  const h = await fixture(); const sent = await h.send(); const code = h.messages[0].code;
  const wrong = code === '000000' ? '000001' : '000000';
  for (let i = 0; i < 5; i++) await assert.rejects(h.check(sent, wrong), { code: 'CODE_INVALID' });
  await assert.rejects(h.check(sent, code), { code: 'CHALLENGE_USED' });
  assert.equal(h.row(sent.challenge_id).attempts, 5);
  const expired = await fixture(); const s = await expired.send(); expired.now += 300000;
  await assert.rejects(expired.check(s), { code: 'CHALLENGE_EXPIRED' });
  const r = await fixture();
  const auth = { ...context, userId: 'user', sessionId: 'synthetic-session-1234', identityStatus: 'active', reauthentication: true };
  const reauth = await r.send(phone, 'login', context); const reauthCode = r.messages[0].code;
  // Simulate an existing challenge created before the template restriction.
  const row = r.row(reauth.challenge_id), hash = (domain,value) => createHmac('sha256',r.env.PHONE_AUTH_HMAC_KEY).update(`${domain}\0${value}`).digest('hex');
  row.purpose='reauth'; row.principalHash=hash('principal',JSON.stringify([auth.userId,auth.sessionId]));
  row.otpMac=hash('sms-relay-otp:v1',JSON.stringify([reauth.challenge_id,row.phoneHash,'reauth',reauthCode]));
  await assert.rejects(r.check(reauth, reauthCode), { code: 'CHALLENGE_INVALID' });
  await assert.rejects(r.check(reauth, reauthCode, 'reauth', { ...auth, sessionId: 'another-session-1234' }), { code: 'CHALLENGE_INVALID' });
  await assert.rejects(r.check(reauth, reauthCode, 'reauth', auth, '13900000000'), { code: 'CHALLENGE_INVALID' });
  await r.check(reauth, reauthCode, 'reauth', auth);
  const lost = await fixture(); const l = await lost.send(); lost.storage.fail = true;
  await assert.rejects(lost.check(l), { code: 'SERVICE_UNAVAILABLE' }); lost.storage.fail = false;
  assert.equal(lost.row(l.challenge_id).status, 'sent');
});

test('MAC cannot be transplanted between challenge, phone or purpose', async () => {
  for (const change of ['challenge', 'phone', 'purpose']) {
    const h = await fixture(); const first = await h.send(); const mac = h.row(first.challenge_id).otpMac;
    h.now += 600000;
    const auth = { ...context, userId: 'u', sessionId: 'synthetic-session-1234', identityStatus: 'active', reauthentication: true };
    const purpose = change === 'purpose' ? 'reauth' : 'login';
    const number = change === 'phone' ? '13900000000' : phone;
    const ctx = purpose === 'reauth' ? auth : context;
    const second = await h.send(number, 'login', context);
    if (purpose === 'reauth') {
      const row=h.row(second.challenge_id); row.purpose='reauth';
      row.principalHash=createHmac('sha256',h.env.PHONE_AUTH_HMAC_KEY).update(`principal\0${JSON.stringify([auth.userId,auth.sessionId])}`).digest('hex');
    }
    h.row(second.challenge_id).otpMac = mac;
    await assert.rejects(h.check(second, h.messages[0].code, purpose, ctx, number), { code: 'CODE_INVALID' });
  }
});

test('switch and rollback use saved provider, including historical aliyun records', async () => {
  const h = await fixture(); const relay = await h.send(); const code = h.messages[0].code;
  h.env.PHONE_SMS_PROVIDER = 'aliyun'; delete h.env.SUNLAND_SMS_RELAY_KEY; delete h.env.SMS_RELAY_URL; h.rebuild();
  await h.check(relay, code); assert.equal(h.calls.includes('dypnsapi.aliyuncs.com'), false);
  h.now += 600000; const ali = await h.send(); assert.equal(h.row(ali.challenge_id).provider, 'aliyun');
  delete h.row(ali.challenge_id).provider; // Existing records before this change.
  h.env.PHONE_SMS_PROVIDER = 'relay'; h.rebuild(); // Missing relay config must not reroute an old check.
  await h.check(ali, '123456'); assert.equal(h.calls.filter(x => x === 'dypnsapi.aliyuncs.com').length, 2);
  await assert.rejects(h.send('13900000000'), { code: 'SMS_CONFIG' });
});

test('relay failures retain budget and quarantine across restart/day/provider changes', async () => {
  for (const reply of [() => Response.json({ ok: 0 }), () => Response.json({ ok: 1 }, { status: 500 }),
    () => new Response('bad json'), () => { throw Error('synthetic failure'); }]) {
    const h = await fixture(); h.reply = reply;
    await assert.rejects(h.send()); assert.equal(h.storage.data.get(LEDGER_KEY).totalMicros, 7);
    const challenge = [...h.storage.data.values()].find(v => v.provider === 'relay'); assert.equal(challenge.status, 'failed');
    h.now += 86400000; h.env.PHONE_SMS_PROVIDER = 'aliyun'; h.rebuild();
    await assert.rejects(h.send(), { code: 'SERVICE_UNAVAILABLE' });
    assert.equal(h.calls.includes('dypnsapi.aliyuncs.com'), false);
    assert.equal(h.storage.data.get(LEDGER_KEY).totalMicros, 7);
  }
});

test('relay DO timeout retains budget, closes challenge and never retries after recovery', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = await fixture();
  let notifyStarted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  h.reply = () => { notifyStarted(); return new Promise(() => {}); };
  const pending = assert.rejects(h.send(), { code: 'UPSTREAM_TIMEOUT' });
  await started;
  assert.equal(h.messages.length, 1); t.mock.timers.tick(8000); await pending;
  assert.equal(h.storage.data.get(LEDGER_KEY).totalMicros, 7);
  h.now += 86400000; h.rebuild(); await assert.rejects(h.send(), { code: 'SERVICE_UNAVAILABLE' });
  assert.equal(h.messages.length, 1);
});
