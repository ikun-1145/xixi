import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// UI routing for account deletion: email accounts keep the email OTP path,
// phone-only accounts reauthenticate through the phone Worker, everyone else
// is sent to manual support. No network is reachable.
const dom = new JSDOM(`<button id="openAccountDeleteBtn"></button><dialog id="accountDeleteDialog">
  <button id="accountDeleteCloseBtn"></button><div id="accountDeleteBody"></div></dialog>`, { url: 'https://sunland.dev/ai_settings.html' });
const w = dom.window;
for (const key of ['window', 'document', 'localStorage', 'HTMLElement', 'Event']) globalThis[key] = w[key];
globalThis.fetch = async () => { throw Error('Live network forbidden'); };
const { initAccountDelete } = await import('../ai/account-delete.js');
const flush = () => new Promise(r => setTimeout(r, 0));
const $ = id => w.document.getElementById(id);

function client(status, calls) {
  return {
    status: async () => { calls.push(['status']); if (status instanceof Error) throw status; return status; },
    send: async (phone, purpose) => { calls.push(['send', phone, purpose]); return { challenge_id: 'c1' }; },
    phoneProof: async (phone, id, code, action) => { calls.push(['proof', phone, id, code, action]); return { reauth_token: 'r'.repeat(43) }; },
    authorizeDelete: async token => { calls.push(['authorize', token]); return { deletion_job_id: 'job', deletion_token: 'tok', expires_in: 600 }; },
    cancel: () => calls.push(['cancel']),
  };
}
async function open(user, status) {
  const calls = [];
  w.localStorage.clear();
  w.localStorage.setItem('user', JSON.stringify(user));
  globalThis.SunlandPhoneAuth = { createClient: () => client(status, calls), errorText: e => 'ERR:' + e?.code };
  const fresh = $('accountDeleteDialog').cloneNode(true); $('accountDeleteDialog').replaceWith(fresh);
  fresh.showModal = function () { this.setAttribute('open', ''); }; fresh.close = function () { this.removeAttribute('open'); };
  initAccountDelete();
  $('openAccountDeleteBtn').click();
  $('accountDeleteContinueBtn').click();
  await flush(); await flush();
  return calls;
}

test('email accounts keep the existing email verification step', async () => {
  const calls = await open({ id: 'u1', email: 'a@example.test' }, { bound: true, phone: '+86 *******8000', has_email: true });
  assert.equal($('accountDeleteEmailInput').value, 'a@example.test');
  assert.equal(calls.length, 0);
});

test('phone-only accounts verify the bound phone with a delete-scoped SMS before final confirmation', async () => {
  const calls = await open({ id: 'u2', email: null }, { bound: true, phone: '+86 *******8000', has_email: false });
  assert.equal($('accountDeletePhoneMasked').value, '+86 *******8000');
  assert.ok(!$('accountDeleteBody').textContent.includes('undefined'));
  $('accountDeletePhoneInput').value = '13800139999';
  $('accountDeleteSendBtn').click(); await flush();
  assert.equal(calls.filter(c => c[0] === 'send').length, 0);
  $('accountDeleteVerifyBtn').click(); await flush();
  assert.equal(calls.filter(c => c[0] === 'proof').length, 0);
  $('accountDeletePhoneInput').value = '13800138000';
  $('accountDeleteSendBtn').click(); await flush();
  assert.deepEqual(calls.at(-1), ['send', '13800138000', 'reauth']);
  $('accountDeleteCodeInput').value = '123456';
  $('accountDeleteVerifyBtn').click(); await flush(); await flush();
  assert.deepEqual(calls.find(c => c[0] === 'proof'), ['proof', '13800138000', 'c1', '123456', 'delete']);
  assert.deepEqual(calls.find(c => c[0] === 'authorize'), ['authorize', 'r'.repeat(43)]);
  assert.ok($('accountDeleteConfirmInput'));
  assert.ok($('accountDeleteFinalBtn').disabled);
});

test('accounts without email or phone, and banned phone accounts, go to manual support', async () => {
  await open({ id: 'u3' }, { bound: false, phone: null, has_email: false });
  assert.match($('accountDeleteBody').textContent, /support@sunland\.dev/);
  assert.equal($('accountDeleteSendBtn'), null);
  await open({ id: 'u4' }, Object.assign(new Error(), { code: 'ACCOUNT_BANNED' }));
  assert.match($('accountDeleteBody').textContent, /support@sunland\.dev/);
  assert.equal($('accountDeleteSendBtn'), null);
});

test('closing the dialog cancels pending phone requests', async () => {
  const calls = await open({ id: 'u5', email: null }, { bound: true, phone: '+86 *******8000', has_email: false });
  $('accountDeleteCloseBtn').click();
  assert.ok(calls.some(c => c[0] === 'cancel'));
});
