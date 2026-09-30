import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const source = readFileSync(new URL('../ai/pro-payment.js', import.meta.url), 'utf8');
function load() {
  const storage = new Map([['token', 'credential-A']]);
  const window = { localStorage: { getItem: k => storage.get(k) || null }, setTimeout, clearTimeout,
    addEventListener() {}, removeEventListener() {} };
  vm.runInNewContext(source, { window, Date, URL, AbortSignal, atob });
  return { api: window.SunlandProPayment, window, storage };
}
test('temporary membership errors retain confirmed Pro and never manufacture Free', async () => {
  const { api } = load(); api.setIdentity('A', 'credential-A');
  assert.equal(api.getState().state, 'UNKNOWN');
  api.applyMembership(true, api.captureRequest());
  await api.refreshMembership({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: new Error('offline') }) }) }) }) });
  assert.equal(api.getState().state, 'PRO'); assert.equal(api.getState().stale, true);
  api.applyMembership(false, api.captureRequest()); assert.equal(api.getState().state, 'FREE');
});
test('A to B to A and credential renewal reject old membership responses', () => {
  const { api, storage } = load(); api.setIdentity('A', 'credential-A');
  const old = api.captureRequest();
  storage.set('token', 'credential-B'); api.setIdentity('B', 'credential-B');
  storage.set('token', 'credential-A'); api.setIdentity('A', 'credential-A');
  assert.equal(api.applyMembership(true, old), false);
  assert.equal(api.getState().state, 'UNKNOWN');
  const previousCredential = api.captureRequest();
  storage.set('token', 'renewed-A'); api.setIdentity('A', 'renewed-A');
  assert.equal(api.applyMembership(true, previousCredential), false);
});
test('explicit Pro denial invalidates older Pro reads and accepts only strict booleans', () => {
  const { api } = load(); api.setIdentity('A', 'credential-A');
  const old = api.captureRequest(); api.requireProFree();
  assert.equal(api.applyMembership(true, old), false);
  assert.equal(api.getState().state, 'FREE');
  assert.equal(api.applyMembership('true', api.captureRequest()), false);
});
test('reconcile runs without a local pending hint and preserves Pro on 503 or wrong owner', async () => {
  const { api, window } = load(); api.setIdentity('A', 'credential-A');
  api.applyMembership(true, api.captureRequest());
  let calls = 0;
  window.fetch = async (url, init) => { calls++; assert.equal(init.body, '{}'); assert.equal(init.headers.Authorization, 'Bearer credential-A'); return { ok: false, status: 503 }; };
  await api.reconcile(); assert.equal(calls, 1); assert.equal(api.getState().state, 'PRO'); assert.equal(api.getState().stale, true);
  const other = load(); other.api.setIdentity('A', 'credential-A');
  other.api.applyMembership(true, other.api.captureRequest());
  other.window.fetch = async () => ({ ok: true, json: async () => ({ user_id: 'B', membership: { state: 'confirmed', pro: false } }) });
  await other.api.reconcile(); assert.equal(other.api.getState().state, 'PRO');
});

test('unknown membership remains unknown on null profile and temporary reconcile failures', async () => {
  const { api, window } = load(); api.setIdentity('A', 'credential-A');
  await api.refreshMembership({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) });
  assert.equal(api.getState().state, 'UNKNOWN');
  for (const status of [429, 503, 403]) {
    const candidate = load(); candidate.api.setIdentity('A', 'credential-A');
    candidate.window.fetch = async () => ({ ok: false, status, json: async () => ({ error: 'temporary' }) });
    await candidate.api.reconcile(); assert.equal(candidate.api.getState().state, 'UNKNOWN'); assert.equal(candidate.api.getState().stale, true);
  }
});
test('confirmed reconcile and usage observations share one state while late replies cannot undo them', async () => {
  const { api, window } = load(); api.setIdentity('A', 'credential-A');
  let finish;
  window.fetch = () => new Promise(resolve => { finish = resolve; });
  const reconcile = api.reconcile();
  api.applyMembership(true, api.captureRequest());
  finish({ ok: true, json: async () => ({ user_id: 'A', membership: { state: 'confirmed', pro: false } }) });
  await reconcile; assert.equal(api.getState().state, 'PRO');
  window.fetch = async () => ({ ok: true, json: async () => ({ user_id: 'A', membership: { state: 'confirmed', pro: false }, payment_sync: { status: 'processing', paid_order_pending: true } }) });
  await api.reconcile(); assert.equal(api.getState().state, 'FREE'); assert.equal(api.getState().paymentSync.paid_order_pending, true);
});

