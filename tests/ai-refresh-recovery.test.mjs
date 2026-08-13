import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  hasConversationStarted,
} from '../ai/providers/conversation.js';
import {
  getCurrentConversationStorageKey,
  persistCurrentConversationId,
  restoreLocalConversationState,
} from '../ai/conversation-recovery.js';

const aiApp = fs.readFileSync(new URL('../ai/app.js', import.meta.url), 'utf8');
const systemMessage = { role: 'system', content: 'system' };

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    dump() {
      return Object.fromEntries(values.entries());
    },
  };
}

function conversation(overrides = {}) {
  return {
    id: 100,
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    userId: 'user-1',
    title: '测试会话',
    history: [systemMessage, { role: 'user', content: '你好' }],
    ...overrides,
  };
}

function restore(storage, fallback = {}) {
  return restoreLocalConversationState({
    storage,
    userId: 'user-1',
    fallbackConversations: fallback.conversations || [],
    fallbackCurrentId: fallback.currentId ?? null,
  });
}

test('refresh with no conversation history returns an empty recoverable state', () => {
  const storage = createStorage();
  const result = restore(storage);

  assert.deepEqual(result.conversations, []);
  assert.equal(result.currentId, null);
  assert.equal(result.selectedConversation, null);
  assert.equal(result.status, 'missing');
  assert.deepEqual(storage.dump(), {});
});

test('refresh restores the selected DeepSeek conversation, model, and history', () => {
  const deepseek = conversation({
    id: 101,
    model: 'deepseek-v4-pro',
    history: [systemMessage, { role: 'user', content: '问题' }, { role: 'assistant', content: '回答' }],
  });
  const storage = createStorage({
    'conversations_user-1': JSON.stringify([deepseek]),
    [getCurrentConversationStorageKey('user-1')]: JSON.stringify(101),
  });

  const result = restore(storage);

  assert.equal(result.currentId, 101);
  assert.equal(result.selectedConversation.provider, 'deepseek');
  assert.equal(result.selectedConversation.model, 'deepseek-v4-pro');
  assert.deepEqual(result.selectedConversation.history, deepseek.history);
});

test('refresh restores the selected Sunland conversation and history', () => {
  const sunland = conversation({
    id: 202,
    provider: 'sunland',
    model: 'frost',
    history: [systemMessage, { role: 'user', content: '记得我吗' }, { role: 'assistant', content: '记得呀' }],
  });
  const storage = createStorage({
    'conversations_user-1': JSON.stringify([sunland]),
    [getCurrentConversationStorageKey('user-1')]: JSON.stringify(202),
  });

  const result = restore(storage);

  assert.equal(result.currentId, 202);
  assert.equal(result.selectedConversation.provider, 'sunland');
  assert.equal(result.selectedConversation.model, 'frost');
  assert.deepEqual(result.selectedConversation.history, sunland.history);
});

