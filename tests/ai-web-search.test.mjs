import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const app = read('../ai/app.js');
const html = read('../ai.html');
const section = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
const statusSource = section('function updateWebSearchStatus(', 'async function runDeepSeekRequest(');
const runSource = section('async function runDeepSeekRequest(', 'const lastRealSendByConversation');
const buttonSource = section('function updateWebSearchButton()', 'function updateDeepButton()');

function buttonHarness() {
  const dom = new JSDOM('<button id="webSearchBtn"></button><div id="uploadPreview"></div>');
  const capability = { fileUpload: true };
  const init = section('const webSearchBtn =', 'let providerCapabilityState =');
  const create = new Function('document', 'window', 'uiText', 'providerCapabilityState',
    `${init}\n${buttonSource}\nupdateWebSearchButton(); return {
      button: webSearchBtn, enabled: () => webSearchEnabled,
      update: updateWebSearchButton, files: pendingFiles
    };`);
  return { ...create(dom.window.document, dom.window, x => x, capability), capability, dom };
}

function requestHarness({ enabled = true, response, visible = true, cancel = false, deep = false } = {}) {
  const dom = new JSDOM('<div id="bubble"></div>');
  const requests = [], messages = [], statuses = [], notices = [], errors = [], usage = [], labels = [], timers = [];
  const context = {
    webSearch: enabled, model: 'deepseek-v4-flash', deep,
    sessionGeneration: 0, userId: 'user-a', conversationId: 7, history: [{ role: 'user', content: '原始问题' }],
    controller: new AbortController(), bubble: dom.window.document.querySelector('#bubble'),
  };
  const noop = () => {};
  const deps = {
    sessionGeneration: 0, window: { _isMobile: false }, document: dom.window.document,
    uiText: x => x, isRequestVisible: () => visible, showToast: x => notices.push(x),
    newHistoryOperationId: () => 'request-7', setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; }, clearTimeout: noop,
    stopRequest: noop, localStorage: { getItem: () => 'mock-token' },
    renderRequestError: (_, text) => errors.push(text), goToLogin: noop,
    buildFurryEventModelHistory: x => x, buildVisionMessages: x => x,
    DEEPSEEK_VISION_MODEL: 'vision',
    apiFetch: async (...args) => { requests.push(args); return response; },
    observeTraceResponse: () => 'trace', getCurrentUserId: () => 'user-a',
    parseRemaining: x => x === null ? null : Number(x), usageDate: () => '2026-10-19',
    renderRemaining: x => usage.push(x), refreshChatUsage: noop,
    abortMissingTarget: () => context.controller.signal.aborted,
    currentId: 7, showLimitModal: noop,
    requestCoordinator: { canWrite: () => !context.controller.signal.aborted },
    ensureReasoningDisclosure: noop, ensureAssistantContent: x => x,
    renderSafeMarkdown: (target, text) => { target.textContent = text; },
    isNearBottom: () => false, chat: {}, getHistorySync: noop,
    createAssistantHistoryMessage: (content, reasoning) => ({ role: 'assistant', content, reasoning }),
    appendRequestMessage: (_, message) => { messages.push(message); return true; },
    renderCompletedDeepSeekResponse: noop, scheduleRequestTitle: noop,
    addRegenerateButton: noop, decorateVisibleCodeBlocks: noop, saveConversations: noop,
    console: { error: (...args) => errors.push(args), warn: noop }, TextDecoder, Response,
  };
  const run = new Function(...Object.keys(deps), 'statuses', 'labels', `${statusSource}
    const originalStatus = updateWebSearchStatus;
    updateWebSearchStatus = (context, status) => {
      statuses.push(status); originalStatus(context, status);
      labels.push(context.bubble.querySelector('.web-search-status')?.textContent ?? null);
    };
    let usageVersion = 0, lastUsageDate;
    ${runSource}
    return runDeepSeekRequest;`)(...Object.values(deps), statuses, labels);
  if (cancel) context.controller.abort();
  return {
    run: () => run(context), setVisible: value => { visible = value; },
    context, requests, messages, statuses, notices, errors, usage, labels, timers, dom,
  };
}