const appSource = readFileSync(new URL('../ai/app.js', import.meta.url), 'utf8');
test('an authenticated request whose refresh temporarily fails never removes credentials or redirects', async () => {
  const { api, window } = load(); api.setIdentity('A', 'credential-A'); api.applyMembership(true, api.captureRequest());
  let removed = 0, redirected = 0;
  const context = vm.createContext({ window, Headers, fetch: async () => new Response('', { status: 401 }),
    localStorage: { getItem: () => 'credential-A', removeItem: () => { removed++; } },
    getCurrentUserId: () => 'A', getCurrentVerifiedIdentity: () => ({ token: 'credential-A' }),
    getVerifiedToken: value => value?.token, session: { userId: 'A' },
    resolveIdentityResult: async () => ({ ok: false, reason: 'verification-unavailable' }),
    alert() {}, goToLogin: () => { redirected++; }, checkActivation() {} });
  vm.runInContext(appSource.slice(appSource.indexOf('async function authenticatedFetch('), appSource.indexOf('async function apiFetch(')), context);
  await assert.rejects(vm.runInContext("authenticatedFetch('https://api.sunland.dev')", context), /verification-unavailable/);
  assert.equal(removed, 0); assert.equal(redirected, 0); assert.equal(api.getState().state, 'PRO'); assert.equal(api.getState().stale, true);
});
test('only an explicit current Pro denial changes membership, unrelated forbidden responses preserve it', async () => {
  const { api, window } = load(); api.setIdentity('A', 'credential-A'); api.applyMembership(true, api.captureRequest());
  let code = 'TEMPORARY', refreshes = 0;
  const context = vm.createContext({ window, Headers, fetch: async () => Response.json({ error: code }, { status: 403 }),
    localStorage: { getItem: () => 'credential-A' }, getCurrentUserId: () => 'A',
    getCurrentVerifiedIdentity: () => ({ token: 'credential-A' }), getVerifiedToken: value => value?.token,
    checkActivation: () => { refreshes++; } });
  vm.runInContext(appSource.slice(appSource.indexOf('async function authenticatedFetch('), appSource.indexOf('async function apiFetch(')), context);
  await vm.runInContext("authenticatedFetch('https://api.sunland.dev')", context);
  assert.equal(api.getState().state, 'PRO'); assert.equal(refreshes, 0);
  code = 'PRO_REQUIRED';
  await vm.runInContext("authenticatedFetch('https://api.sunland.dev')", context);
  assert.equal(api.getState().state, 'FREE'); assert.equal(refreshes, 1);
});
test('login restoration preserves a verified session during temporary identity verification outages', async () => {
  const { api, window } = load(); api.setIdentity('A', 'credential-A'); api.applyMembership(true, api.captureRequest());
  let clears = 0, removed = 0;
  const context = vm.createContext({ window, getCurrentUserId: () => 'A', checkLoginPromise: null,
    localStorage: { getItem: () => 'credential-A', removeItem: () => { removed++; } },
    identityAuthority: { resolve: async () => ({ ok: false, reason: 'verification-unavailable' }), clear: () => { clears++; } },
    readCachedDisplayUser: () => ({ id: 'A' }), isVerifiedIdentity: () => false,
    scheduleRenderUser() {}, sessionReady: false });
  vm.runInContext(appSource.slice(appSource.indexOf('async function checkLogin('), appSource.indexOf('function renderUserCore(')), context);
  await vm.runInContext('checkLogin()', context);
  assert.equal(clears, 0); assert.equal(removed, 0); assert.equal(context.sessionReady, true);
  assert.equal(api.getState().state, 'PRO'); assert.equal(api.getState().stale, true);
});

