import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { JSDOM } from 'jsdom';

const copilotHtml = fs.readFileSync(new URL('../copilot.html', import.meta.url), 'utf8');
const copilotCss = fs.readFileSync(new URL('../p/css/copilot.css', import.meta.url), 'utf8');
const aiHtml = fs.readFileSync(new URL('../ai.html', import.meta.url), 'utf8');

function createDocument(html) {
  return new JSDOM(html, { url: 'https://sunland.dev/' }).window.document;
}

test('copilot loads the shared Sunland design system before its page styles', () => {
  const tokensPosition = copilotHtml.indexOf('href="p/css/tokens.css"');
  const basePosition = copilotHtml.indexOf('href="p/css/base.css"');
  const pagePosition = copilotHtml.indexOf('href="p/css/copilot.css');
  const bodyPosition = copilotHtml.indexOf('<body>');

  assert.ok(tokensPosition > -1);
  assert.ok(tokensPosition < basePosition);
  assert.ok(basePosition < pagePosition);
  assert.ok(pagePosition < bodyPosition);
  assert.doesNotMatch(copilotHtml, /<style[\s>]/u);
});

test('copilot keeps the behavior hooks and API contracts used by its existing script', () => {
  const document = createDocument(copilotHtml);
  const requiredIds = [
    'quotaChip',
    'clearCtxBtn',
    'ctxBar',
    'ctxText',
    'comment',
    'dropzone',
    'fileInput',
    'preview',
    'previewImg',
    'removeImg',
    'tonePanel',
    'toneEmoji',
    'toneName',
    'toneDesc',
    'toneModel',
    'ccSlider',
    'ccInner',
    'ccVeil',
    'ccTicks',
    'ccThumb',
    'ccLabels',
    'generateBtn',
    'genLabel',
    'results',
    'emptyHint',
    'loginModal',
    'confirmModal',
  ];

  for (const id of requiredIds) {
    assert.ok(document.getElementById(id), `copilot.html should retain #${id}`);
  }

  assert.match(copilotHtml, /functions\/v1\/comment-copilot/u);
  assert.match(copilotHtml, /https:\/\/api\.sunland\.dev\/refresh/u);
  assert.match(copilotHtml, /action:'generate'/u);
  assert.match(copilotHtml, /action:'clear'/u);
  assert.match(copilotHtml, /action:'status'/u);
});

test('copilot exposes semantic controls and accessible live regions', () => {
  const document = createDocument(copilotHtml);

  assert.equal(document.getElementById('dropzone').tagName, 'BUTTON');
  assert.equal(document.getElementById('dropzone').type, 'button');
  assert.equal(document.getElementById('generateBtn').type, 'button');
  assert.equal(document.getElementById('results').getAttribute('aria-live'), 'polite');
  assert.equal(document.getElementById('loginModal').getAttribute('aria-modal'), 'true');
  assert.equal(document.getElementById('confirmModal').getAttribute('aria-modal'), 'true');
  assert.match(copilotHtml, /classList\.toggle\('night'/u);
  assert.doesNotMatch(copilotHtml, /setAttribute\('data-theme'/u);
});

test('AI sidebar groups HuFuBao and information verification below the new-chat action', () => {
  const document = createDocument(aiHtml);
  const newChatButton = document.getElementById('newChatBtn');
  const featureLinks = document.querySelector('.sidebar-feature-links');
  const copilotEntry = document.getElementById('copilotEntry');
  const verifyEntry = document.getElementById('verifyEntry');

  assert.ok(featureLinks);
  assert.ok(copilotEntry);
  assert.ok(verifyEntry);
  assert.equal(copilotEntry.tagName, 'A');
  assert.equal(copilotEntry.getAttribute('href'), 'copilot.html');
  assert.equal(copilotEntry.textContent.trim(), '护福宝');
  assert.equal(verifyEntry.tagName, 'A');
  assert.equal(verifyEntry.getAttribute('href'), 'verify.html');
  assert.equal(verifyEntry.textContent.trim(), '信息鉴真');
  assert.equal(newChatButton.nextElementSibling, featureLinks);
  assert.deepEqual([...featureLinks.children], [copilotEntry, verifyEntry]);
});

test('copilot page styles keep the restrained v0 and CleanUI constraints', () => {
  assert.doesNotMatch(copilotCss, /font-weight:\s*(?:800|900)/u);
  assert.doesNotMatch(copilotCss, /gradient\(/u);
  assert.doesNotMatch(copilotCss, /(?:fullfire|tone-fx|ccShock|ccGlow|glass-shadow)/u);
  assert.match(copilotCss, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.match(copilotCss, /var\(--brand\)/u);
  assert.match(copilotCss, /var\(--surface\)/u);
  assert.match(copilotCss, /var\(--border\)/u);
});
