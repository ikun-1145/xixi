import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

async function fixture(status = { bound: false, phone: null, has_email: true }, options = {}) {
  const dom = new JSDOM('<div id="settings"></div>', { url: 'https://sunland.dev/ai_settings.html', runScripts: 'outside-only' });
  const { window } = dom;
  let identity = 'a';
  const calls = [];
  const client = {
    capture: () => identity, current: s => identity === s, cancel() {},
    refreshSession: async () => ({ id: identity, email: 'test@example.invalid' }),
    status: async () => ({ ...status }),
    emailSend: async email => calls.push(['emailSend', email]),
    emailProof: async (code, action) => { calls.push(['emailProof', code, action]); return { reauth_token: 'proof', expires_in: 300 }; },
    phoneProof: async (...args) => { calls.push(['phoneProof', ...args]); return { reauth_token: 'proof', expires_in: 300 }; },
    send: async (...args) => { calls.push(['send', ...args]); return { challenge_id: 'challenge', expires_in: 300, retry_after: 60 }; },
    mutate: async (action, data) => { calls.push(['mutate', action, data]); status = { bound: action !== 'unbind', phone: action === 'unbind' ? null : '+86 *******1234', has_email: true }; return { ok: true }; },
  };
  window.SunlandPhoneAuth = { text: s => s, errorText: e => e.code || '安全错误', cooldown: () => 0,
    normalizePhone: s => { if (!/^1[3-9]\d{9}$/.test(s)) throw Object.assign(new Error(), { code: 'INVALID_REQUEST' }); return s; } };
  window.eval(await readFile(new URL('../ai/phone-settings.js', import.meta.url), 'utf8'));
  const mountRoot = window.document.querySelector('#settings');
  const root = window.document.body;
  const app = window.SunlandPhoneSettings.mount(mountRoot, { client, getIdentity: async () => ({ id: identity, email: 'test@example.invalid' }), ...options });
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
  const click = async name => { const element = root.querySelector(`[data-phone="${name}"]`); assert.ok(element, name); element.click(); await flush(); };
  const fill = (name, value) => { const element = root.querySelector(`[data-phone="${name}"]`); assert.ok(element, name); element.value = value; element.dispatchEvent(new window.Event('input', { bubbles: true })); };
  await flush();
  return { dom, window, root, app, client, calls, flush, click, fill, changeIdentity: value => { identity = value; } };
}

test('settings binds phone only after existing email factor and target SMS proof', async t => {
  const f = await fixture(); t.after(() => f.dom.window.close());
  await f.click('bind');
  await f.click('send-proof'); f.fill('proof-code', '123456'); await f.click('verify-proof');
  f.fill('target-phone', '13800001234'); await f.click('send-target');
  f.fill('target-code', '654321'); await f.click('commit');
  assert.deepEqual(f.calls.map(c => c[0]), ['emailSend', 'emailProof', 'send', 'mutate']);
  assert.equal(f.calls[2][2], 'bind'); assert.equal(f.calls[3][2].reauth_token, 'proof');
  assert.match(f.root.textContent, /手机号绑定成功/);
  assert.equal(f.root.querySelector('[data-phone="target-code"]').value, '');
  assert.equal(f.window.localStorage.length, 0);
});

async function emailGrant(f, action) {
  await f.click(action); await f.click('send-proof');
  f.fill('proof-code', '123456'); await f.click('verify-proof');
}

test('settings changes phone after a fresh proof and separate change challenge', async t => {
  const f = await fixture({ bound: true, phone: '+86 *******0000', has_email: true }); t.after(() => f.dom.window.close());
  await emailGrant(f, 'change'); f.fill('target-phone', '13900001234');
  await f.click('send-target'); f.fill('target-code', '654321'); await f.click('commit');
  assert.equal(f.calls.find(c => c[0] === 'send')[2], 'change');
  assert.equal(f.calls.find(c => c[0] === 'mutate')[1], 'change');
  assert.match(f.root.textContent, /手机号更换成功/);
});

test('phone reauthentication requires the user to enter the current phone', async t => {
  const f = await fixture({ bound: true, phone: '+86 *******0000', has_email: false }); t.after(() => f.dom.window.close());
  await f.click('change'); assert.equal(f.root.querySelector('[data-phone="current-phone"]').value, '');
  f.fill('current-phone', '13800000000'); await f.click('send-proof');
  f.fill('proof-code', '123456'); await f.click('verify-proof');
  assert.deepEqual(f.calls.slice(0, 2).map(c => c[0]), ['send', 'phoneProof']);
  assert.equal(f.calls[0][2], 'reauth'); assert.equal(f.calls[1][4], 'change');
  assert.equal(f.root.querySelector('[data-phone="current-phone"]').value, '');
});

