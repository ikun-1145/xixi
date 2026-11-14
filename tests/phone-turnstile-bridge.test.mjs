import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../p/js/phone-turnstile-bridge.js', import.meta.url), 'utf8');
function fixture({ action = 'phone_login', origin = 'https://sunland.dev', framed = false, token = 'synthetic-token' } = {}) {
  const button = {}, status = {}, messages = [];
  const window = { location: { origin, pathname: '/auth/phone-turnstile.html', search: `?action=${action}` },
    document: { getElementById: id => id === 'start' ? button : status },
    PhoneTurnstile: { postMessage: value => messages.push(JSON.parse(value)) },
    SunlandPhoneAuth: { runTurnstile: async () => token } };
  window.self = window; window.top = framed ? {} : window;
  vm.runInNewContext(source, { window, URLSearchParams });
  return { button, status, messages };
}
test('approved origin sends a single action-bound token to native channel', async () => {
  const f = fixture(); await Promise.all([f.button.onclick(), f.button.onclick()]);
  assert.equal(f.messages.length, 1);
  assert.deepEqual(f.messages[0], { type: 'token', action: 'phone_login', token: 'synthetic-token' });
});
for (const args of [{ action: 'phone_unbind' }, { origin: 'https://other.example' }, { framed: true }]) {
  test(`rejects invalid bridge context ${JSON.stringify(args)}`, () => {
    const f = fixture(args); assert.equal(f.button.disabled, true); assert.equal(f.messages.length, 0);
  });
}
test('invalid tokens produce an error without returning token data', async () => {
  const f = fixture({ token: '' }); await f.button.onclick();
  assert.deepEqual(f.messages[0], { type: 'error', action: 'phone_login' });
});
