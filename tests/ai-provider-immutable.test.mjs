import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { parseStoredConversations } from '../ai/conversation-recovery.js';
import {
  createConversation,
  mergeConversationCollections,
  mergeConversationRecords,
  migrateLegacyConversation,
  setConversationProvider,
} from '../ai/providers/conversation.js';
import { createProviderRegistry } from '../ai/providers/registry.js';

const aiApp = fs.readFileSync(new URL('../ai/app.js', import.meta.url), 'utf8');
const system = { role: 'system', content: 'system' };

function conversation(overrides = {}) {
  return {
    id: 1,
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    userId: 'user-a',
    title: 'local title',
    history: [system, { role: 'user', content: 'started' }],
    createdAt: 1,
    updatedAt: 10,
    ...overrides,
  };
}

test('unknown and malformed provider ids are rejected without DeepSeek fallback', () => {
  assert.throws(() => createConversation({ provider: 'unknown' }), /Unsupported conversation provider/);
  assert.equal(migrateLegacyConversation(conversation({ provider: 'unknown' })), null);
  const registry = createProviderRegistry({ sendRequest: async () => null });
  assert.equal(registry.get('unknown'), null);
  assert.equal(registry.get(undefined), null);
});

test('legacy missing provider alone migrates to DeepSeek', () => {
  const legacy = conversation();
  delete legacy.provider;
  delete legacy.model;
  const migrated = migrateLegacyConversation(legacy);
  assert.equal(migrated.provider, 'deepseek');
  assert.equal(migrated.model, 'deepseek-v4-flash');
});

test('local recovery preserves a started in-memory provider against newer stored data', () => {
  const existing = conversation({ provider: 'sunland', model: 'frost', updatedAt: 10 });
  const changed = conversation({
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    title: 'new stored title',
    history: [...existing.history, { role: 'assistant', content: 'new stored reply' }],
    updatedAt: 20,
  });
  const result = parseStoredConversations(JSON.stringify([changed]), [existing], 'user-a');

  assert.equal(result.conversations[0].provider, 'sunland');
  assert.equal(result.conversations[0].model, 'frost');
  assert.equal(result.conversations[0].title, 'new stored title');
  assert.equal(result.conversations[0].history.at(-1).content, 'new stored reply');
});

test('an invalid stored provider is rejected without discarding a legal in-memory copy', () => {
  const existing = conversation({ provider: 'sunland', model: 'frost' });
  const invalid = { ...existing, provider: 'unknown', updatedAt: 50 };
  const result = parseStoredConversations(JSON.stringify([invalid]), [existing], 'user-a');

  assert.equal(result.status, 'invalid');
  assert.equal(result.conversations.length, 1);
  assert.equal(result.conversations[0].provider, 'sunland');
});

test('cloud and realtime collection merges preserve provider while accepting mutable updates', () => {
  const local = conversation({ provider: 'deepseek', model: 'deepseek-v4-flash' });
  const remote = conversation({
    provider: 'sunland',
    model: 'frost',
    title: 'remote title',
    history: [...local.history, { role: 'assistant', content: 'remote history' }],
    updatedAt: 30,
  });

  for (const merged of [
    mergeConversationCollections([local], [remote]),
    mergeConversationCollections([local], [remote]),
  ]) {
    assert.equal(merged[0].provider, 'deepseek');
    assert.equal(merged[0].model, 'deepseek-v4-flash');
    assert.equal(merged[0].title, 'remote title');
    assert.equal(merged[0].history.at(-1).content, 'remote history');
  }
});

test('a remotely started conversation may establish provider only while local copy is empty', () => {
  const empty = conversation({
    provider: 'deepseek',
    history: [system],
    updatedAt: 40,
  });
  const startedRemote = conversation({ provider: 'sunland', model: 'frost', updatedAt: 20 });
  const merged = mergeConversationRecords(empty, startedRemote);

  assert.equal(merged.provider, 'sunland');
  assert.equal(merged.model, 'frost');
});

test('provider becomes physically non-writable after first real message', () => {
  const started = mergeConversationRecords(null, conversation({
    provider: 'sunland',
    model: 'frost',
    history: [{ role: 'user', content: 'first message' }],
  }));
  const descriptor = Object.getOwnPropertyDescriptor(started, 'provider');
  assert.equal(descriptor.writable, false);
  assert.equal(descriptor.configurable, false);
  assert.throws(() => { started.provider = 'deepseek'; }, TypeError);
});

test('provider selection is allowed only before the conversation starts', () => {
  const fresh = createConversation({ provider: 'deepseek', model: 'deepseek-v4-flash', userId: 'user-a' });
  fresh.history = [system];
  assert.equal(setConversationProvider(fresh, 'sunland', 'frost'), true);
  assert.equal(fresh.provider, 'sunland');
  fresh.history.push({ role: 'user', content: 'hello' });
  assert.equal(setConversationProvider(fresh, 'deepseek', 'deepseek-v4-flash'), false);
  assert.equal(fresh.provider, 'sunland');
  assert.equal(setConversationProvider(fresh, 'unknown'), false);
});

test('live local, cloud, and realtime code all use the centralized provider merge policy', () => {
  const assignments = [...aiApp.matchAll(/\.provider\s*=(?!=)/g)];
  assert.equal(assignments.length, 0);
  assert.match(aiApp, /setConversationProvider\(c, "sunland", "frost"\)/);
  assert.match(aiApp, /setConversationProvider\(c, "deepseek", currentModel\)/);
  assert.match(aiApp, /const hasStarted = hasConversationStarted\(c\)/);
  assert.match(aiApp, /latest && !hasConversationStarted\(latest\)/);
  assert.ok((aiApp.match(/mergeConversationCollections\(conversations,/g) || []).length >= 2);
  assert.match(aiApp, /!isSupportedProviderId\(sendingConversation\.provider\)/);
});
