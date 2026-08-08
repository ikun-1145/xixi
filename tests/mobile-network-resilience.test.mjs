import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const symbolicRequire = createRequire(new URL('../symbolic-ai/package.json', import.meta.url));
const { JSDOM, VirtualConsole } = symbolicRequire('jsdom');

const readProjectFile = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('home page becomes visible when module and third-party resources are unavailable', async () => {
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(readProjectFile('index.html'), {
    pretendToBeVisual: true,
    runScripts: 'dangerously',
    url: 'https://sunland.example/',
    virtualConsole,
  });

  try {
    await new Promise(resolve => dom.window.setTimeout(resolve, 1500));

    assert.equal(dom.window.document.body.classList.contains('ready'), true);
    assert.equal(dom.window.document.getElementById('loading'), null);
  } finally {
    dom.window.close();
  }
});

test('critical browser dependencies are served from the site origin', () => {
  const pages = ['index.html', 'ai.html', 'donate.html', 'oauth-callback.html', 'ai_settings.html'];
  const clientSource = readProjectFile('p/js/supabaseClient.js');

  assert.doesNotMatch(clientSource, /cdn\.jsdelivr\.net|unpkg\.com/);
  for (const page of pages) {
    assert.match(
      readProjectFile(page),
      /(?:\/|p\/)vendor\/supabase-2\.110\.7\.js/,
      `${page} should load the same-origin Supabase runtime`,
    );
  }

  assert.match(readProjectFile('ai.html'), /p\/vendor\/marked-18\.0\.6\.umd\.js/);
  assert.match(readProjectFile('ai.html'), /p\/vendor\/dompurify-3\.4\.12\.min\.js/);
});

test('vendored browser runtimes expose the APIs used by production pages', () => {
  const dom = new JSDOM('<!doctype html><body></body>', {
    runScripts: 'outside-only',
    url: 'https://sunland.example/',
  });

  try {
    dom.window.eval(readProjectFile('p/vendor/supabase-2.110.7.js'));
    dom.window.eval(readProjectFile('p/vendor/marked-18.0.6.umd.js'));
    dom.window.eval(readProjectFile('p/vendor/dompurify-3.4.12.min.js'));

    assert.equal(typeof dom.window.supabase?.createClient, 'function');
    assert.equal(typeof dom.window.marked?.parse, 'function');
    assert.equal(typeof dom.window.DOMPurify?.sanitize, 'function');
  } finally {
    dom.window.close();
  }
});

test('optional third-party scripts cannot block AI page parsing', () => {
  const aiHtml = readProjectFile('ai.html');
  const loginHtml = readProjectFile('login.html');
  const downloadHtml = readProjectFile('download.html');
  const externalScripts = [...aiHtml.matchAll(/<script\b([^>]*\bsrc=["']https:\/\/[^>]+)>/gi)];

  assert.ok(externalScripts.length > 0);
  externalScripts.forEach(([, attributes]) => {
    assert.match(attributes, /\basync\b/i);
  });
  assert.doesNotMatch(aiHtml, /static\.geetest\.com/);
  assert.equal((loginHtml.match(/static\.geetest\.com\/v4\/gt4\.js/g) || []).length, 1);
  assert.match(downloadHtml, /<link\s+rel="preload"[^>]+fonts\.googleapis\.com[^>]+as="style"/);
  assert.doesNotMatch(downloadHtml, /<link\s+[^>]*href="https:\/\/fonts\.googleapis\.com[^>]*rel="stylesheet"/);
});
