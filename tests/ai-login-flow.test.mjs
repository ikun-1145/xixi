import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const aiHtml = fs.readFileSync(new URL('../ai.html', import.meta.url), 'utf8');
const loginHtml = fs.readFileSync(new URL('../login.html', import.meta.url), 'utf8');
const aiAppJs = fs.readFileSync(new URL('../ai/app.js', import.meta.url), 'utf8');

function createMockStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
    dump() {
      return Object.fromEntries(map.entries());
    }
  };
}

function base64urlJson(data) {
  return Buffer.from(JSON.stringify(data), 'utf8')
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function createJwt(payload) {
  return `${base64urlJson({ alg: 'none', typ: 'JWT' })}.${base64urlJson(payload)}.sig`;
}

function getAiGuardScript() {
  const scripts = [...aiHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  return scripts.find(script => script.includes('function restoreUserFromToken'));
}

function runAiGuard(initialStorage) {
  const storage = createMockStorage(initialStorage);
  const redirects = [];
  const context = {
    window: {},
    localStorage: storage,
    location: {
      replace(target) {
        redirects.push(target);
      }
    },
    atob(input) {
      return Buffer.from(input, 'base64').toString('binary');
    },
    JSON,
    String
  };
  context.window = context;
  vm.runInNewContext(getAiGuardScript(), context);
  return {
    storage: storage.dump(),
    redirects,
    authOk: context.window.__SUNLAND_AI_AUTH_OK__
  };
}

test('ai.html checks local login before loading app logic', () => {
  assert.ok(
    aiHtml.indexOf('function restoreUserFromToken') > -1,
    'ai.html should restore local user data from token before app.js runs'
  );
  assert.ok(
    aiHtml.indexOf('function restoreUserFromToken') < aiHtml.indexOf('appScript.src = "ai/app.js"'),
    'login guard must run before ai/app.js is loaded'
  );
  assert.match(aiHtml, /if \(window\.__SUNLAND_AI_AUTH_OK__\)/);
  assert.match(aiHtml, /location\.replace\("login\.html\?return=ai\.html"\)/);
});

test('ai.html guard restores user from token email before app startup', () => {
  const token = createJwt({ email: 'fox@example.com', exp: Math.floor(Date.now() / 1000) + 3600 });
  const result = runAiGuard({ token });

  assert.equal(result.authOk, true);
  assert.deepEqual(result.redirects, []);
  assert.equal(JSON.parse(result.storage.user).id, 'fox@example.com');
  assert.equal(JSON.parse(result.storage.user).email, 'fox@example.com');
});

test('ai.html guard normalizes stored user with email but no id', () => {
  const token = createJwt({ email: 'fox@example.com', exp: Math.floor(Date.now() / 1000) + 3600 });
  const result = runAiGuard({
    token,
    user: JSON.stringify({ email: 'fox@example.com' })
  });

  assert.equal(result.authOk, true);
  assert.deepEqual(result.redirects, []);
  assert.equal(JSON.parse(result.storage.user).id, 'fox@example.com');
});

test('ai.html guard redirects when token is missing or damaged', () => {
  assert.deepEqual(runAiGuard({}).redirects, ['login.html?return=ai.html']);

  const damaged = runAiGuard({ token: 'bad.jwt.token' });
  assert.deepEqual(damaged.redirects, ['login.html?return=ai.html']);
  assert.equal(damaged.storage.token, undefined);
  assert.equal(damaged.storage.user, undefined);
});

test('login.html stores a normalized user object after successful login', () => {
  assert.match(loginHtml, /function normalizeLoginUser\(/);
  assert.match(loginHtml, /const loginUser = normalizeLoginUser\(data, email\)/);
  assert.match(loginHtml, /data\?\.userId/);
  assert.match(loginHtml, /payload\?\.email/);
  assert.doesNotMatch(loginHtml, /localStorage\.setItem\("user",\s*JSON\.stringify\(data\.user\)\)/);
});

test('ai app accepts token identity fields used by settings page fallback', () => {
  assert.match(aiAppJs, /function getIdentityFromJwtPayload\(/);
  assert.match(aiAppJs, /payload\.userId/);
  assert.match(aiAppJs, /payload\.uid/);
  assert.match(aiAppJs, /payload\.email/);
  assert.match(aiAppJs, /normalizeStoredUser\(user, payload\)/);
});

test('ai app does not block local login rendering on Supabase CDN load failure', () => {
  assert.doesNotMatch(aiAppJs, /import\s+\{\s*supabase\s*\}\s+from\s+['"]\.\.\/p\/js\/supabaseClient\.js['"]/);
  assert.match(aiAppJs, /function createOfflineSupabaseClient\(/);
  assert.match(aiAppJs, /import\(['"]\.\.\/p\/js\/supabaseClient\.js['"]\)/);
  assert.match(aiAppJs, /Supabase 客户端加载失败，已启用本地离线模式/);
});
