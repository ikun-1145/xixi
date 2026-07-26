import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  RequestCoordinator,
  applyRequestTitle,
  isRequestVisibleForConversation,
} from '../ai/request-context.js';
import { IdentityAuthority } from '../ai/verified-identity.js';

const aiApp = fs.readFileSync(new URL('../ai/app.js', import.meta.url), 'utf8');
const system = { role: 'system', content: 'system' };

const encodeJwtPart = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const identityToken = `${encodeJwtPart({ alg: 'test' })}.${encodeJwtPart({ sub: 'user-a', exp: Math.floor(Date.now() / 1000) + 3600 })}.signature`;
const identityAuthority = new IdentityAuthority({
  fetchImpl: async () => ({
    ok: true,
    status: 200,
    json: async () => ({ token: identityToken, user: { id: 'user-a' } }),
  }),
});
const identityA = (await identityAuthority.resolve({ token: identityToken })).identity;

function conversation(id, provider = 'deepseek') {
  return {
    id,
    provider,
    model: provider === 'sunland' ? 'frost' : 'deepseek-v4-flash',
    userId: 'user-a',
    title: '新对话',
    history: [system],
    updatedAt: id,
  };
}

function createHarness(initial = [conversation(1), conversation(2)]) {
  let conversations = initial;
  let currentUserId = 'user-a';
  const persisted = [];
  const coordinator = new RequestCoordinator({
    getConversation: id => conversations.find(item => item.id === id),
    getCurrentUserId: () => currentUserId,
    onConversationChanged: () => {
      persisted.push(JSON.parse(JSON.stringify(conversations)));
    },
    now: () => 1234 + persisted.length,
  });

  return {
    coordinator,
    get conversations() { return conversations; },
    set conversations(value) { conversations = value; },
    setCurrentUserId(value) { currentUserId = value; },
    persisted,
    begin(id) {
      const target = conversations.find(item => item.id === id);
      return coordinator.begin({
        conversation: target,
        identity: identityA,
        userId: 'user-a',
        providerId: target.provider,
        model: target.model,
        deep: false,
        history: target.history,
      });
    },
  };
}

test('DeepSeek streaming completion remains bound after switching conversations', () => {
  const harness = createHarness();
  const request = harness.begin(1);
  harness.coordinator.appendMessage(request, { role: 'user', content: 'A question' });

  const viewedConversationId = 2;
  assert.equal(isRequestVisibleForConversation(request, viewedConversationId), false);
  harness.coordinator.appendMessage(request, { role: 'assistant', content: 'A answer' });

  assert.deepEqual(harness.conversations[0].history.map(item => item.content), ['system', 'A question', 'A answer']);
  assert.deepEqual(harness.conversations[1].history.map(item => item.content), ['system']);
});

test('request context captures immutable routing and model state at send start', () => {
  const harness = createHarness([conversation(5)]);
  const request = harness.begin(5);

  assert.equal(typeof request.requestId, 'string');
  assert.equal(request.conversationId, 5);
  assert.equal(request.providerId, 'deepseek');
  assert.equal(request.userId, 'user-a');
  assert.equal(request.identity, identityA);
  assert.equal(request.model, 'deepseek-v4-flash');
  assert.equal(request.deep, false);
  assert.equal(request.startedAt, 1234);
  assert.ok(request.controller instanceof AbortController);
  assert.notEqual(request.history, harness.conversations[0].history);
});

test('creating a new conversation cannot receive an older DeepSeek request result', () => {
  const harness = createHarness([conversation(1)]);
  const request = harness.begin(1);
  harness.coordinator.appendMessage(request, { role: 'user', content: 'old' });
  harness.conversations.unshift(conversation(3));

  harness.coordinator.appendMessage(request, { role: 'assistant', content: 'old result' });

  assert.deepEqual(harness.conversations.find(item => item.id === 3).history, [system]);
  assert.equal(harness.conversations.find(item => item.id === 1).history.at(-1).content, 'old result');
});

