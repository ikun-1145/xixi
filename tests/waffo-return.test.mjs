import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const code = readFileSync(new URL('../ai/waffo-return.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../waffo-return.html', import.meta.url), 'utf8');
const context = '11111111-1111-4111-8111-111111111111';
async function run({ hash = '#checkout=' + context, token = 'synthetic-token', result, status = 200, language = 'zh', throws = false, pending = false } = {}) {
  const nodes = { 'return-link': {}, 'return-status': { hidden: true } };
  const timers = new Map(); const navigations = []; const calls = []; let replaced;
  const window = {
    location: { hash, pathname: '/waffo-return.html', replace: url => navigations.push(url) },
    history: { replaceState: (...args) => { replaced = args[2]; } },
    localStorage: { getItem: key => key === 'token' ? token : language, setItem() { throw Error('must not persist'); } },
    setTimeout(fn, ms) { const id = timers.size + 1; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch(url, init) {
      calls.push({ url, init });
      if (throws) return Promise.reject(Error('synthetic failure'));
      if (pending) return new Promise(() => {});
      return Promise.resolve(Response.json(result ?? { paymentConfirmed: false, entitlementEnabled: false }, { status }));
    }
  };
  const document = { documentElement: {}, body: { classList: { toggle() {} } }, getElementById: id => nodes[id] };
  vm.runInNewContext(code, { window, document, Date, URLSearchParams, AbortController });
  await new Promise(resolve => setImmediate(resolve));
  return { window, nodes, timers, navigations, calls, replaced, document };
}
for (const hash of ['', '#status=success', '#checkout=ORD_sensitive&status=success', '#checkout=invalid']) {
  test('untrusted or missing parameters return silently: ' + hash, async () => {
    const r = await run({ hash });
    assert.deepEqual(r.navigations, ['/ai.html']); assert.equal(r.calls.length, 0);
    assert.equal(r.nodes['return-status'].hidden, true); assert.equal(r.replaced, '/waffo-return.html');
  });
}
for (const options of [
  { token: null }, { result: { paymentConfirmed: false, entitlementEnabled: false } },
  { result: { paymentConfirmed: 'true', entitlementEnabled: false } },
  { result: { paymentConfirmed: true, entitlementEnabled: true } }, { status: 401 }, { throws: true }
]) test('unknown/failure state never shows success or changes storage', async () => {
  const r = await run(options);
  assert.deepEqual(r.navigations, ['/ai.html']); assert.equal(r.nodes['return-status'].hidden, true);
});
test('server confirmation shows truthful pending message, then returns after 1.8s; no IDs rendered', async () => {
  const r = await run({ result: { paymentConfirmed: true, entitlementEnabled: false, entitlementState: 'pending' } });
  assert.equal(r.nodes['return-status'].hidden, false);
  assert.equal(r.nodes['return-status'].textContent, '付款成功，Pro 权益待开通');
  assert.equal(r.navigations.length, 0);
  assert.equal(r.calls[0].url, 'https://waffopay.sunland.dev/checkout/waffo/production/status');
  assert.deepEqual(JSON.parse(r.calls[0].init.body), { checkout: context });
  assert.equal(r.calls[0].init.headers.Authorization, 'Bearer synthetic-token');
  assert.equal(r.calls[0].init.redirect, 'error');
  const timer = [...r.timers.values()][0]; assert.equal(timer.ms, 1800); timer.fn();
  assert.deepEqual(r.navigations, ['/ai.html']);
});
test('unresponsive status request aborts and returns silently within four seconds', async () => {
  const r = await run({ pending: true });
  const timer = [...r.timers.values()][0]; assert.equal(timer.ms, 4000); timer.fn();
  assert.equal(r.calls[0].init.signal.aborted, true);
  assert.deepEqual(r.navigations, ['/ai.html']); assert.equal(r.nodes['return-status'].hidden, true);
});
for (const language of ['zh', 'zh-Hant', 'en', 'ja', 'ko', 'es']) test('localized return UI: ' + language, async () => {
  const r = await run({ language, result: { paymentConfirmed: true, entitlementEnabled: false, entitlementState: 'pending' } });
  assert.ok(r.nodes['return-link'].textContent); assert.ok(r.nodes['return-status'].textContent);
});
test('page includes fixed accessible immediate return and no-JavaScript fallback, shared site styling', () => {
  assert.match(html, /href="\/ai.html"/); assert.match(html, /content="0;url=\/ai.html"/);
  assert.match(html, /name="referrer" content="no-referrer"/);
  assert.match(html, /tokens.css/); assert.match(html, /base.css/); assert.match(html, /aria-live="polite"/);
  assert.doesNotMatch(code, /localStorage\.setItem|innerHTML|console\./);
});

for (const state of ['pending', 'failed', 'granted']) test('server proof with production enabled: ' + state, async () => {
  const r = await run({ result: { paymentConfirmed: true, entitlementEnabled: true, entitlementState: state } });
  assert.equal(r.nodes['return-status'].hidden, false);
  assert.equal(r.nodes['return-status'].textContent.includes('已激活'), state === 'granted');
});
test('observation alone is not payment proof', async () => {
  const r = await run({ result: { observation: 'valid', entitlementEnabled: true, entitlementState: 'granted' } });
  assert.deepEqual(r.navigations, ['/ai.html']);
});
