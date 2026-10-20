import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { inspect } from 'node:util';

const secrets = {
  access_token: 'fixture-access-token-private',
  refresh_token: 'fixture-refresh-token-private',
  code: 'fixture-authorization-code-private',
  email: 'fixture-private@example.invalid'
};

async function runCallback(file, { session = secrets, search = '', response, fetchError } = {}) {
  const html = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter(match => !/\bsrc=/.test(match[1]))
    .map(match => match[2].replace(/^\s*import .*;\s*$/gm, ''));
  const logs = [];
  const events = new Map();
  const stored = new Map();
  const requests = [];
  const redirects = [];
  const app = { innerText: '' };
  let sessionCalls = 0;
  const context = vm.createContext({
    console: Object.fromEntries(['log', 'warn', 'error', 'info', 'debug'].map(level =>
      [level, (...args) => logs.push({ level, args })])),
    document: {
      body: { classList: { add() {} } },
      getElementById: id => id === 'app' ? app : null,
      querySelectorAll: () => []
    },
    window: { addEventListener: (event, handler) => events.set(event, handler) },
    location: { search, pathname: `/${file}`, replace: target => redirects.push(target) },
    history: { replaceState() {} },
    localStorage: {
      getItem: key => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, value),
      removeItem: key => stored.delete(key)
    },
    sessionStorage: { getItem: () => null, removeItem() {} },
    URLSearchParams,
    setTimeout: callback => callback(),
    supabase: { auth: { getSession: async () => {
      sessionCalls++;
      return { data: { session } };
    } } },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (fetchError) throw fetchError;
      return { status: 200, text: async () => JSON.stringify(response ?? {
        supabase_token: secrets.access_token,
        refresh_token: secrets.refresh_token,
        user: { email: secrets.email }
      }) };
    }
  });
  for (const script of scripts) {
    await vm.runInContext(`(async () => { ${script}\n })()`, context);
  }
  await events.get('DOMContentLoaded')?.();
  return { logs, stored, requests, redirects, app, sessionCalls, location: context.location };
}

function assertPrivateLogs(logs) {
  const output = inspect(logs, { depth: null });
  for (const value of Object.values(secrets)) {
    assert.equal(output.includes(value), false, '回调日志不得包含模拟凭据或邮箱');
  }
  assert.doesNotMatch(output, /access_token|refresh_token|supabase_token/);
}

test('OAuth callback keeps redirect and session restoration without logging private session', async () => {
  const result = await runCallback('oauth-callback.html', { search: '?redirect=ai' });
  assert.deepEqual(result.redirects, ['/ai.html']);
  assert.equal(result.sessionCalls, 1);
  assertPrivateLogs(result.logs);
});

test('OAuth callback still retries a missing session and uses its fallback redirect', async () => {
  const result = await runCallback('oauth-callback.html', { session: null });
  assert.equal(result.sessionCalls, 10);
  assert.deepEqual(result.redirects, ['/index.html']);
  assertPrivateLogs(result.logs);
});

test('VDS callback exchanges code and persists token without logging credentials or raw response', async () => {
  const result = await runCallback('vds-callback.html', { search: `?code=${secrets.code}` });
  assert.equal(result.requests[0].url, '/vds-login');
  assert.deepEqual(JSON.parse(result.requests[0].options.body), { code: secrets.code });
  assert.equal(result.stored.get('token'), secrets.access_token);
  assert.deepEqual(JSON.parse(result.stored.get('user')), { email: secrets.email });
  assert.equal(result.location.href, '/ai.html');
  assertPrivateLogs(result.logs);
});

test('VDS callback preserves denied-login behavior without logging raw server error', async () => {
  const result = await runCallback('vds-callback.html', {
    search: `?code=${secrets.code}`,
    response: { error: secrets.refresh_token }
  });
  assert.equal(result.stored.size, 0);
  assert.equal(result.app.innerText, `登录失败：${secrets.refresh_token}`);
  assertPrivateLogs(result.logs);
});

test('VDS callback does not log exception objects containing credentials', async () => {
  const error = Object.assign(new Error(secrets.access_token), secrets);
  const result = await runCallback('vds-callback.html', {
    search: '?code=mock-code', fetchError: error
  });
  assert.equal(result.stored.size, 0);
  assert.equal(result.app.innerText, `错误：${secrets.access_token}`);
  assertPrivateLogs(result.logs);
});

test('VDS callback with no code does not call its login endpoint', async () => {
  const result = await runCallback('vds-callback.html');
  assert.equal(result.requests.length, 0);
  assert.equal(result.app.innerText, '没有 code');
  assertPrivateLogs(result.logs);
});
