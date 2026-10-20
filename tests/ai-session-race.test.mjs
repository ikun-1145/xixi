import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { IdentityAuthority, getVerifiedToken, getVerifiedUserId, isVerifiedIdentity } from '../ai/verified-identity.js';
import { RequestCoordinator } from '../ai/request-context.js';

const source = fs.readFileSync(new URL('../ai/app.js', import.meta.url), 'utf8');
const fixtureExpiry = Math.floor(Date.now() / 1000) + 3600;
const tokenFor = (id, version = 1) => {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'test' })}.${encode({ id, version, exp: fixtureExpiry })}.fixture`;
};
const responseFor = (id, version = 1) => Response.json({ token: tokenFor(id, version), user: { id } });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function harness(initialToken = tokenFor('A'), values = new Map()) {
  if (initialToken) values.set('token', initialToken);
  const effects = [], listeners = new Map(), refreshes = [];
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
  const authority = new IdentityAuthority({ fetchImpl: () => {
    const request = deferred(); refreshes.push(request); return request.promise;
  } });
  const noop = () => {};
  const context = vm.createContext({
    IdentityAuthority, getVerifiedToken, getVerifiedUserId, isVerifiedIdentity,
    identityAuthority: authority, localStorage: storage, sessionStorage: storage,
    session: null, sessionToken: storage.getItem('token'), sessionGeneration: 0,
    historySessionGeneration: 0, restoreVersion: 0, checkLoginPromise: null,
    restoreLoginPromise: null, restoreLoginPromiseVersion: 0,
    stopProActivationPolling: null, deletedConversationIds: new Set(), deletingConversationIds: new Set(),
    history: [{ role: 'system' }], conversations: [], currentId: null, currentProfile: null,
    pendingFiles: [], syncTimer: null, chatRenderVersion: 0, accountBanned: false,
    usageVersion: 0, hideGlobalLoading: noop, sessionReady: false, lastIdentityErrorReason: '',
    requestCoordinator: { requests: new Map(), abort: noop, finish: noop },
    chatInner: { replaceChildren: () => effects.push('clear-chat'), style: {} },
    input: { value: '' }, deepMode: false,
    window: { addEventListener: (event, handler) => listeners.set(event, handler) },
    document: { getElementById: () => null },
    stopAccountBanRealtime: noop, updateDeepButton: noop, updateRequestUiState: noop,
    clearPendingAttachments: noop, renderChatList: () => effects.push('render-list'),
    scheduleRenderUser: () => effects.push('render-user'), updateProviderCapabilityUI: noop,
    bumpRestoreVersion: () => ++context.restoreVersion,
    isRestoreStale: version => version != null && version !== context.restoreVersion,
    sunlandDiagnosticsRuntime: { initialize: async () => {} },
    preserveSunlandLegacyState: () => effects.push('legacy'),
    loadCachedProfile: () => null, loadUserProfileFromCloud: async () => effects.push('profile'),
    restoreLocalConversationState: () => ({ conversations: [], currentId: null }),
    getHistoryVault: () => ({ snapshot: { records: [], currentId: null } }),
    syncFromCloud: async () => effects.push('sync'), checkActivation: async () => {},
    startActivationPolling: noop, loadChat: () => effects.push('load-chat'),
    showToast: () => effects.push('toast'), SUNLAND_LOGIN_STATE_MESSAGE: 'fixture',
    console: { log: noop, warn: noop, error: noop }, clearTimeout, Headers,
    alert: () => effects.push('alert'), goToLogin: () => effects.push('login-redirect'),
    fetch: async () => Response.json({ ok: true }),
    restoreLoginState: options => context.checkLogin(options),
  });
  vm.runInContext(source.slice(source.indexOf('function captureSessionState()'), source.indexOf('let isActivated =')), context);
  vm.runInContext(source.slice(source.indexOf('async function checkLogin('), source.indexOf('function renderUserCore(')), context);
  vm.runInContext(source.slice(source.indexOf('async function authenticatedFetch('), source.indexOf('async function apiFetch(')), context);
  const start = source.indexOf('window.addEventListener("storage", event => {');
  vm.runInContext(source.slice(start, source.indexOf('function getHistoryVault(', start)), context);
  return {
    context, values, effects, refreshes, storage, authority,
    resolve: options => context.resolveIdentityResult({ token: storage.getItem('token'), ...options }),
    external(token, key = 'token') {
      if (token == null) values.delete('token'); else values.set('token', token);
      listeners.get('storage')({ key, newValue: token, storageArea: storage });
    },
  };
}

test('a late A refresh cannot overwrite a newer B login even before its storage event', async () => {
  const app = harness();
  const pending = app.resolve();
  app.values.set('token', tokenFor('B'));
  app.values.set('user', JSON.stringify({ id: 'B' }));
  app.refreshes[0].resolve(responseFor('A', 2));
  assert.equal((await pending).reason, 'stale-resolution');
  assert.equal(app.values.get('token'), tokenFor('B'));
  assert.equal(app.authority.current(), null);
  assert.equal(app.context.session, null);
  assert.deepEqual(app.effects, []);
});

for (const outcome of ['success', '401', 'timeout']) {
  test(`checkLogin ignores late A ${outcome} after B login`, async () => {
    const app = harness();
    const pending = app.context.checkLogin({ waitForUserState: true });
    app.values.set('token', tokenFor('B'));
    app.values.set('user', JSON.stringify({ id: 'B' }));
    if (outcome === 'timeout') app.refreshes[0].reject(new Error('fixture timeout'));
    else app.refreshes[0].resolve(outcome === '401' ? new Response('', { status: 401 }) : responseFor('A', 2));
    await pending;
    assert.equal(app.values.get('token'), tokenFor('B'));
    assert.equal(app.context.session, null);
    assert.deepEqual(app.effects, []);
  });
}

test('logout in another tab revokes pending refresh and cannot be undone', async () => {
  const app = harness();
  const pending = app.resolve();
  app.external(null);
  await app.context.checkLoginPromise;
  app.effects.length = 0;
  app.refreshes[0].resolve(responseFor('A', 2));
  assert.equal((await pending).reason, 'stale-resolution');
  assert.equal(app.values.has('token'), false);
  assert.equal(app.context.session, null);
  assert.deepEqual(app.effects, []);
});

test('storage login switches to B immediately without waiting for A refresh', async () => {
  const app = harness();
  const old = app.context.checkLogin();
  app.external(tokenFor('B'));
  assert.equal(app.refreshes.length, 2);
  app.refreshes[1].resolve(responseFor('B', 2));
  await app.context.checkLoginPromise;
  assert.equal(app.context.session.userId, 'B');
  app.effects.length = 0;
  app.refreshes[0].resolve(new Response('', { status: 401 }));
  await old;
  assert.equal(app.context.session.userId, 'B');
  assert.equal(app.values.get('token'), tokenFor('B'));
  assert.deepEqual(app.effects, []);
});

test('page reload recovery coalesces duplicate refreshes and loads only current user data', async () => {
  const app = harness();
  const first = app.context.checkLogin({ waitForUserState: true });
  const second = app.context.checkLogin();
  assert.equal(app.refreshes.length, 1);
  app.refreshes[0].resolve(responseFor('A', 2));
  await Promise.all([first, second]);
  assert.equal(app.context.session.userId, 'A');
  assert.equal(app.values.get('token'), tokenFor('A', 2));
  assert.ok(app.effects.includes('profile'));
  assert.ok(app.effects.includes('sync'));
});

test('late API 401 and network failure cannot clear or redirect a newer session', async () => {
  for (const outcome of ['401', 'timeout']) {
    const app = harness();
    const login = app.resolve(); app.refreshes[0].resolve(responseFor('A')); await login;
    const response = deferred(); app.context.fetch = () => response.promise;
    const pending = app.context.authenticatedFetch('https://fixture.invalid');
    app.values.set('token', tokenFor('B'));
    app.effects.length = 0;
    if (outcome === 'timeout') response.reject(new Error('fixture timeout'));
    else response.resolve(new Response('', { status: 401 }));
    assert.equal(await pending, null);
    assert.equal(app.values.get('token'), tokenFor('B'));
    assert.deepEqual(app.effects, []);
  }
});

test('API refresh failure after B login does not remove B credentials', async () => {
  const app = harness();
  const login = app.resolve(); app.refreshes[0].resolve(responseFor('A')); await login;
  app.context.fetch = async () => new Response('', { status: 401 });
  const pending = app.context.authenticatedFetch('https://fixture.invalid');
  await new Promise(resolve => setImmediate(resolve));
  app.values.set('token', tokenFor('B'));
  app.effects.length = 0;
  app.refreshes[1].resolve(new Response('', { status: 401 }));
  assert.equal(await pending, null);
  assert.equal(app.values.get('token'), tokenFor('B'));
  assert.deepEqual(app.effects, []);
});

test('a cleared authority starts a fresh request even when the same token returns', async () => {
  const requests = [];
  const authority = new IdentityAuthority({ fetchImpl: () => {
    const next = deferred(); requests.push(next); return next.promise;
  } });
  const first = authority.resolve({ token: tokenFor('A') });
  authority.clear();
  const second = authority.resolve({ token: tokenFor('A') });
  assert.equal(requests.length, 2);
  requests[0].resolve(responseFor('A'));
  assert.equal((await first).reason, 'stale-resolution');
  const third = authority.resolve({ token: tokenFor('A') });
  assert.equal(requests.length, 2);
  requests[1].resolve(responseFor('A', 2));
  const results = await Promise.all([second, third]);
  assert.ok(results.every(result => result.ok));
});

test('changing credentials during refresh JSON parsing cannot establish old identity', async () => {
  const app = harness();
  const body = deferred(), pending = app.resolve();
  app.refreshes[0].resolve({ ok: true, json: () => body.promise });
  await Promise.resolve();
  app.values.delete('token');
  body.resolve({ token: tokenFor('A'), user: { id: 'A' } });
  assert.equal((await pending).reason, 'stale-resolution');
  assert.equal(app.authority.current(), null);
  assert.equal(app.values.has('token'), false);
});

test('concurrent authenticated calls share one refresh and both complete without signing out', async () => {
  const app = harness();
  const requests = [];
  app.context.fetch = async (_url, init) => { requests.push(init.headers.authorization); return Response.json({ ok: true }); };
  const first = app.context.authenticatedFetch('https://fixture.invalid/one');
  const second = app.context.authenticatedFetch('https://fixture.invalid/two');
  assert.equal(app.refreshes.length, 1);
  app.refreshes[0].resolve(responseFor('A', 2));
  const results = await Promise.all([first, second]);
  assert.ok(results.every(result => result?.ok));
  assert.deepEqual(requests, [1, 2].map(() => `Bearer ${tokenFor('A', 2)}`));
  assert.equal(app.context.session.userId, 'A');
});

test('a current-session timeout retains credentials and a subsequent refresh can recover', async () => {
  const app = harness();
  const first = app.resolve({ force: true });
  app.refreshes[0].reject(new Error('fixture timeout'));
  assert.equal((await first).reason, 'verification-unavailable');
  assert.equal(app.values.get('token'), tokenFor('A'));
  const retry = app.resolve({ force: true });
  app.refreshes[1].resolve(responseFor('A', 2));
  assert.equal((await retry).ok, true);
  assert.equal(app.context.session.userId, 'A');
});

test('storage clear and A to B to A invalidate old work despite the same final user and token', async () => {
  const app = harness();
  const old = app.resolve();
  app.external(null, null);
  await app.context.checkLoginPromise;
  app.external(tokenFor('B'));
  const b = app.context.checkLoginPromise;
  app.external(tokenFor('A'));
  const a = app.context.checkLoginPromise;
  app.refreshes[2].resolve(responseFor('A'));
  await a;
  app.effects.length = 0;
  app.refreshes[1].resolve(responseFor('B'));
  app.refreshes[0].resolve(responseFor('A'));
  await b;
  assert.equal((await old).reason, 'stale-resolution');
  assert.equal(app.context.session.userId, 'A');
  assert.deepEqual(app.effects, []);
});

test('old profile success and failure cannot mutate a new A session after A to B to A', async () => {
  for (const outcome of ['success', 'failure']) {
    const app = harness();
    const initial = app.resolve(); app.refreshes[0].resolve(responseFor('A')); await initial;
    const profile = deferred();
    const query = { select() { return query; }, eq() { return query; }, maybeSingle: () => profile.promise };
    app.context.supabase = { from: () => query };
    app.context.cacheProfile = () => app.effects.push('cache-profile');
    app.context.startAccountBanRealtime = () => app.effects.push('realtime');
    vm.runInContext(source.slice(source.indexOf('async function loadUserProfileFromCloud()'), source.indexOf('function getAvatarUrl(')), app.context);
    const old = app.context.loadUserProfileFromCloud();
    app.external(tokenFor('B'));
    const b = app.context.checkLoginPromise;
    app.external(tokenFor('A'));
    const a = app.context.checkLoginPromise;
    // Avoid initiating a new profile request: this test isolates the old response.
    app.context.loadUserProfileFromCloud = async () => {};
    app.refreshes[2].resolve(responseFor('A')); await a;
    app.effects.length = 0;
    if (outcome === 'failure') profile.reject(new Error('old fixture failure'));
    else profile.resolve({ data: { name: 'OLD PROFILE', is_banned: true }, error: null });
    await old;
    assert.deepEqual(app.effects, []);
    assert.equal(app.context.currentProfile, null);
    app.refreshes[1].resolve(responseFor('B')); await b;
  }
});

test('request writes remain valid across normal token refresh but not across a new session', async () => {
  const app = harness();
  const login = app.resolve(); app.refreshes[0].resolve(responseFor('A')); await login;
  const conversation = { id: 1, provider: 'deepseek', userId: 'A', history: [] };
  const coordinator = new RequestCoordinator({ getConversation: () => conversation,
    getCurrentUserId: () => app.context.getCurrentUserId(), getSessionGeneration: () => app.context.sessionGeneration });
  const request = coordinator.begin({ conversation, identity: app.context.session.identity, userId: 'A', providerId: 'deepseek' });
  const renewed = app.resolve({ force: true }); app.refreshes[1].resolve(responseFor('A', 2)); await renewed;
  assert.equal(coordinator.canWrite(request), true);
  app.context.clearVerifiedSession();
  const restored = app.resolve(); app.refreshes[2].resolve(responseFor('A', 2)); await restored;
  assert.equal(coordinator.canWrite(request), false);
  assert.equal(coordinator.appendMessage(request, { role: 'assistant', content: 'old private answer' }), false);
  assert.deepEqual(conversation.history, []);
});

test('focus recovery notices a same-tab credential change before allocating its restore version', async () => {
  const app = harness();
  app.context.bumpRestoreVersion = () => ++app.context.restoreVersion;
  app.context.finalizeRenderUser = () => app.effects.push('final-render');
  const start = source.indexOf('async function restoreLoginState(');
  vm.runInContext(source.slice(start, source.indexOf('window.addEventListener("focus"', start)), app.context);
  app.values.set('token', tokenFor('B'));
  const restore = app.context.restoreLoginState();
  assert.equal(app.refreshes.length, 1);
  app.refreshes[0].resolve(responseFor('B'));
  await restore;
  assert.equal(app.context.session.userId, 'B');
  assert.ok(app.effects.includes('final-render'));
});

test('external credential verification does not broadcast another token and cause refresh echo', async () => {
  const app = harness();
  app.external(tokenFor('B'));
  app.refreshes[0].resolve(responseFor('B', 2));
  await app.context.checkLoginPromise;
  assert.equal(app.values.get('token'), tokenFor('B'));
  assert.equal(app.context.session.identity.token, tokenFor('B'));
  assert.equal(app.context.session.userId, 'B');
});

for (const status of [200, 401]) {
  test(`normal same-user renewal preserves another in-flight ${status} response`, async () => {
    const app = harness();
    const login = app.resolve(); app.refreshes[0].resolve(responseFor('A')); await login;
    const responses = [deferred(), deferred()];
    // Use the real membership request guard too: token renewal invalidates its snapshot.
    Object.assign(app.context, { URL, AbortSignal, atob });
    Object.assign(app.context.window, { localStorage: app.storage, setTimeout, clearTimeout });
    vm.runInContext(fs.readFileSync(new URL('../ai/pro-payment.js', import.meta.url), 'utf8'), app.context);
    app.context.window.SunlandProPayment.setIdentity('A', tokenFor('A'));
    let calls = 0;
    app.context.fetch = () => ++calls <= 2 ? responses[calls - 1].promise : Promise.resolve(Response.json({ ok: true }));
    const first = app.context.authenticatedFetch('https://fixture.invalid/one');
    const second = app.context.authenticatedFetch('https://fixture.invalid/two');
    responses[0].resolve(new Response('', { status: 401 }));
    await new Promise(resolve => setImmediate(resolve));
    app.refreshes[1].resolve(responseFor('A', 2));
    assert.equal((await first).ok, true);
    responses[1].resolve(Response.json({ ok: true }, { status }));
    assert.equal((await second)?.ok, true);
    assert.equal(app.refreshes.length, 2);
    assert.equal(app.values.get('token'), tokenFor('A', 2));
  });
}