test('unbind requires email proof and explicit checkbox confirmation', async t => {
  const f = await fixture({ bound: true, phone: '+86 *******0000', has_email: true }); t.after(() => f.dom.window.close());
  await emailGrant(f, 'unbind');
  await f.click('commit'); assert.equal(f.calls.some(c => c[0] === 'mutate'), false);
  await f.click('confirm'); await f.click('commit');
  assert.equal(f.calls.find(c => c[0] === 'mutate')[1], 'unbind');
  assert.match(f.root.textContent, /手机号解绑成功/);
});

test('phone-only account cannot unbind its last login method', async t => {
  const f = await fixture({ bound: true, phone: '+86 *******0000', has_email: false }); t.after(() => f.dom.window.close());
  assert.equal(f.root.querySelector('[data-phone="unbind"]').disabled, true);
  await f.click('unbind'); assert.equal(f.root.querySelector('dialog').open, false);
  assert.match(f.root.textContent, /没有其他登录方式/);
});

test('reauth expiry clears target SMS and requires a new existing factor', async t => {
  const f = await fixture(); t.after(() => f.dom.window.close());
  await emailGrant(f, 'bind'); f.fill('target-phone', '13800001234'); await f.click('send-target');
  f.client.mutate = async () => { throw Object.assign(new Error('do not expose'), { code: 'REAUTH_INVALID' }); };
  f.fill('target-code', '654321'); await f.click('commit');
  assert.equal(f.root.querySelector('[data-phone="proof-step"]').hidden, false);
  assert.equal(f.root.querySelector('[data-phone="target-phone"]').value, '');
  assert.doesNotMatch(f.root.textContent, /do not expose/);
});

test('cancel invalidates a pending challenge and clears every temporary field', async t => {
  const f = await fixture(); t.after(() => f.dom.window.close());
  await emailGrant(f, 'bind'); let resolve;
  f.client.send = () => new Promise(r => { resolve = r; }); f.fill('target-phone', '13800001234');
  f.root.querySelector('[data-phone="send-target"]').click(); await f.flush();
  await f.click('cancel'); resolve({ challenge_id: 'late', expires_in: 300, retry_after: 60 }); await f.flush();
  assert.equal(f.root.querySelector('dialog').open, false);
  assert.equal(f.root.querySelector('[data-phone="target-phone"]').value, '');
  assert.equal(f.calls.some(c => c[0] === 'mutate'), false);
});

test('session replacement cannot apply an old phone proof', async t => {
  const f = await fixture(); t.after(() => f.dom.window.close());
  await f.click('bind'); let resolve;
  f.client.emailProof = () => new Promise(r => { resolve = r; });
  f.fill('proof-code', '123456'); f.root.querySelector('[data-phone="verify-proof"]').click(); await f.flush();
  f.changeIdentity('b'); f.window.dispatchEvent(new f.window.StorageEvent('storage', { key: 'token' }));
  resolve({ reauth_token: 'old-proof', expires_in: 300 }); await f.flush();
  assert.equal(f.root.querySelector('dialog').open, false);
  assert.equal(f.root.querySelector('[data-phone="proof-code"]').value, '');
  assert.equal(f.root.querySelector('[data-phone="commit"]').hidden, true);
});

test('unknown write result rereads status, drops proof and never resubmits', async t => {
  const f = await fixture(); t.after(() => f.dom.window.close());
  await emailGrant(f, 'bind'); f.fill('target-phone', '13800001234'); await f.click('send-target'); f.fill('target-code', '654321');
  let writes = 0, reads = 0;
  f.client.mutate = async () => { writes++; throw Object.assign(new Error(), { code: 'TIMEOUT' }); };
  f.client.status = async () => { reads++; return { bound: true, phone: '+86 *******1234', has_email: true }; };
  await f.click('commit'); await f.click('commit');
  assert.equal(writes, 1); assert.equal(reads, 1);
  assert.equal(f.root.querySelector('dialog').open, false);
  assert.match(f.root.textContent, /操作结果尚未确认/);
});

test('duplicate clicks produce one SMS request, invalid phone produces none', async t => {
  const f = await fixture(); t.after(() => f.dom.window.close()); await emailGrant(f, 'bind');
  f.fill('target-phone', 'invalid'); await f.click('send-target');
  assert.equal(f.calls.some(c => c[0] === 'send'), false);
  let resolve, sends = 0; f.client.send = () => { sends++; return new Promise(r => { resolve = r; }); };
  f.fill('target-phone', '13800001234'); f.root.querySelector('[data-phone="send-target"]').click(); f.root.querySelector('[data-phone="send-target"]').click();
  await f.flush(); assert.equal(sends, 1); resolve({ challenge_id: 'x', expires_in: 300, retry_after: 60 }); await f.flush();
});