test('Sunland completion remains on its original conversation after a switch', () => {
  const harness = createHarness([conversation(10, 'sunland'), conversation(11)]);
  const request = harness.begin(10);
  harness.coordinator.appendMessage(request, { role: 'user', content: '记住我' });
  harness.coordinator.appendMessage(request, { role: 'assistant', content: '好呀' });

  assert.equal(harness.conversations.find(item => item.id === 10).history.at(-1).content, '好呀');
  assert.deepEqual(harness.conversations.find(item => item.id === 11).history, [system]);
});

test('a removed target is not recreated and all later writes are discarded', () => {
  const harness = createHarness([conversation(20), conversation(21)]);
  const request = harness.begin(20);
  harness.conversations = harness.conversations.filter(item => item.id !== 20);

  assert.equal(harness.coordinator.canWrite(request), false);
  assert.equal(harness.coordinator.appendMessage(request, { role: 'assistant', content: 'late' }), false);
  harness.coordinator.abort(request, 'target-deleted');
  assert.deepEqual(harness.conversations.map(item => item.id), [21]);
});

test('different conversations may finish in reverse order without overwriting each other', () => {
  const harness = createHarness([conversation(30), conversation(31)]);
  const first = harness.begin(30);
  const second = harness.begin(31);
  harness.coordinator.appendMessage(first, { role: 'user', content: 'first' });
  harness.coordinator.appendMessage(second, { role: 'user', content: 'second' });

  harness.coordinator.appendMessage(second, { role: 'assistant', content: 'second result' });
  harness.coordinator.finish(second);
  harness.coordinator.appendMessage(first, { role: 'assistant', content: 'first result' });

  assert.equal(harness.conversations.find(item => item.id === 30).history.at(-1).content, 'first result');
  assert.equal(harness.conversations.find(item => item.id === 31).history.at(-1).content, 'second result');
});

test('aborting one request does not affect another request controller', () => {
  const harness = createHarness([conversation(40), conversation(41)]);
  const first = harness.begin(40);
  const second = harness.begin(41);

  harness.coordinator.abort(first, 'user');

  assert.equal(first.controller.signal.aborted, true);
  assert.equal(second.controller.signal.aborted, false);
  assert.equal(harness.coordinator.canWrite(second), true);
});

test('late chunks and callbacks are ignored after abort', () => {
  const harness = createHarness([conversation(50)]);
  const request = harness.begin(50);
  harness.coordinator.appendMessage(request, { role: 'user', content: 'before abort' });
  harness.coordinator.abort(request, 'user');

  assert.equal(harness.coordinator.appendMessage(request, { role: 'assistant', content: 'late chunk' }), false);
  assert.equal(harness.conversations[0].history.some(item => item.content === 'late chunk'), false);
});

test('titles apply only to the captured conversation and request token', () => {
  const first = conversation(60);
  const second = conversation(61);
  first._autoTitle = true;
  first._autoTitleRequestId = 'request-60';
  const conversations = [first, second];

  assert.equal(applyRequestTitle({
    conversations,
    conversationId: 60,
    userId: 'user-a',
    requestId: 'wrong-token',
    title: 'wrong',
  }), false);
  assert.equal(applyRequestTitle({
    conversations,
    conversationId: 60,
    userId: 'user-a',
    requestId: 'request-60',
    title: 'right',
  }), true);

  assert.equal(first.title, 'right');
  assert.equal(second.title, '新对话');
});

test('error messages persist only in the request target', () => {
  const harness = createHarness([conversation(70), conversation(71)]);
  const request = harness.begin(70);
  harness.coordinator.appendMessage(request, { role: 'assistant', content: '请求异常，请稍后重试' });

  assert.equal(harness.conversations.find(item => item.id === 70).history.at(-1).role, 'assistant');
  assert.deepEqual(harness.conversations.find(item => item.id === 71).history, [system]);
});

