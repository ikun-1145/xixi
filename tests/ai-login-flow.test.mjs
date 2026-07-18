import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const aiHtml = fs.readFileSync(new URL('../ai.html', import.meta.url), 'utf8');
const loginHtml = fs.readFileSync(new URL('../login.html', import.meta.url), 'utf8');

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

test('login.html stores a normalized user object after successful login', () => {
  assert.match(loginHtml, /function normalizeLoginUser\(/);
  assert.match(loginHtml, /const loginUser = normalizeLoginUser\(data, email\)/);
  assert.doesNotMatch(loginHtml, /localStorage\.setItem\("user",\s*JSON\.stringify\(data\.user\)\)/);
});