test('server cooldown survives closing the dialog and disables SMS resend', async t => {
  const f = await fixture(); t.after(() => f.dom.window.close());
  await emailGrant(f, 'bind');
  f.window.SunlandPhoneAuth.cooldown = () => 41;
  f.fill('target-phone', '13800001234');
  assert.equal(f.root.querySelector('[data-phone="send-target"]').disabled, true);
  assert.match(f.root.querySelector('[data-phone="send-target"]').textContent, /41/);
  await f.click('cancel'); await f.click('bind');
  f.fill('proof-code', '123456'); await f.click('verify-proof'); f.fill('target-phone', '13800001234');
  assert.equal(f.root.querySelector('[data-phone="send-target"]').disabled, true);
});

test('language changes rerender source labels without persisting authentication data', async t => {
  const f = await fixture(); t.after(() => f.dom.window.close());
  f.window.SunlandPhoneAuth.text = text => ({ '手机号管理': 'Phone number', '绑定手机号': 'Link phone' }[text] || text);
  f.window.dispatchEvent(new f.window.CustomEvent('site-language-change'));
  assert.equal(f.root.querySelector('h3').textContent, 'Phone number');
  assert.equal(f.root.querySelector('[data-phone="bind"]').textContent, 'Link phone');
  assert.equal(f.window.document.querySelector('#settings').getAttribute('aria-label'), 'Phone number');
  assert.equal(f.window.localStorage.length, 0);
});

test('settings uses a nonmodal dialog so captcha portals remain interactive, with focus loop and Escape return', async t => {
  const f = await fixture(); t.after(() => f.dom.window.close());
  const dialog = f.root.querySelector('dialog');
  dialog.showModal = () => { throw new Error('native top layer blocks captcha portals'); };
  dialog.show = () => dialog.setAttribute('open', '');
  await f.click('bind'); assert.equal(dialog.open, true);
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  const first = f.root.querySelector('[data-phone="close"]'), last = f.root.querySelector('[data-phone="cancel"]');
  last.focus(); last.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  assert.equal(f.window.document.activeElement, first);
  first.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(dialog.open, false);
  assert.equal(f.window.document.activeElement, f.root.querySelector('[data-phone="bind"]'));
});

test('account retirement during a sensitive flow clears authorization and closes the dialog', async t => {
  const f = await fixture(); t.after(() => f.dom.window.close());
  await emailGrant(f, 'bind'); f.fill('target-phone', '13800001234');
  f.client.send = async () => { throw Object.assign(new Error(), { code: 'ACCOUNT_NOT_ACTIVE' }); };
  await f.click('send-target');
  assert.equal(f.root.querySelector('dialog').open, false);
  assert.equal(f.root.querySelector('[data-phone="target-phone"]').value, '');
  assert.match(f.root.querySelector('[data-phone="card-status"]').textContent, /ACCOUNT_NOT_ACTIVE/);
});

test('settings data client does not overwrite the Supabase library needed by module imports',async t=>{
 const html=await readFile(new URL('../ai_settings.html',import.meta.url),'utf8');
 const binding=html.match(/(?:var|const) \w+ = window\._supabaseClient;/)?.[0];assert.ok(binding);
 const dom=new JSDOM('',{runScripts:'outside-only'});t.after(()=>dom.window.close());
 const runtime={createClient(){return {};}};dom.window.supabase=runtime;dom.window._supabaseClient={from(){}};
 const {runInNewContext}=await import('node:vm');const context={supabase:runtime,_supabaseClient:dom.window._supabaseClient};context.window=context;runInNewContext('var supabase = window.supabase;'+binding,context);assert.equal(context.supabase,runtime);assert.equal(typeof dom.window.supabase.createClient,'function');
});
test('sensitive dialog portals outside the settings card so card filters cannot clip it',async t=>{
 const f=await fixture();t.after(()=>f.dom.window.close());await f.click('bind');
 const dialog=f.window.document.querySelector('[data-phone="dialog"]');
 assert.equal(f.window.document.querySelector('#settings').contains(dialog),false);
 assert.equal(dialog.parentElement.parentElement,f.window.document.body);
});

test('concurrent settings identity initialization cannot leave phone status permanently loading',async t=>{
 let calls=0;const f=await fixture(undefined,{getIdentity:async()=>++calls===1?null:{id:'a',email:'test@example.invalid'}});t.after(()=>f.dom.window.close());
 assert.equal(f.root.querySelector('[data-phone="bind"]').hidden,false);assert.equal(calls,2);
});
