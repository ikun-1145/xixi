import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseRemaining, readUsage, USAGE_URL } from '../ai/usage.js';

test('usage accepts only authoritative bounded values and the expected account', async () => {
  for (const value of [null, '', '1x', '-2', '21', '1.5']) assert.equal(parseRemaining(value), null);
  for (const value of ['0', '13', '20', '-1']) assert.equal(parseRemaining(value), Number(value));
  const usage = { userId: 'a', remain: 13, isPro: false };
  assert.deepEqual(await readUsage(async (url, init) => {
    assert.equal(url, USAGE_URL);
    assert.equal(init.method, 'POST');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.body, '{}');
    return Response.json(usage);
  }, 'a'), usage);
  await assert.rejects(readUsage(async () => Response.json(usage), 'b'));
  await assert.rejects(readUsage(async () => new Response('', { status: 503 }), 'a'));
  await assert.rejects(readUsage(async () => Response.json({ ...usage, remain: null }), 'a'));
});

const app = readFileSync(new URL('../ai/app.js', import.meta.url), 'utf8');
function harness() {
  let userId = 'a';
  const pending = [];
  const hint = { innerText: '' };
  const context = vm.createContext({
    getCurrentUserId: () => userId,
    readUsage: () => new Promise(resolve => pending.push(resolve)),
    authenticatedFetch() {},
    isActivated: false,
    renderProUsageHint: () => { hint.innerText = 'Pro'; },
    document: { getElementById: () => hint },
    uiText: text => text,
  });
  vm.runInContext(app.slice(app.indexOf('let usageVersion = 0;'), app.indexOf('async function checkActivation()')), context);
  return { context, pending, hint, setUser: id => { userId = id; } };
}

test('late quota snapshots cannot overwrite a newer chat result or another account', async () => {
  const h = harness();
  const first = vm.runInContext('refreshChatUsage()', h.context);
  vm.runInContext('++usageVersion; renderRemaining(12)', h.context);
  h.pending.shift()({ remain: 13 });
  await first;
  assert.equal(h.hint.innerText, '今日剩余 12 次');
  const second = vm.runInContext('refreshChatUsage()', h.context);
  h.setUser('b');
  h.pending.shift()({ remain: 10 });
  await second;
  assert.equal(h.hint.innerText, '今日剩余 12 次');
});

test('chat quota updates are account scoped and both pages stop querying obsolete usage tables', () => {
  const flow = app.slice(app.indexOf('// Quota belongs'), app.indexOf('if (res.status === 429)', app.indexOf('// Quota belongs')));
  assert.match(flow, /getCurrentUserId\(\) === requestContext.userId/);
  assert.doesNotMatch(flow, /currentId === requestContext.conversationId/);
  assert.ok(flow.indexOf('renderRemaining(remain)') < flow.indexOf('abortMissingTarget'));
  const settings = readFileSync(new URL('../ai_settings.html', import.meta.url), 'utf8');
  assert.doesNotMatch(app + settings, /\.from\("(?:usage|request_logs)"\)/);
  assert.match(settings, /readUsage/);
  assert.match(settings, /addEventListener\("focus", refreshSettingsUsage\)/);
});
