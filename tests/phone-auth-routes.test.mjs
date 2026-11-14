import assert from 'node:assert/strict';
import test from 'node:test';
import { createPhoneAuthWorker } from '../workers/phone-auth/routes.js';
import { PhoneAuthError } from '../workers/phone-auth/errors.js';

const UUID = '12345678-1234-4234-8234-123456789abc';
const PROOF = `${'a'.repeat(42)}A`;
const PHONE = '13800138000';
function fixture(options = {}) {
  const calls = [];
  const current = { user_id: 'existing-user', email: 'current@example.test', version: 1, phone_hash: 'hash-phone', masked_phone: '+86 *******8000', ...options.current };
  const identity = {
    sessionHash: async token => { calls.push(['session', token]); return 'session-hash'.repeat(5); },
    phoneHash: async phone => phone === PHONE ? 'hash-phone' : 'different-phone',
    status: async userId => { calls.push(['status', userId]); return current; },
    proof: async input => { calls.push(['proof', input]); if (options.proofError) throw new PhoneAuthError('REAUTH_INVALID', 403); return { issued_at: Date.now(), version: 1, method: options.proofMethod || 'email' }; },
    issueGrant: async input => { calls.push(['grant', input]); return { reauth_token: PROOF, issued_at: 1, version: 1, expires_in: 300 }; },
    login: async input => { calls.push(['login', input]); return { user_id: 'existing-user', email: current.email, onboarding: { version: 1, step: 3 }, is_new_user: false }; },
    mutate: async (...input) => { calls.push(['mutate', ...input]); return { code: 'OK', version: 2 }; },
    authorizeDelete: async input => { calls.push(['delete', input]); return { ok: true, deletion_job_id: UUID, deletion_token: PROOF, expires_in: 600 }; },
  };
  const hooks = {
    getUserFromRequest: async () => options.unauthorized ? null : { id: 'existing-user', email: 'stale@example.test' },
    getUserStatus: async () => options.unavailable ? null : { identityStatus: options.state || 'active', isBanned: options.banned || false },
    accountStatusRejection: (state, operation) => !state ? { error: 'User status unavailable', status: 503 } : state.identityStatus !== 'active' ? { error: 'ACCOUNT_NOT_ACTIVE', status: 403 } : state.isBanned && operation !== 'account_delete' ? { error: 'ACCOUNT_BANNED', status: 403 } : null,
    applicationSigningSecret: () => Object.hasOwn(options, 'signingSecret') ? options.signingSecret : 'existing-signing-secret',
    signJWT: async (...args) => { calls.push(['sign', ...args]); return 'existing-signed-token'; },
    callIdentityRpc: async (...args) => { calls.push(['rpc', ...args]); return { ok: true, payload: { code: 'OK' } }; },
    readJsonBodyWithLimit: async (request, max) => { const text = await request.text(); if (Buffer.byteLength(text) > max) return { error: 'too_large' }; try { return { value: JSON.parse(text) }; } catch { return { error: 'bad_json' }; } },
    json: (data, status = 200) => Response.json(data, { status, headers: { 'Access-Control-Allow-Origin': 'https://sunland.dev' } }),
    createEmailOtp: input => { calls.push(['otp', input]); return { consume: async code => { calls.push(['consume', code]); if (options.otpThrows) throw new Error('secret failure'); return { code: options.otpCode || 'OK' }; } }; },
    sendPhoneReauthEmail: async input => { calls.push(['reauth-send', input]); return { success: true, retry_after: 60 }; },
  };
  const sms = {
    sendPhoneCode: async (...args) => { calls.push(['send', ...args]); return { success: true, challenge_id: UUID, expires_in: 300, retry_after: 600 }; },
    checkPhoneCode: async (...args) => { calls.push(['check', ...args]); if (options.smsError) throw new PhoneAuthError('CODE_INVALID'); return { success: true, verified: true }; },
  };
  const scheduled = () => 'scheduled';
  const original = { scheduled, fetch: async request => { calls.push(['delegate', request]); return new Response(await request.text()); } };
  const worker = createPhoneAuthWorker(original, hooks, { identityFactory: () => identity, sms, loginOnly: options.loginOnly || false });
  const env = { PHONE_IDENTITY_ENABLED: 'true', test: true };
  const invoke = async (path, body = {}, opts = {}) => {
    const response = await worker.fetch(new Request(`https://api.sunland.dev${path}`, { method: opts.method || 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer raw-existing-jwt', 'CF-Connecting-IP': '192.0.2.1', ...opts.headers }, body: JSON.stringify(body) }), env, {});
    return { response, data: await response.json() };
  };
  return { worker, env, calls, invoke, current, scheduled };
}
const proofBody = () => ({ reauth_token: PROOF, operation_id: UUID });
const checkBody = () => ({ phone: PHONE, challenge_id: UUID, code: '123456' });

test('non-phone and OPTIONS delegate original request without consuming it; preserve scheduled', async () => {
  const { worker, calls, scheduled } = fixture();
  assert.equal(worker.scheduled, scheduled);
  for (const [path, method] of [['/verify-code', 'POST'], ['/v1/phone/status', 'OPTIONS'], ['/v1/phone/unknown', 'POST']]) {
    const request = new Request(`https://api.sunland.dev${path}`, { method, body: 'original-body' });
    const response = await worker.fetch(request, {}, {});
    assert.equal(await response.text(), 'original-body');
    assert.equal(calls.at(-1)[1], request);
  }
});

test('login send is anonymous and forwards only Phase1 fields with ingress IP', async () => {
  const { invoke, calls } = fixture({ unauthorized: true });
  const { data } = await invoke('/v1/phone/send-code', { phone: PHONE, purpose: 'login', turnstile_token: 'captcha' });
  assert.equal(data.success, true);
  assert.deepEqual(calls.find(x => x[0] === 'send').slice(2), [{ phone: PHONE, purpose: 'login', turnstile_token: 'captcha' }, { ip: '192.0.2.1' }]);
  assert.equal(calls.some(x => x[0] === 'session'), false);
});

test('send accepts and forwards a UUIDv4 recovery challenge without changing the legacy request', async () => {
  const { invoke, calls } = fixture();
  const result = await invoke('/v1/phone/send-code', { phone: PHONE, purpose: 'login', turnstile_token: 'captcha', challenge_id: UUID });
  assert.equal(result.data.success, true);
  assert.equal(calls.find(x => x[0] === 'send')[2].challenge_id, UUID);
  const invalid = await invoke('/v1/phone/send-code', { phone: PHONE, purpose: 'login', turnstile_token: 'captcha', challenge_id: '12345678-1234-1234-8234-123456789abc' });
  assert.equal(invalid.response.status, 400);
  assert.equal(calls.filter(x => x[0] === 'send').length, 1);
});

test('standalone relay rejects legacy sends before SMS while preserving new and aliyun clients', async () => {
  const f = fixture({ loginOnly: true }); f.env.PHONE_SMS_PROVIDER = 'relay';
  const body = { phone: PHONE, purpose: 'login', turnstile_token: 'captcha' };
  const old = await f.invoke('/v1/phone/send-code', body);
  assert.equal(old.response.status, 400); assert.equal(old.data.code, 'INVALID_REQUEST');
  assert.equal(f.calls.some(x => x[0] === 'send'), false);
  assert.equal((await f.invoke('/v1/phone/send-code', { ...body, challenge_id: UUID })).data.success, true);
  f.env.PHONE_SMS_PROVIDER = 'aliyun';
  assert.equal((await f.invoke('/v1/phone/send-code', body)).data.success, true);
  const other = fixture(); other.env.PHONE_SMS_PROVIDER = 'relay';
  assert.equal((await other.invoke('/v1/phone/send-code', body)).data.success, true);
});

test('SMS check precedes identity login and signs only authoritative identity using existing JWT helper', async () => {
  const { invoke, calls } = fixture();
  const { data } = await invoke('/v1/phone/verify-code', { ...checkBody(), operation_id: UUID });
  assert.deepEqual(data, { token: 'existing-signed-token', user: { id: 'existing-user', email: 'current@example.test' }, onboarding: { version: 1, step: 3 }, is_new_user: false });
  assert.ok(calls.findIndex(x => x[0] === 'check') < calls.findIndex(x => x[0] === 'login'));
  assert.deepEqual(calls.find(x => x[0] === 'sign').slice(1), [{ id: 'existing-user', email: 'current@example.test' }, 'existing-signing-secret']);
});

test('invalid SMS never creates identity or JWT', async () => {
  const { invoke, calls } = fixture({ smsError: true });
  assert.equal((await invoke('/v1/phone/verify-code', { ...checkBody(), operation_id: UUID })).data.code, 'CODE_INVALID');
  assert.equal(calls.some(x => ['login', 'sign'].includes(x[0])), false);
});

test('status exposes mask and email presence only', async () => {
  const { invoke } = fixture();
  assert.deepEqual((await invoke('/v1/phone/status')).data, { bound: true, phone: '+86 *******8000', has_email: true });
});

test('email reauth consumes OTP for current DB email and session, ignores JWT stale email', async () => {
  const { invoke, calls } = fixture();
  assert.deepEqual((await invoke('/v1/phone/reauth/email', { code: '123456', action: 'bind' })).data, { reauth_token: PROOF, expires_in: 300 });
  assert.equal(calls.find(x => x[0] === 'otp')[1].email, 'current@example.test');
  const grant = calls.find(x => x[0] === 'grant')[1];
  assert.deepEqual({ ...grant, sessionHash: 'session' }, { userId: 'existing-user', sessionHash: 'session', purpose: 'bind', method: 'email', subject: 'current@example.test' });
  assert.equal(calls.some(x => x[0] === 'login'), false);
});

test('standalone account management and email reauth remain closed by default', async () => {
  const f = fixture({ loginOnly: true });
  assert.equal((await f.invoke('/v1/phone/reauth/email/send', { action: 'bind' })).data.code, 'IDENTITY_DISABLED');
  assert.equal((await f.invoke('/v1/phone/bind', {})).data.code, 'IDENTITY_DISABLED');
  assert.equal(f.calls.some(x => x[0] === 'reauth-send'), false);
  f.env.PHONE_ACCOUNT_MANAGEMENT_ENABLED = 'true';
  assert.equal((await f.invoke('/v1/phone/reauth/email/send', { action: 'bind' })).data.code, 'IDENTITY_DISABLED');
});

test('standalone email reauth binds the current account, session and requested action', async () => {
  const f = fixture({ loginOnly: true });
  f.env.PHONE_ACCOUNT_MANAGEMENT_ENABLED = 'true'; f.env.PHONE_EMAIL_REAUTH_ENABLED = 'true';
  assert.equal((await f.invoke('/v1/phone/reauth/email/send', { action: 'bind' })).data.success, true);
  const send = f.calls.find(x => x[0] === 'reauth-send')[1];
  assert.equal(send.email, 'current@example.test');
  assert.deepEqual(JSON.parse(send.bindCode('123456')), ['123456', 'existing-user', 'session-hash'.repeat(5), 'bind']);
  assert.equal(f.calls.some(x => x[0] === 'login'), false);
  assert.equal((await f.invoke('/v1/phone/reauth/email', { code: '123456', action: 'bind' })).data.reauth_token, PROOF);
  assert.deepEqual(JSON.parse(f.calls.find(x => x[0] === 'consume')[1]), ['123456', 'existing-user', 'session-hash'.repeat(5), 'bind']);
});

test('standalone email reauth refuses unauthenticated and absent-email requests', async () => {
  for (const options of [{ unauthorized: true }, { current: { email: null } }]) {
    const f = fixture({ loginOnly: true, ...options });f.env.PHONE_ACCOUNT_MANAGEMENT_ENABLED = 'true';f.env.PHONE_EMAIL_REAUTH_ENABLED = 'true';
    const result = await f.invoke('/v1/phone/reauth/email/send', { action: 'bind' });
    assert.ok([401, 403].includes(result.response.status));assert.equal(f.calls.some(x => x[0] === 'reauth-send'), false);
  }
});

for (const code of ['INVALID', 'THROTTLED']) test(`email OTP ${code} cannot issue grant`, async () => {
  const { invoke, calls } = fixture({ otpCode: code });
  const { response, data } = await invoke('/v1/phone/reauth/email', { code: '123456', action: 'change' });
  assert.equal(response.status, code === 'THROTTLED' ? 429 : 400);
  assert.equal(data.code, code === 'THROTTLED' ? 'RATE_LIMITED' : 'CODE_INVALID');
  assert.equal(calls.some(x => x[0] === 'grant'), false);
});

test('phone reauth proves currently mapped phone and uses dedicated purpose without recent-proof loop', async () => {
  const { invoke, calls } = fixture();
  await invoke('/v1/phone/reauth/phone', { ...checkBody(), action: 'change' });
  const check = calls.find(x => x[0] === 'check');
  assert.equal(check[2].purpose, 'reauth');
  assert.equal(check[3].reauthentication, true);
  assert.equal(check[3].userId, 'existing-user');
  assert.equal(calls.find(x => x[0] === 'grant')[1].subject, 'hash-phone');
});

test('other account phone never reaches SMS check or grant', async () => {
  const { invoke, calls } = fixture();
  assert.equal((await invoke('/v1/phone/reauth/phone', { ...checkBody(), phone: '13900139000', action: 'change' })).data.code, 'REAUTH_INVALID');
  assert.equal(calls.some(x => ['check', 'grant'].includes(x[0])), false);
});

for (const action of ['bind', 'change']) test(`${action} verifies proof before SMS then mutates with current user`, async () => {
  const { invoke, calls } = fixture();
  assert.deepEqual((await invoke(`/v1/phone/${action}`, { ...checkBody(), ...proofBody() })).data, { ok: true });
  assert.deepEqual(calls.filter(x => ['proof', 'check', 'mutate'].includes(x[0])).map(x => x[0]), ['proof', 'check', 'mutate']);
  assert.equal(calls.find(x => x[0] === 'mutate')[2].userId, 'existing-user');
  assert.equal(calls.find(x => x[0] === 'check')[3].identityStatus, 'active');
});

test('sensitive send strips proof, constructs trusted recent context; cannot inject context fields', async () => {
  const { invoke, calls } = fixture();
  const body = { phone: PHONE, purpose: 'bind', turnstile_token: 'captcha', reauth_token: PROOF };
  assert.equal((await invoke('/v1/phone/send-code', body)).response.status, 200);
  const send = calls.find(x => x[0] === 'send');
  assert.deepEqual(Object.keys(send[2]), ['phone', 'purpose', 'turnstile_token']);
  assert.equal(typeof send[3].reauthenticatedAt, 'number');
  assert.equal((await invoke('/v1/phone/send-code', { ...body, reauthenticatedAt: Date.now() })).response.status, 400);
});

test('invalid proof stops sensitive send and check before provider', async () => {
  const { invoke, calls } = fixture({ proofError: true });
  await invoke('/v1/phone/send-code', { phone: PHONE, purpose: 'bind', turnstile_token: 'captcha', reauth_token: PROOF });
  await invoke('/v1/phone/change', { ...checkBody(), ...proofBody() });
  assert.equal(calls.some(x => ['check', 'send', 'mutate'].includes(x[0])), false);
});

test('unbind requires email proof and skips SMS; phone proof is rejected', async () => {
  const success = fixture();
  assert.deepEqual((await success.invoke('/v1/phone/unbind', proofBody())).data, { ok: true });
  assert.equal(success.calls.some(x => x[0] === 'check'), false);
  const blocked = fixture({ proofMethod: 'phone' });
  assert.equal((await blocked.invoke('/v1/phone/unbind', proofBody())).data.code, 'ALTERNATIVE_LOGIN_REQUIRED');
  assert.equal(blocked.calls.some(x => x[0] === 'mutate'), false);
});

for (const state of ['deleting', 'retired']) test(`${state} cannot enter any protected phone operation`, async () => {
  const { invoke, calls } = fixture({ state });
  for (const [path, body] of [['status', {}], ['reauth/email', { code: '123456', action: 'delete' }], ['delete-authorize', proofBody()]]) assert.equal((await invoke(`/v1/phone/${path}`, body)).data.code, 'ACCOUNT_NOT_ACTIVE');
  assert.equal(calls.some(x => ['grant', 'delete', 'mutate', 'status'].includes(x[0])), false);
});

test('banned active may prove and authorize deletion only', async () => {
  const { invoke, calls } = fixture({ banned: true });
  assert.equal((await invoke('/v1/phone/status')).data.code, 'ACCOUNT_BANNED');
  assert.equal((await invoke('/v1/phone/reauth/email', { code: '123456', action: 'bind' })).data.code, 'ACCOUNT_BANNED');
  assert.equal((await invoke('/v1/phone/reauth/email', { code: '123456', action: 'delete' })).response.status, 200);
  assert.deepEqual((await invoke('/v1/phone/delete-authorize', proofBody())).data, { ok: true, deletion_job_id: UUID, deletion_token: PROOF, expires_in: 600 });
  assert.equal(calls.some(x => x[0] === 'delete'), true);
});

for (const opts of [{ unauthorized: true }, { unavailable: true }]) test('JWT and status failures fail closed', async () => {
  const { invoke, calls } = fixture(opts);
  const { response } = await invoke('/v1/phone/status');
  assert.equal(response.status, opts.unauthorized ? 401 : 503);
  assert.equal(calls.some(x => x[0] === 'status'), false);
});

test('strict input validation rejects injected IDs, malformed phone/code/UUID/token, oversized and non-object JSON', async () => {
  const { invoke } = fixture();
  for (const body of [null, [], { ...checkBody(), operation_id: UUID, user_id: 'victim' }, { ...checkBody(), operation_id: 'bad' }, { ...checkBody(), operation_id: UUID, code: 123456 }, { ...checkBody(), operation_id: UUID, phone: '+1 555' }]) assert.equal((await invoke('/v1/phone/verify-code', body)).response.status, 400);
  assert.equal((await invoke('/v1/phone/unbind', { ...proofBody(), reauth_token: 'short' })).response.status, 400);
  assert.equal((await invoke('/v1/phone/status', { padding: 'x'.repeat(9000) })).response.status, 413);
});

test('OTP exceptions hide raw errors and preserve existing CORS', async () => {
  const { invoke } = fixture({ otpThrows: true });
  const { response, data } = await invoke('/v1/phone/reauth/email', { code: '123456', action: 'bind' });
  assert.equal(response.status, 503);
  assert.equal(JSON.stringify(data).includes('secret failure'), false);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://sunland.dev');
});

for (const signingSecret of [null, undefined, '', '   ']) test('missing signing secret rejects login before SMS consumption or identity creation', async () => {
  const { invoke, calls } = fixture({ signingSecret });
  const { response, data } = await invoke('/v1/phone/verify-code', { ...checkBody(), operation_id: UUID });
  assert.equal(response.status, 503);
  assert.equal(data.code, 'IDENTITY_CONFIG');
  assert.equal(calls.some(x => ['check', 'login', 'sign'].includes(x[0])), false);
});

test('missing signing secret cannot consume email reauth OTP', async () => {
  const { invoke, calls } = fixture({ signingSecret: '' });
  const { response, data } = await invoke('/v1/phone/reauth/email', { code: '123456', action: 'bind' });
  assert.equal(response.status, 503);
  assert.equal(data.code, 'IDENTITY_CONFIG');
  assert.equal(calls.some(x => ['otp', 'consume', 'grant'].includes(x[0])), false);
});

test('operation ids require UUIDv4 and proof tokens require canonical 32-byte base64url', async () => {
  const { invoke, calls } = fixture();
  for (const operation_id of ['12345678-1234-1234-8234-123456789abc', '12345678-1234-4234-1234-123456789abc']) {
    assert.equal((await invoke('/v1/phone/verify-code', { ...checkBody(), operation_id })).response.status, 400);
    assert.equal((await invoke('/v1/phone/unbind', { ...proofBody(), operation_id })).response.status, 400);
  }
  for (const reauth_token of ['a'.repeat(42), 'a'.repeat(44), 'a'.repeat(43), `${'a'.repeat(42)}=`]) {
    assert.equal((await invoke('/v1/phone/unbind', { ...proofBody(), reauth_token })).response.status, 400);
  }
  assert.equal(calls.some(x => ['check', 'login', 'proof', 'mutate'].includes(x[0])), false);
});

test('new phone endpoints stay disabled unless explicitly enabled and reject unsupported methods', async () => {
  const { worker, env, calls } = fixture();
  const request = new Request('https://api.sunland.dev/v1/phone/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const response = await worker.fetch(request, {}, {});
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'IDENTITY_DISABLED');
  const unsupported = await worker.fetch(new Request('https://api.sunland.dev/v1/phone/status'), env, {});
  assert.equal(unsupported.status, 405);
  assert.equal(calls.length, 0);
});

test('canonical 32-byte proofs accept every valid final base64url character', async () => {
  const { invoke, calls } = fixture();
  const endings = new Set();
  for (let remainder = 0; remainder < 16; remainder++) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    bytes[31] = (bytes[31] & 0xf0) | remainder;
    const token = Buffer.from(bytes).toString('base64url');
    endings.add(token.at(-1));
    const { response, data } = await invoke('/v1/phone/unbind', { ...proofBody(), reauth_token: token });
    assert.equal(response.status, 200, `valid final character ${token.at(-1)}`);
    assert.deepEqual(data, { ok: true });
  }
  assert.equal(endings.size, 16);
  assert.equal(calls.filter(x => x[0] === 'mutate').length, 16);
});
