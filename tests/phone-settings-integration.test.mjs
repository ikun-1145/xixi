import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createPhoneAuthWorker } from '../workers/phone-auth/routes.js';

const load = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

// Exercises the actual page, client and Worker routing; SMS, email and identity
// persistence are in-memory substitutes, so this is not a PostgreSQL test.
test('settings bind, change and unbind through the actual client and Worker routes', async t => {
  const proof = 'A'.repeat(43), emails = [], sms = new Map();
  const state = { phone: null };
  const identity = {
    sessionHash: async () => 'synthetic-session',
    phoneHash: async phone => `hash:${phone}`,
    status: async () => ({ phone_hash: state.phone && `hash:${state.phone}`, masked_phone: state.phone && `+86 *******${state.phone.slice(-4)}`, email: 'person@example.test' }),
    issueGrant: async () => ({ reauth_token: proof, expires_in: 300 }),
    proof: async ({ reauthToken }) => { assert.equal(reauthToken, proof); return { issued_at: Date.now(), method: 'email' }; },
    mutate: async (action, values) => { state.phone = action === 'unbind' ? null : values.phone; },
  };
  const hooks = {
    readJsonBodyWithLimit: async req => ({ value: await req.json() }), json: (data, status) => Response.json(data, { status }),
    getUserFromRequest: async req => req.headers.get('Authorization') === 'Bearer synthetic-session' ? { id: 'user-1' } : null,
    getUserStatus: async () => ({}), accountStatusRejection: () => null,
    applicationSigningSecret: () => 'synthetic-secret', callIdentityRpc: async () => { throw Error('unexpected RPC'); },
    createEmailOtp: () => ({ consume: async value => ({ code: JSON.parse(value)[0] === '123456' ? 'OK' : 'INVALID' }) }),
    sendPhoneReauthEmail: async ({ bindCode }) => { emails.push(JSON.parse(bindCode('123456'))); return { success: true, retry_after: 60 }; },
  };
  const worker = createPhoneAuthWorker({ fetch: async () => new Response(null, { status: 404 }) }, hooks, {
    loginOnly: true, identityFactory: () => identity,
    sms: {
      sendPhoneCode: async (_env, input) => { sms.set(input.challenge_id, input); return { success: true, challenge_id: input.challenge_id, expires_in: 300, retry_after: 60 }; },
      checkPhoneCode: async (_env, input) => { const expected = sms.get(input.challenge_id); assert.equal(expected.phone, input.phone); assert.equal(expected.purpose, input.purpose); assert.equal(input.code, '654321'); sms.delete(input.challenge_id); return { verified: true }; },
    },
  });
  const env = { PHONE_IDENTITY_ENABLED: 'true', PHONE_ACCOUNT_MANAGEMENT_ENABLED: 'true', PHONE_EMAIL_REAUTH_ENABLED: 'true', PHONE_SMS_PROVIDER: 'relay' };
  const dom = new JSDOM(load('../ai_settings.html'), { url: 'https://sunland.dev/ai_settings.html', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window, el = id => w.document.getElementById(`phoneSettings${id}`);
  w.AbortController = AbortController; w.crypto.randomUUID = crypto.randomUUID.bind(crypto); w.localStorage.setItem('token', 'synthetic-session');
  w.document.querySelector('meta[name="sunland-phone-settings-enabled"]').content = 'true';
  w.eval(load('../p/js/phone-auth.js'));
  const original = w.SunlandPhoneAuth;
  const fetchImpl = (url, init) => worker.fetch(new Request(url, { ...init, headers: { ...init.headers, 'CF-Connecting-IP': '192.0.2.1' } }), env, {});
  w.SunlandPhoneAuth = { ...original, createClient: opts => original.createClient({ ...opts, captcha: async () => 'synthetic-turnstile', fetchImpl }) };
  w.eval(load('../p/js/phone-settings.js')); await tick(); await tick();
  async function begin(action) {
    el(action).click(); el('AuthSend').click(); await tick(); await tick();
    el('AuthCode').value = '123456'; el('AuthNext').click(); await tick(); await tick();
  }
  async function target(phone) {
    el('NewPhone').value = phone; el('TargetSend').click(); await tick(); await tick();
    el('NewCode').value = '654321'; el('TargetConfirm').click(); await tick(); await tick();
  }
  await begin('Bind'); await target('13800001234'); assert.equal(state.phone, '13800001234');
  // Advance only the local UI cooldown; production resend limits remain server-side.
  w.sessionStorage.removeItem('sunland.phone.email-reauth-cooldown.v1');
  await begin('Change'); await target('13900005678'); assert.equal(state.phone, '13900005678');
  w.sessionStorage.removeItem('sunland.phone.email-reauth-cooldown.v1');
  await begin('Unbind'); el('UnbindSubmit').click(); await tick(); await tick(); assert.equal(state.phone, null);
  assert.deepEqual(emails.map(value => value[3]), ['bind', 'change', 'unbind']);
});