test('changed credentials become Unknown before an unavailable new identity check can retain old Pro', async () => {
  const { api, window, storage } = load(); api.setIdentity('A', 'credential-A'); api.applyMembership(true, api.captureRequest());
  const old = api.captureRequest(); storage.set('token', 'credential-B');
  const context = vm.createContext({ window, getCurrentUserId: () => 'A', checkLoginPromise: null,
    localStorage: window.localStorage, identityAuthority: { resolve: async () => ({ ok: false, reason: 'verification-unavailable' }) },
    readCachedDisplayUser: () => ({ id: 'A' }), isVerifiedIdentity: () => false, scheduleRenderUser() {}, sessionReady: false });
  vm.runInContext(appSource.slice(appSource.indexOf('async function checkLogin('), appSource.indexOf('function renderUserCore(')), context);
  await vm.runInContext('checkLogin()', context);
  assert.equal(api.getState().state, 'UNKNOWN'); assert.equal(api.applyMembership(true, old), false);
});

function clockHarness({ pendingStartedAt = null } = {}) {
  let now = 1000000, id = 0;
  const timers = new Map(), listeners = new Map();
  const clockDate = class extends Date { static now() { return now; } };
  const window = { localStorage: { getItem: key => key === 'token' ? 'credential-A'
    : key === 'sunland:pro-payment-pending:A' && pendingStartedAt !== null
      ? JSON.stringify({ paymentReference: '11111111-2222-4333-8444-555555555555', startedAt: pendingStartedAt }) : null },
    setTimeout: (callback, delay) => { const handle = ++id; timers.set(handle, { callback, at: now + delay }); return handle; },
    clearTimeout: handle => timers.delete(handle),
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: name => listeners.delete(name),
    document: { visibilityState: 'visible', addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name) } };
  vm.runInNewContext(source, { window, Date: clockDate, URL, AbortSignal, atob });
  const api = window.SunlandProPayment; api.setIdentity('A', 'credential-A');
  const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
  const advance = async ms => {
    const target = now + ms;
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at).find(([, timer]) => timer.at <= target);
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].callback(); await flush();
    }
    now = target; await flush();
  };
  return { api, window, timers, listeners, flush, advance };
}
const confirmedFree = () => ({ ok: true, status: 200,
  json: async () => ({ user_id: 'A', membership: { state: 'confirmed', pro: false } }) });
test('a fresh device without pending gets at most five automatic reconciliation requests', async () => {
  const h = clockHarness(); let calls = 0;
  h.window.fetch = async () => { calls++; return confirmedFree(); };
  h.api.startActivationMonitoring({ getExpectedUserId: () => 'A' }); await h.flush();
  await h.advance(10 * 60 * 1000);
  assert.equal(calls, 5); assert.equal(h.timers.size, 0);
  assert.ok(h.listeners.has('focus'), 'focus recovery remains available after the automatic window');
  h.listeners.get('focus')(); await h.flush(); assert.equal(calls, 6);
});
test('Retry-After takes priority and neither manual nor focus bypasses 429 cooldown', async () => {
  const h = clockHarness(); let calls = 0;
  h.api.applyMembership(true, h.api.captureRequest());
  h.window.fetch = async () => { calls++; return { ok: false, status: 429,
    headers: { get: name => name.toLowerCase() === 'retry-after' ? '120' : null },
    json: async () => ({ retry_after_seconds: 1 }) }; };
  h.api.startActivationMonitoring({ getExpectedUserId: () => 'A' }); await h.flush();
  await h.advance(119000); await h.api.reconcile();
  h.listeners.get('focus')?.(); await h.flush();
  assert.equal(calls, 1); assert.equal(h.api.getState().state, 'PRO'); assert.equal(h.api.getState().stale, true);
  await h.advance(1000); assert.equal(calls, 2);
});
test('the ten minute deadline removes its timer even when provider cooldown prevents five attempts', async () => {
  const h = clockHarness(); let calls = 0;
  h.window.fetch = async () => { calls++; return { ok: false, status: 503,
    json: async () => ({ retry_after_seconds: 999999 }) }; };
  h.api.startActivationMonitoring({ getExpectedUserId: () => 'A' }); await h.flush();
  await h.advance(10 * 60 * 1000);
  assert.equal(calls, 1); assert.equal(h.timers.size, 0);
  await h.api.reconcile(); assert.equal(calls, 2, 'manual recovery may resume after bounded cooldown ends');
});

