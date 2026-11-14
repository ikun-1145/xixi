import test from 'node:test';
import assert from 'node:assert/strict';
import { sendPhoneReauthEmail } from '../email-reauth.js';

const env = { PHONE_REAUTH_EMAIL_API_KEY: 'synthetic-key' };
const email = 'synthetic@example.test';
function fixture({ reserve = 'OK', response = () => Response.json({ id: 'synthetic' }), error = false } = {}) {
  const events = [];
  const otp = {
    async reserve(code, id) { events.push(['reserve', code, id]); return { code: reserve }; },
    async delivery(id, outcome) { events.push(['delivery', id, outcome]); },
  };
  const fetchImpl = async (url, init) => { events.push(['fetch', url, init]); if (error) throw Error('synthetic'); return response(); };
  const invoke = () => sendPhoneReauthEmail({ env, email, otp, fetchImpl, bindCode: code => JSON.stringify([code, 'user', 'session', 'bind']) });
  return { events, invoke };
}
test('email reauth reserves a bound code and sends exactly once without returning it', async () => {
  const f = fixture(); const result = await f.invoke();
  assert.deepEqual(result, { success: true, retry_after: 60 });
  assert.deepEqual(f.events.map(x => x[0]), ['reserve', 'fetch', 'delivery']);
  const bound = JSON.parse(f.events[0][1]); assert.match(bound[0], /^\d{6}$/);
  assert.deepEqual(bound.slice(1), ['user', 'session', 'bind']);
  assert.equal(f.events[2][2], 'delivered'); assert.equal(JSON.stringify(result).includes(bound[0]), false);
});
test('throttled and missing configuration reject before delivery', async () => {
  const f = fixture({ reserve: 'THROTTLED' }); await assert.rejects(f.invoke(), { code: 'RATE_LIMITED' });
  assert.deepEqual(f.events.map(x => x[0]), ['reserve']);
  await assert.rejects(sendPhoneReauthEmail({ env: {}, email }), { code: 'IDENTITY_CONFIG' });
});
for (const [name, response, expected] of [
  ['provider rejection', () => Response.json({ error: 'synthetic' }, { status: 400 }), 'failed'],
  ['provider timeout-like failure', () => Response.json({ error: 'synthetic' }, { status: 429 }), 'unknown'],
  ['malformed success', () => Response.json({ ok: true }), 'unknown'],
]) test(`${name} retains the correct delivery state and never retries`, async () => {
  const f = fixture({ response }); await assert.rejects(f.invoke(), { code: 'IDENTITY_UNAVAILABLE' });
  assert.equal(f.events.filter(x => x[0] === 'fetch').length, 1); assert.equal(f.events.at(-1)[2], expected);
});
test('network error keeps an unknown outcome without a second request', async () => {
  const f = fixture({ error: true }); await assert.rejects(f.invoke(), { code: 'IDENTITY_UNAVAILABLE' });
  assert.equal(f.events.filter(x => x[0] === 'fetch').length, 1); assert.equal(f.events.at(-1)[2], 'unknown');
});