test('Sunland provider lock UI is restored from the selected conversation', () => {
  const start = aiApp.indexOf('function updateModelUI()');
  const end = aiApp.indexOf('// 初始化', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  const modelElement = {
    innerHTML: '',
    innerText: '',
    title: '',
    attributes: new Map(),
    classes: new Set(),
    setAttribute(name, value) {
      modelElement.attributes.set(name, String(value));
    },
    classList: {
      add(name) { modelElement.classes.add(name); },
      remove(name) { modelElement.classes.delete(name); },
      toggle(name, force) {
        if (force === true) modelElement.classes.add(name);
        else if (force === false) modelElement.classes.delete(name);
        else if (modelElement.classes.has(name)) modelElement.classes.delete(name);
        else modelElement.classes.add(name);
      },
    },
  };
  const document = {
    getElementById(id) {
      return id === 'modelSelector' ? modelElement : null;
    },
  };
  let capabilityUpdates = 0;
  const update = new Function(
    'document',
    'conversations',
    'currentId',
    'currentModel',
    'updateProviderCapabilityUI',
    'hasConversationStarted',
    `${aiApp.slice(start, end)}; updateModelUI();`,
  );

  update(
    document,
    [conversation({ id: 202, provider: 'sunland', model: 'frost' })],
    202,
    'deepseek-v4-flash',
    () => { capabilityUpdates += 1; },
    hasConversationStarted,
  );

  assert.equal(capabilityUpdates, 1);
  assert.equal(modelElement.classes.has('locked'), true);
  assert.match(modelElement.innerHTML, /Sunland/);
});

test('legacy conversations without provider migrate safely to DeepSeek', () => {
  const legacy = conversation({ id: 303 });
  delete legacy.provider;
  delete legacy.model;
  const storage = createStorage({
    'conversations_user-1': JSON.stringify([legacy]),
  });

  const result = restore(storage);

  assert.equal(result.currentId, 303);
  assert.equal(result.selectedConversation.provider, 'deepseek');
  assert.equal(result.selectedConversation.model, 'deepseek-v4-flash');
});

test('a missing currentId falls back without clearing valid conversations', () => {
  const first = conversation({ id: 401, title: '有效一' });
  const second = conversation({ id: 402, title: '有效二' });
  const storage = createStorage({
    'conversations_user-1': JSON.stringify([first, second]),
    [getCurrentConversationStorageKey('user-1')]: JSON.stringify(999),
  });

  const result = restore(storage);

  assert.equal(result.currentId, 401);
  assert.deepEqual(result.conversations.map(item => item.id), [401, 402]);
});

test('empty and damaged conversation storage never crashes or discards valid fallback memory', () => {
  const empty = restore(createStorage({ 'conversations_user-1': '[]' }));
  assert.deepEqual(empty.conversations, []);
  assert.equal(empty.currentId, null);

  const fallbackConversation = conversation({ id: 501 });
  const damaged = restore(
    createStorage({ 'conversations_user-1': '{broken-json' }),
    { conversations: [fallbackConversation], currentId: 501 },
  );
  assert.equal(damaged.status, 'damaged');
  assert.equal(damaged.currentId, 501);
  assert.deepEqual(damaged.conversations.map(item => item.id), [501]);

  const nonArray = restore(
    createStorage({ 'conversations_user-1': JSON.stringify({ unexpected: true }) }),
    { conversations: [fallbackConversation], currentId: 501 },
  );
  assert.equal(nonArray.status, 'invalid');
  assert.equal(nonArray.currentId, 501);

  const mixed = restore(createStorage({
    'conversations_user-1': JSON.stringify([
      null,
      { id: 502, provider: 'sunland', model: 'frost' },
      fallbackConversation,
    ]),
  }));
  assert.deepEqual(mixed.conversations.map(item => item.id), [501]);
});

test('current conversation selection is persisted without modifying conversation data', () => {
  const original = JSON.stringify([conversation({ id: 601 })]);
  const storage = createStorage({ 'conversations_user-1': original });

  assert.equal(persistCurrentConversationId(storage, 'user-1', 601), true);
  assert.equal(storage.dump()['conversations_user-1'], original);
  assert.equal(storage.dump()[getCurrentConversationStorageKey('user-1')], '601');
});

test('bootstrap initializes every recovery state before checkLogin can call loadChat', () => {
  const bootstrap = aiApp.indexOf('// 所有恢复流程可能访问的模块状态');
  assert.notEqual(bootstrap, -1);

  const requiredInitializers = [
    ['Provider Registry', /\blet\s+providerRegistry\s*=\s*createProviderRegistry\(\{[\s\S]*?sendRequest:\s*apiFetch,[\s\S]*?sendSunlandRequest:[\s\S]*?\}\);/],
    ['session', /\blet\s+session\s*=\s*null\b/],
    ['conversations', /\blet\s+conversations\s*=\s*\[\s*\]/],
    ['currentId', /\blet\s+currentId\s*=\s*null\b/],
    ['history', /\blet\s+history\s*=\s*\[/],
    ['controller', /\blet\s+controller\s*=\s*null\b/],
    ['sendingLock', /\blet\s+sendingLock\s*=\s*false\b/],
    ['isStreaming', /\blet\s+isStreaming\s*=\s*false\b/],
    ['hasTypedOnce', /\blet\s+hasTypedOnce\s*=\s*false\b/],
    ['isLoadingHistory', /\blet\s+isLoadingHistory\s*=\s*false\b/],
    ['currentChatRender', /\blet\s+currentChatRender\s*=\s*Promise\.resolve\(\)/],
    ['lastUserMessage', /\blet\s+lastUserMessage\s*=\s*null\b/],
    ['syncTimer', /\blet\s+syncTimer\s*=\s*null\b/],
    ['cloudSyncRequest', /\blet\s+cloudSyncRequest\s*=\s*null\b/],
    ['SAFE_INLINE_IMAGE_PATTERN', /\bconst\s+SAFE_INLINE_IMAGE_PATTERN\s*=/],
  ];

  requiredInitializers.forEach(([label, pattern]) => {
    const match = pattern.exec(aiApp);
    assert.ok(match, `${label} initializer should exist`);
    assert.ok(match.index < bootstrap, `${label} must initialize before bootstrap`);
  });

  const bootstrapBlock = aiApp.slice(
    bootstrap,
    aiApp.indexOf('const sidebar = document.getElementById("sidebar")', bootstrap),
  );
  assert.match(bootstrapBlock, /await supabaseReady;\s*await checkLogin\(\{ waitForUserState: true \}\);\s*scheduleRenderUser\(\);/);
  assert.match(bootstrapBlock, /updateProviderCapabilityUI\(\)/);
  assert.match(bootstrapBlock, /window\.__SUNLAND_AI_RESOURCES_READY__/);
  assert.match(bootstrapBlock, /window\.__SUNLAND_AI_REVEAL__/);
  assert.doesNotMatch(bootstrapBlock, /setTimeout/);
  assert.doesNotMatch(aiApp, /postgres_changes|startRealtime|realtimeSub/);
  assert.match(aiApp, /cloudSyncRequest\?\.userId === userId/);
  assert.match(aiApp, /const CLOUD_SYNC_INTERVAL_MS = 60_000/);

  const checkLoginStart = aiApp.indexOf('async function checkLogin');
  const checkLoginEnd = aiApp.indexOf('function renderUserCore', checkLoginStart);
  const checkLoginBlock = aiApp.slice(checkLoginStart, checkLoginEnd);
  assert.match(checkLoginBlock, /restoreLocalConversationState/);
  assert.match(checkLoginBlock, /loadChat\(firstId\)|loadChat\(currentId\)/);
  assert.match(checkLoginBlock, /ReferenceError["']\) throw e/);
  assert.doesNotMatch(checkLoginBlock, /catch \(e\)[\s\S]*?setSession\(null\)/);

  const loadChatStart = aiApp.indexOf('function loadChat');
  const loadChatEnd = aiApp.indexOf('input.addEventListener', loadChatStart);
  const loadChatBlock = aiApp.slice(loadChatStart, loadChatEnd);
  assert.match(loadChatBlock, /currentModel = c\.model === "deepseek-v4-pro"/);
  assert.match(loadChatBlock, /persistCurrentConversationId/);
  assert.match(loadChatBlock, /history = JSON\.parse/);
  assert.match(loadChatBlock, /updateModelUI\(\)/);

  const capabilityStart = aiApp.indexOf('function updateProviderCapabilityUI');
  const modelUiStart = aiApp.indexOf('function updateModelUI');
  assert.ok(capabilityStart >= 0 && capabilityStart < bootstrap);
  assert.ok(modelUiStart > capabilityStart && modelUiStart < bootstrap);
  assert.match(aiApp.slice(modelUiStart, aiApp.indexOf('function getProviderBindingMessage', modelUiStart)), /updateProviderCapabilityUI\(\)/);
});
