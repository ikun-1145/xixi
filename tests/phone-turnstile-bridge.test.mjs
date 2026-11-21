import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../p/js/phone-turnstile-bridge.js', import.meta.url), 'utf8');
function fixture({ action = 'phone_login', origin = 'https://sunland.dev', framed = false, token = 'synthetic-token' } = {}) {
  const button = {}, status = {};
  const window = { location: { origin, pathname: '/auth/phone-turnstile.html', search: `?action=${action}` },
    document: { getElementById: id => id === 'start' ? button : status },
    SunlandPhoneAuth: { runTurnstile: async () => token } };
  window.self = window; window.top = framed ? {} : window;
  vm.runInNewContext(source, { window, URLSearchParams });
  return { button, status, window };
}
test('approved origin exposes one action-bound token only once in the main frame', async () => {
  const f = fixture(); await Promise.all([f.button.onclick(), f.button.onclick()]);
  assert.deepEqual(JSON.parse(JSON.stringify(f.window.__phoneTurnstileTakeResult())), { type: 'token', action: 'phone_login', token: 'synthetic-token' });
  assert.equal(f.window.__phoneTurnstileTakeResult(), null);
});
for (const args of [{ action: 'phone_unbind' }, { origin: 'https://other.example' }, { framed: true }]) {
  test(`rejects invalid bridge context ${JSON.stringify(args)}`, () => {
    const f = fixture(args); assert.equal(f.button.disabled, true); assert.equal(f.window.__phoneTurnstileTakeResult, undefined);
  });
}
test('invalid tokens produce an error without returning token data', async () => {
  const f = fixture({ token: '' }); await f.button.onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(f.window.__phoneTurnstileTakeResult())), { type: 'error', action: 'phone_login' });
});
