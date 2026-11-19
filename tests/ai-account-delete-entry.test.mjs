import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

// The settings page decides the deletion entry from the server-issued
// database token, not from the cached display user.
const html = readFileSync(new URL('../ai_settings.html', import.meta.url), 'utf8');
const page = new JSDOM(html).window.document;
const pick = id => page.getElementById(id).outerHTML;
const dom = new JSDOM(`<button id="openAccountDeleteBtn" class="data-action-btn" type="button">删除账号</button>
  ${pick('accountDeleteManual')}${pick('accountDeleteDialog')}`, { url: 'https://sunland.dev/ai_settings.html' });
const w = dom.window;
for (const key of ['window', 'document', 'localStorage', 'HTMLElement', 'Event']) globalThis[key] = w[key];
globalThis.fetch = async () => { throw Error('Live network forbidden'); };
const { initAccountDelete } = await import('../ai/account-delete.js');
const flush = () => new Promise(r => setTimeout(r, 0));
const $ = id => w.document.getElementById(id);
const jwt = claims => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const USER = '12345678-1234-4234-8234-123456789abc';

async function load({ db, cachedEmail, token = jwt({ id: USER }) }) {
  w.localStorage.clear();
  if (token) w.localStorage.setItem('token', token);
  w.localStorage.setItem('user', JSON.stringify({ id: USER, email: cachedEmail }));
  globalThis.SunlandDatabaseToken = { get: async () => { if (db instanceof Error) throw db; return jwt(db); } };
  const fresh = $('accountDeleteDialog').cloneNode(true); fresh.removeAttribute('open'); $('accountDeleteDialog').replaceWith(fresh);
  fresh.showModal = function () { this.setAttribute('open', ''); };
  initAccountDelete(); await flush(); await flush();
  const visible = [...$('accountDeleteManual').querySelectorAll('[data-delete-note]')].filter(n => !n.hidden).map(n => n.dataset.deleteNote);
  return { button: !$('openAccountDeleteBtn').hidden, manual: !$('accountDeleteManual').hidden, visible };
}

test('email accounts keep the original self-service deletion button and flow', async () => {
  assert.deepEqual(await load({ db: { id: USER, email: 'a@example.test' } }), { button: true, manual: false, visible: [] });
  $('openAccountDeleteBtn').click();
  assert.ok($('accountDeleteDialog').hasAttribute('open'));
  $('accountDeleteContinueBtn').click();
  assert.ok($('accountDeleteEmailInput'));
});

test('phone-only accounts hide self-service deletion and show the manual support channel', async () => {
  // A stale cached email must not re-enable the button.
  assert.deepEqual(await load({ db: { id: USER, email: null }, cachedEmail: 'stale@example.test' }), { button: false, manual: true, visible: ['phone'] });
  const link = $('accountDeleteManual').querySelector('a');
  assert.equal(link.getAttribute('href'), 'mailto:support@sunland.dev');
  assert.match($('accountDeleteManual').textContent, /人工核验身份后可申请注销/);
  $('openAccountDeleteBtn').click();
  assert.equal($('accountDeleteDialog').hasAttribute('open'), false);
});

test('unconfirmed account state never guesses: original email flow remains, with a support notice', async () => {
  for (const db of [Object.assign(new Error('database-token-unavailable')), { id: 'someone-else', email: null }, { id: USER }])
    assert.deepEqual(await load({ db, cachedEmail: null }), { button: true, manual: true, visible: ['unknown'] });
});

test('signed-out page is unchanged', async () => {
  assert.deepEqual(await load({ db: { id: USER, email: null }, token: null }), { button: true, manual: false, visible: [] });
});

test('manual deletion copy is translated in all supported languages', () => {
  const extra = readFileSync(new URL('../p/js/site-i18n-extra.js', import.meta.url), 'utf8');
  for (const p of $('accountDeleteManual').querySelectorAll('p')) {
    const line = extra.split('\n').find(l => l.includes(JSON.stringify(p.textContent)));
    assert.ok(line, p.textContent);
    for (const lang of ['zh-Hant', 'en', 'ja', 'ko', 'es']) assert.match(line, new RegExp(`"${lang}":"[^"]+"`));
  }
});
