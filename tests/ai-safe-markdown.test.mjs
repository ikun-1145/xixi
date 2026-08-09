import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const projectRequire = createRequire(new URL('../package.json', import.meta.url));
const { JSDOM } = projectRequire('jsdom');
const createDOMPurify = projectRequire('dompurify');
const markedEntry = projectRequire.resolve('marked');
const { marked } = await import(pathToFileURL(markedEntry).href);
const safeMarkdownSource = fs.readFileSync(new URL('../ai/safe-markdown.js', import.meta.url), 'utf8');
const safeMarkdownModuleUrl = `data:text/javascript;base64,${Buffer.from(safeMarkdownSource).toString('base64')}`;
const { renderSafeMarkdown } = await import(safeMarkdownModuleUrl);

const aiApp = fs.readFileSync(new URL('../ai/app.js', import.meta.url), 'utf8');

function createPage() {
  const dom = new JSDOM('<!doctype html><div id="target"></div>', {
    url: 'https://sunland.example/ai.html',
  });

  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.NodeFilter = dom.window.NodeFilter;
  dom.window.marked = marked;
  dom.window.DOMPurify = createDOMPurify(dom.window);

  return {
    dom,
    target: dom.window.document.getElementById('target'),
  };
}

test('removes img onerror payloads', () => {
  const { dom, target } = createPage();

  renderSafeMarkdown(target, '<img src=x onerror="window.__xss = true">');

  assert.equal(target.querySelector('img'), null);
  assert.doesNotMatch(target.innerHTML, /onerror/i);
  assert.equal(dom.window.__xss, undefined);
});

test('removes script tags and their executable surface', () => {
  const { dom, target } = createPage();

  renderSafeMarkdown(target, '<script>window.__xss = true</script>安全文本');

  assert.equal(target.querySelector('script'), null);
  assert.doesNotMatch(target.innerHTML, /<script/i);
  assert.equal(dom.window.__xss, undefined);
  assert.match(target.textContent, /安全文本/);
});

test('removes javascript URLs while retaining link text', () => {
  const { target } = createPage();

  renderSafeMarkdown(target, '[危险链接](javascript:alert(1))');

  const link = target.querySelector('a');
  assert.ok(link);
  assert.equal(link.textContent, '危险链接');
  assert.equal(link.hasAttribute('href'), false);
  assert.doesNotMatch(target.innerHTML, /javascript:/i);
});

test('removes SVG and MathML executable content', () => {
  const { dom, target } = createPage();

  renderSafeMarkdown(
    target,
    '<svg onload="window.__svgXss = true"><script>window.__svgXss = true</script></svg>' +
      '<math><mtext onclick="window.__mathXss = true">x</mtext></math>',
  );

  assert.equal(target.querySelector('svg'), null);
  assert.equal(target.querySelector('math'), null);
  assert.doesNotMatch(target.innerHTML, /onload|onclick/i);
  assert.equal(dom.window.__svgXss, undefined);
  assert.equal(dom.window.__mathXss, undefined);
});

test('removes embedded documents, plugins, and event handler attributes', () => {
  const { target } = createPage();

  renderSafeMarkdown(
    target,
    '<iframe src="https://example.org"></iframe>' +
      '<object data="https://example.org/payload"></object>' +
      '<embed src="https://example.org/payload">' +
      '<a href="https://example.org" onclick="alert(1)">安全链接</a>',
  );

  assert.equal(target.querySelector('iframe, object, embed'), null);
  assert.equal(target.querySelector('a')?.hasAttribute('onclick'), false);
});

test('sanitizes malicious assistant content again after history reload', () => {
  const firstPage = createPage();
  const storedConversation = JSON.stringify({
    id: 42,
    history: [
      { role: 'system', content: 'system' },
      {
        role: 'assistant',
        content: '<img src=x onerror="window.__historyXss = true"><svg onload="window.__historyXss = true"></svg>已恢复',
      },
    ],
  });
  firstPage.dom.window.localStorage.setItem('conversation', storedConversation);

  const restoredRaw = firstPage.dom.window.localStorage.getItem('conversation');
  const secondPage = createPage();
  secondPage.dom.window.localStorage.setItem('conversation', restoredRaw);
  const restored = JSON.parse(secondPage.dom.window.localStorage.getItem('conversation'));

  renderSafeMarkdown(secondPage.target, restored.history[1].content);

  assert.equal(secondPage.target.querySelector('img, svg'), null);
  assert.doesNotMatch(secondPage.target.innerHTML, /onerror|onload/i);
  assert.equal(secondPage.dom.window.__historyXss, undefined);
  assert.match(secondPage.target.textContent, /已恢复/);
});

test('preserves ordinary Markdown and hardens external links', () => {
  const { target } = createPage();

  renderSafeMarkdown(
    target,
    '**加粗** *斜体*\n\n- 第一项\n- 第二项\n\n```js\nconst answer = 42;\n```\n\n[安全链接](https://example.org/docs)',
  );

  assert.equal(target.querySelector('strong')?.textContent, '加粗');
  assert.equal(target.querySelector('em')?.textContent, '斜体');
  assert.equal(target.querySelectorAll('ul li').length, 2);
  assert.match(target.querySelector('pre code')?.textContent || '', /const answer = 42/);

  const link = target.querySelector('a');
  assert.equal(link?.getAttribute('href'), 'https://example.org/docs');
  assert.equal(link?.getAttribute('target'), '_blank');
  assert.equal(link?.getAttribute('rel'), 'noopener noreferrer');
});

test('fails closed to plain text if the sanitizer is unavailable', () => {
  const { dom, target } = createPage();
  delete dom.window.DOMPurify;

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    renderSafeMarkdown(target, '<img src=x onerror=alert(1)>**文本**');
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(target.children.length, 0);
  assert.equal(target.textContent, '<img src=x onerror=alert(1)>**文本**');
});

test('all dynamic AI and history Markdown paths use the shared renderer', () => {
  assert.doesNotMatch(aiApp, /marked\.parse/);
  assert.match(aiApp, /renderHistory\.slice\(1\)[\s\S]*?addMessage\(m\.content/);
  assert.match(aiApp, /renderRequestMarkdown\(requestContext, requestContext\.bubble, text/);
  assert.match(aiApp, /renderSafeMarkdown\(reasoningContent, reasoning\)/);
  assert.match(aiApp, /renderSafeMarkdown\(contentDiv, fullText\)/);
  assert.match(aiApp, /options\.thinking === true/);
  assert.doesNotMatch(aiApp, /title\.replace\([^\n]+<mark/);
  assert.doesNotMatch(aiApp, /wrapper\.innerHTML = text/);
});