test('five automatic requests retain one support deadline without further provider polling', async () => {
  const h = clockHarness({ pendingStartedAt: 1000000 }); let calls = 0, hints = 0;
  h.window.fetch = async () => { calls++; return confirmedFree(); };
  h.api.startActivationMonitoring({ getExpectedUserId: () => 'A', onTimeout: () => { hints++; } });
  await h.flush(); await h.advance(599999);
  assert.equal(calls, 5); assert.equal(hints, 0); assert.equal(h.timers.size, 1);
  await h.advance(1); assert.equal(hints, 1); assert.equal(h.timers.size, 0);
  await h.advance(600000); assert.equal(calls, 5); assert.equal(hints, 1);
});
test('confirmed Pro and an identity epoch change cancel the support deadline', async () => {
  for (const cancel of ['activation', 'identity']) {
    const h = clockHarness({ pendingStartedAt: 1000000 }); let hints = 0;
    h.window.fetch = async () => confirmedFree();
    h.api.startActivationMonitoring({ getExpectedUserId: () => 'A', onTimeout: () => { hints++; } });
    await h.flush(); await h.advance(15000);
    if (cancel === 'activation') h.api.applyMembership(true, h.api.captureRequest());
    else h.api.setIdentity('B', 'credential-A');
    assert.equal(h.timers.size, 0, cancel);
    await h.advance(600000); assert.equal(hints, 0, cancel);
  }
});

test('canonical inactive identity clears current membership and database token cache while temporary 403 preserves Pro', async () => {
  for (const code of ['ACCOUNT_NOT_ACTIVE', 'ACCOUNT_INACTIVE', 'TEMPORARY']) {
    const { api, window } = load(); let clears = 0;
    api.setIdentity('A', 'credential-A'); api.applyMembership(true, api.captureRequest());
    window.SunlandDatabaseToken = { clear: () => { clears++; } };
    window.fetch = async () => ({ ok: false, status: 403, json: async () => ({ error: code }) });
    await api.reconcile();
    assert.equal(api.getState().state, code === 'TEMPORARY' ? 'PRO' : 'UNKNOWN', code);
    assert.equal(api.getState().userId, code === 'TEMPORARY' ? 'A' : null, code);
    assert.equal(clears, code === 'TEMPORARY' ? 0 : 1, code);
    if (code === 'TEMPORARY') assert.equal(api.getState().stale, true);
  }
});
test('a previous identity epoch inactive reply cannot clear the newly verified user', async () => {
  const { api, window, storage } = load(); let clears = 0, finish;
  api.setIdentity('A', 'credential-A');
  window.SunlandDatabaseToken = { clear: () => { clears++; } };
  window.fetch = () => new Promise(resolve => { finish = resolve; });
  const request = api.reconcile();
  storage.set('token', 'credential-B'); api.setIdentity('B', 'credential-B');
  api.applyMembership(true, api.captureRequest());
  finish({ ok: false, status: 403, json: async () => ({ error: 'ACCOUNT_NOT_ACTIVE' }) });
  await request;
  assert.equal(api.getState().userId, 'B'); assert.equal(api.getState().state, 'PRO'); assert.equal(clears, 0);
});
