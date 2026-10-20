import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const home = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
function fixture() {
  const dom = new JSDOM('<body class="ready"><button id="aiEntry"></button></body>', { url: 'https://fixture.invalid', runScripts: 'outside-only' });
  const scheduled = new Map();
  let id = 0;
  dom.window.setTimeout = (fn) => { scheduled.set(++id, fn); return id; };
  dom.window.clearTimeout = (key) => scheduled.delete(key);
  const script = [...home.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1]).find((text) => text.includes('AI入口过渡动画跳转'));
  assert.ok(script);
  dom.window.eval(script);
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  return { dom, scheduled, button: dom.window.document.getElementById('aiEntry') };
}

test('BFCache return restores homepage and cancels abandoned AI navigation', () => {
  const { dom, scheduled, button } = fixture();
  try {
    button.click();
    assert.equal(dom.window.document.body.classList.contains('ai-leaving'), true);
    assert.equal(scheduled.size, 1);
    dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow', { persisted: true }));
    assert.equal(dom.window.document.body.classList.contains('ai-leaving'), false);
    assert.equal(scheduled.size, 0);
    button.click();
    assert.equal(scheduled.size, 1, 'navigation can be used again after return');
  } finally { dom.window.close(); }
});

test('rapid AI entry clicks schedule one navigation', () => {
  const { dom, scheduled, button } = fixture();
  try {
    button.click(); button.click(); button.click();
    assert.equal(scheduled.size, 1);
  } finally { dom.window.close(); }
});

test('account settings icons all have an existing CSS mask', () => {
  const settings = readFileSync(new URL('../ai_settings.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../p/css/icons.css', import.meta.url), 'utf8');
  for (const icon of new Set(settings.match(/\bicon-[a-z][a-z-]+\b/g))) {
    assert.ok(css.includes(`.${icon}`), `${icon} is missing its CSS mapping`);
  }
});

test('initial pageshow does not cancel navigation clicked before slow resources finish', () => {
  const { dom, scheduled, button } = fixture();
  try {
    button.click();
    dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow', { persisted: false }));
    assert.equal(scheduled.size, 1);
    assert.equal(dom.window.document.body.classList.contains('ai-leaving'), true);
  } finally { dom.window.close(); }
});