test('persisted histories remain isolated after a simulated refresh', () => {
  const harness = createHarness([conversation(80), conversation(81, 'sunland')]);
  const deep = harness.begin(80);
  const sunland = harness.begin(81);
  harness.coordinator.appendMessage(deep, { role: 'assistant', content: 'deep result' });
  harness.coordinator.appendMessage(sunland, { role: 'assistant', content: 'sunland result' });

  const restored = JSON.parse(JSON.stringify(harness.persisted.at(-1)));
  assert.equal(restored.find(item => item.id === 80).history.at(-1).content, 'deep result');
  assert.equal(restored.find(item => item.id === 81).history.at(-1).content, 'sunland result');
  assert.equal(restored.find(item => item.id === 80).provider, 'deepseek');
  assert.equal(restored.find(item => item.id === 81).provider, 'sunland');
});

test('provider changes, user changes, and duplicate sends fail closed', () => {
  const harness = createHarness([conversation(90), conversation(91, 'sunland')]);
  const deep = harness.begin(90);
  assert.equal(harness.begin(90), null, 'same-conversation duplicate must be rejected');

  harness.conversations.find(item => item.id === 90).provider = 'sunland';
  assert.equal(harness.coordinator.canWrite(deep), false);

  const sunland = harness.begin(91);
  harness.setCurrentUserId('user-b');
  assert.equal(harness.coordinator.canWrite(sunland), false);
});

test('current UI visibility is conversation-scoped', () => {
  const harness = createHarness([conversation(100), conversation(101)]);
  const request = harness.begin(100);

  assert.equal(isRequestVisibleForConversation(request, 100, true), true);
  assert.equal(isRequestVisibleForConversation(request, 101, true), false);
  assert.equal(isRequestVisibleForConversation(request, 100, false), false);
});

test('live app binds async writes, title generation, abort, and delayed rendering to fixed ids', () => {
  const sendStart = aiApp.indexOf('function isRequestVisible(requestContext)');
  const sendEnd = aiApp.indexOf('input.addEventListener("keydown"', sendStart);
  const requestBlock = aiApp.slice(sendStart, sendEnd);
  const titleStart = aiApp.indexOf('function scheduleRequestTitle');
  const titleEnd = aiApp.indexOf('function addRegenerateButton', titleStart);
  const titleBlock = aiApp.slice(titleStart, titleEnd);
  const deepStart = aiApp.indexOf('async function runDeepSeekRequest');
  const deepEnd = aiApp.indexOf('const lastRealSendByConversation', deepStart);
  const deepBlock = aiApp.slice(deepStart, deepEnd);
  const sunlandStart = aiApp.indexOf('async function sendSunlandMessage');
  const sunlandEnd = aiApp.indexOf('function decorateVisibleCodeBlocks', sunlandStart);
  const sunlandBlock = aiApp.slice(sunlandStart, sunlandEnd);
  const loadStart = aiApp.indexOf('function loadChat');
  const loadEnd = aiApp.indexOf('input.addEventListener("input"', loadStart);
  const loadBlock = aiApp.slice(loadStart, loadEnd);

  assert.match(requestBlock, /requestCoordinator\.begin\(\{/);
  assert.match(requestBlock, /const conversationId = requestContext\.conversationId/);
  assert.match(requestBlock, /requestContext\.controller\.signal/);
  assert.match(requestBlock, /requestCoordinator\.appendMessage\(requestContext/);
  assert.doesNotMatch(deepBlock, /conversations\.find\([^\n]*id === currentId\)/);
  assert.doesNotMatch(sunlandBlock, /conversations\.find\([^\n]*id === currentId\)/);
  assert.doesNotMatch(titleBlock, /id === currentId/);
  assert.match(titleBlock, /_autoTitleRequestId = titleRequestId/);
  assert.match(loadBlock, /renderVersion !== chatRenderVersion \|\| currentId !== id/);
  assert.match(loadBlock, /conversations\.find\(item => item\.id === id\)/);
  assert.match(aiApp, /apiFetch\(body, true, signal\)/);
});