function streamResponse(events, split = false) {
  const text = events.map(value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`).join('');
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    if (split) {
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
    } else controller.enqueue(bytes);
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream', 'x-remain': '11', 'x-usage-date': '2026-10-19' } });
}
const answer = { choices: [{ delta: { content: '正常回复' } }] };
const searchStatus = status => ({ type: 'web_search_status', status });

test('search toggle starts off, toggles via native button, survives conversation changes and resets on fresh initialization', () => {
  const first = buttonHarness();
  assert.equal(first.enabled(), false);
  assert.equal(first.button.getAttribute('aria-pressed'), 'false');
  first.button.click();
  assert.equal(first.enabled(), true);
  assert.equal(first.button.getAttribute('aria-pressed'), 'true');
  first.dom.window.dispatchEvent(new first.dom.window.Event('site-language-change'));
  assert.equal(first.enabled(), true);
  assert.doesNotMatch(section('function loadChat(', 'input.addEventListener("input"'), /webSearchEnabled\s*=/);
  assert.equal(buttonHarness().enabled(), false);
  first.button.click();
  assert.equal(first.enabled(), false);
});

test('unsupported provider and attached images disable search and restore the in-memory preference', () => {
  const ui = buttonHarness();
  ui.button.click();
  ui.capability.fileUpload = false;
  ui.update();
  assert.equal(ui.button.disabled, true);
  assert.equal(ui.button.getAttribute('aria-pressed'), 'false');
  ui.button.click();
  assert.equal(ui.enabled(), true);
  ui.capability.fileUpload = true;
  ui.files.push({});
  ui.update();
  assert.equal(ui.button.disabled, true);
  ui.files.pop();
  ui.update();
  assert.equal(ui.button.disabled, false);
  assert.equal(ui.button.getAttribute('aria-pressed'), 'true');
});

test('disabled search sends explicit false and preserves messages, model, quota and stream output', async () => {
  const h = requestHarness({ enabled: false, response: streamResponse([answer, '[DONE]'], true) });
  await h.run();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0][0].web_search, false);
  assert.equal(h.requests[0][0].model, 'deepseek-v4-flash');
  assert.deepEqual(h.requests[0][0].messages, h.context.history);
  assert.equal(h.requests[0][2], h.context.controller.signal);
  assert.equal(h.messages[0].content, '正常回复');
  assert.deepEqual(h.usage, [11]);
  assert.equal(h.context.webSearchConfirmed, undefined);
  assert.deepEqual(h.notices, []);
  assert.equal(h.context.bubble.querySelector('.web-search-status'), null);
});

test('search completion event drives processing before normal SSE output, without extra history messages', async () => {
  const h = requestHarness({ response: streamResponse([searchStatus('search_complete'), answer, '[DONE]'], true) });
  await h.run();
  assert.equal(h.requests[0][0].web_search, true);
  assert.equal(h.context.webSearchConfirmed, true);
  assert.ok(h.statuses.indexOf('search_complete') < h.statuses.indexOf('answering'));
  assert.ok(h.labels.includes('正在搜索网络…'));
  assert.ok(h.labels.includes('正在整理搜索结果…'));
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].content, '正常回复');
  assert.deepEqual(h.notices, []);
  assert.equal(h.context.bubble.querySelector('.web-search-status'), null);
});

test('search failure warns once and continues the normal answer', async () => {
  const h = requestHarness({ response: streamResponse([searchStatus('search_failed'), answer, '[DONE]']) });
  await h.run();
  assert.deepEqual(h.notices, ['联网搜索失败，已使用普通模式回答']);
  assert.equal(h.messages[0].content, '正常回复');
  assert.deepEqual(h.errors, []);
});

test('HTTP 200 legacy stream without search confirmation warns without replay or fabricated success', async () => {
  const h = requestHarness({ response: streamResponse([answer, answer, '[DONE]']) });
  await h.run();
  assert.equal(h.context.webSearchConfirmed, undefined);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.notices, ['未确认联网搜索，当前回答可能未使用网络资料']);
  assert.equal(h.messages[0].content, '正常回复正常回复');
  assert.ok(!h.statuses.includes('search_complete'));
});

test('reasoning fragments preserve DeepSeek thinking and answer after search completes', async () => {
  const h = requestHarness({ deep: true, response: streamResponse([
    searchStatus('search_complete'),
    { choices: [{ delta: { reasoning_content: '先查询' } }] },
    { choices: [{ delta: { reasoning_content: '再整理' } }] },
    answer, '[DONE]',
  ], true) });
  await h.run();
  assert.equal(h.context.reasoningContent, '先查询再整理');
  assert.deepEqual(h.messages, [{ role: 'assistant', content: '正常回复', reasoning: '先查询再整理' }]);
  assert.deepEqual(h.notices, []);
  assert.equal(h.context.bubble.querySelector('.web-search-status'), null);
});

test('403 and 429 fail without retrying, persisting empty answers, or leaving search status', async () => {
  for (const status of [403, 429]) {
    const h = requestHarness({ response: new Response('{}', { status }) });
    await h.run();
    assert.equal(h.requests.length, 1, String(status));
    assert.equal(h.messages.length, 0, String(status));
    assert.ok(h.errors.length > 0, String(status));
    assert.equal(h.context.bubble.querySelector('.web-search-status'), null, String(status));
    assert.equal(h.context.webSearchConfirmed, undefined, String(status));
  }
});

test('switching conversation while the real request awaits response isolates all later status and output', async () => {
  let resolveResponse;
  const response = new Promise(resolve => { resolveResponse = resolve; });
  const h = requestHarness({ response });
  const pending = h.run();
  assert.equal(h.requests.length, 1);
  assert.equal(h.context.bubble.querySelector('.web-search-status').textContent, '正在搜索网络…');
  h.setVisible(false);
  // Loading another conversation replaces the visible chat DOM while this request remains pending.
  h.context.bubble.replaceChildren();
  resolveResponse(streamResponse([searchStatus('search_failed'), answer, '[DONE]'], true));
  await pending;
  assert.equal(h.context.bubble.textContent, '');
  assert.deepEqual(h.notices, []);
  assert.deepEqual(h.messages, [{ role: 'assistant', content: '正常回复', reasoning: '' }]);
  assert.equal(h.requests.length, 1);
});

test('legacy JSON completion keeps the answer with an unconfirmed search notice and no replay', async () => {
  const h = requestHarness({ response: new Response(JSON.stringify({
    choices: [{ message: { content: '旧网关回复' } }],
  }), { headers: { 'content-type': 'application/json; charset=utf-8' } }) });
  await h.run();
  assert.deepEqual(h.messages, [{ role: 'assistant', content: '旧网关回复', reasoning: '' }]);
  assert.deepEqual(h.notices, ['未确认联网搜索，当前回答可能未使用网络资料']);
  assert.equal(h.requests.length, 1);
  assert.equal(h.context.webSearchConfirmed, undefined);
  assert.equal(h.context.bubble.querySelector('.web-search-status'), null);
});

test('invalid or empty JSON completions never persist empty chat history or report search success', async () => {
  for (const payload of ['{invalid', '{}', '{"choices":[{"message":{"content":" "}}]}']) {
    const h = requestHarness({ response: new Response(payload, {
      headers: { 'content-type': 'application/json' },
    }) });
    await h.run();
    assert.equal(h.messages.length, 0, payload);
    assert.equal(h.requests.length, 1, payload);
    assert.ok(h.errors.length > 0, payload);
    assert.equal(h.context.webSearchConfirmed, undefined, payload);
    assert.equal(h.context.bubble.querySelector('.web-search-status'), null, payload);
  }
});

test('cancelled and hidden conversations never leak search status or answer into visible conversation', async () => {
  const cancelled = requestHarness({ cancel: true, response: streamResponse([answer]) });
  await cancelled.run();
  assert.equal(cancelled.messages.length, 0);
  assert.equal(cancelled.context.bubble.querySelector('.web-search-status'), null);
  const hidden = requestHarness({ visible: false, response: streamResponse([searchStatus('search_failed'), answer, '[DONE]']) });
  await hidden.run();
  assert.deepEqual(hidden.notices, []);
  assert.equal(hidden.context.bubble.textContent, '');
  assert.equal(hidden.messages[0].content, '正常回复');
});

test('six-language catalog translates all search UI labels and cache version is updated', () => {
  const dom = new JSDOM('<html></html>', { runScripts: 'outside-only', url: 'https://sunland.dev' });
  dom.window.eval(read('../p/js/site-i18n-extra.js'));
  dom.window.eval(read('../p/js/site-i18n.js'));
  const labels = ['联网搜索', '正在搜索网络…', '正在整理搜索结果…', '联网搜索失败，已使用普通模式回答', '未确认联网搜索，当前回答可能未使用网络资料', '当前模式暂不支持联网搜索'];
  for (const language of ['en', 'ja', 'zh-Hant', 'ko', 'es']) {
    dom.window.SiteI18n.setLanguage(language, { persist: false });
    for (const label of labels) assert.notEqual(dom.window.SiteI18n.translate(label), label, `${language}: ${label}`);
  }
  dom.window.SiteI18n.setLanguage('zh', { persist: false });
  for (const label of labels) assert.equal(dom.window.SiteI18n.translate(label), label);
  assert.match(html, /site-i18n\.js\?v=20261019-web-search/);
  assert.match(html, /id="webSearchBtn"[^>]*aria-pressed="false"/);
  dom.window.close();
});


test('slow requests clear search progress in both normal and deep thinking modes', async () => {
  for (const deep of [false, true]) {
    let resolveResponse;
    const response = new Promise(resolve => { resolveResponse = resolve; });
    const h = requestHarness({ deep, response });
    const pending = h.run();
    assert.ok(h.context.bubble.querySelector('.web-search-status'));
    h.timers.find(timer => timer.delay === 15000).callback();
    assert.equal(h.context.bubble.querySelector('.web-search-status'), null);
    assert.equal(h.context.webSearchStatus, 'answering');
    resolveResponse(streamResponse([answer, '[DONE]']));
    await pending;
    assert.equal(h.messages[0].content, '正常回复');
  }
});
