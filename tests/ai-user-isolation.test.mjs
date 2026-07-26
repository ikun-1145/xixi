import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { restoreLocalConversationState } from '../ai/conversation-recovery.js';
import { SunlandProvider } from '../ai/providers/SunlandProvider.js';
import { IdentityAuthority } from '../ai/verified-identity.js';
import {
  SUNLAND_LOGIN_STATE_MESSAGE,
  normalizeUserId,
} from '../ai/user-identity.js';

const aiApp = fs.readFileSync(new URL('../ai/app.js', import.meta.url), 'utf8');

function createTrackedStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  const reads = [];
  const writes = [];

  return {
    reads,
    writes,
    getItem(key) {
      reads.push(key);
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      writes.push(key);
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    keys() {
      return [...values.keys()];
    },
    dump() {
      return Object.fromEntries(values.entries());
    },
  };
}

function createProvider(storage = createTrackedStorage()) {
  globalThis.window = { localStorage: storage };
  return { provider: new SunlandProvider(), storage };
}

function jwtFor(userId, exp = Math.floor(Date.now() / 1000) + 3600) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'test' })}.${encode({ sub: userId, exp })}.signature`;
}

async function verifiedIdentity(userId) {
  const token = jwtFor(userId);
  const authority = new IdentityAuthority({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ token, user: { id: userId, email: `${userId}@example.com` } }),
    }),
  });
  const result = await authority.resolve({ token });
  assert.equal(result.ok, true);
  return result.identity;
}

async function send(provider, { identity, conversationUserId, input }) {
  const deltas = [];
  const result = await provider.send({
    conversation: { provider: 'sunland', model: 'frost', userId: conversationUserId },
    identity,
    messages: [{ role: 'user', content: input }],
    onDelta: value => deltas.push(value),
  });
  return { result, deltas };
}

test('user A can remember a name while user B cannot read it', async () => {
  const { provider, storage } = createProvider();
  const identityA = await verifiedIdentity('user-a');
  const identityB = await verifiedIdentity('user-b');

  await send(provider, {
    identity: identityA,
    conversationUserId: 'user-a',
    input: '我叫小蓝',
  });
  const recalledByA = await send(provider, {
    identity: identityA,
    conversationUserId: 'user-a',
    input: '我叫什么',
  });
  const recalledByB = await send(provider, {
    identity: identityB,
    conversationUserId: 'user-b',
    input: '我叫什么',
  });

  assert.match(recalledByA.result.content, /小蓝/);
  assert.doesNotMatch(recalledByB.result.content, /小蓝/);
  assert.ok(storage.keys().includes('sunland_knowledge_user-a::memory'));
  assert.ok(storage.reads.includes('sunland_knowledge_user-b::memory'));
});

test('empty, undefined, null, reserved, and malformed userIds are blocked before storage access', async () => {
  const invalidIds = ['', undefined, null, ' ', 'anonymous', 'guest', 'default', 'bad/id'];

  for (const invalidId of invalidIds) {
    const { provider, storage } = createProvider();
    const { result, deltas } = await send(provider, {
      identity: invalidId,
      conversationUserId: invalidId,
      input: '我叫不该被保存',
    });

    assert.equal(result.blocked, true);
    assert.equal(result.content, SUNLAND_LOGIN_STATE_MESSAGE);
    assert.deepEqual(deltas, [SUNLAND_LOGIN_STATE_MESSAGE]);
    assert.equal(provider._engines.size, 0);
    assert.deepEqual(storage.reads, []);
    assert.deepEqual(storage.writes, []);
  }
});

test('damaged user objects cannot be coerced into a storage namespace', async () => {
  const { provider, storage } = createProvider();

  for (const damagedId of [{ id: 'user-a' }, ['user-a'], 12345]) {
    const { result } = await send(provider, {
      identity: damagedId,
      conversationUserId: 'user-a',
      input: '我叫什么',
    });
    assert.equal(result.blocked, true);
  }

  assert.equal(provider._engines.size, 0);
  assert.deepEqual(storage.reads, []);
  assert.deepEqual(storage.writes, []);
});

test('a session userId that differs from the conversation owner is blocked', async () => {
  const { provider, storage } = createProvider();
  const identityA = await verifiedIdentity('user-a');
  const { result } = await send(provider, {
    identity: identityA,
    conversationUserId: 'user-b',
    input: '我叫不该写入',
  });

  assert.equal(result.blocked, true);
  assert.equal(result.content, SUNLAND_LOGIN_STATE_MESSAGE);
  assert.equal(provider._engines.size, 0);
  assert.deepEqual(storage.reads, []);
  assert.deepEqual(storage.writes, []);
});

test('logging out and switching users never exposes the previous user memory', async () => {
  const { provider, storage } = createProvider();
  const identityA = await verifiedIdentity('user-a');
  const identityB = await verifiedIdentity('user-b');

  await send(provider, {
    identity: identityA,
    conversationUserId: 'user-a',
    input: '我叫前一个用户',
  });
  const loggedOut = await send(provider, {
    identity: null,
    conversationUserId: 'user-a',
    input: '我叫什么',
  });
  const nextUser = await send(provider, {
    identity: identityB,
    conversationUserId: 'user-b',
    input: '我叫什么',
  });

  assert.equal(loggedOut.result.blocked, true);
  assert.doesNotMatch(nextUser.result.content, /前一个用户/);
  assert.ok(storage.keys().includes('sunland_knowledge_user-a::memory'));
  assert.ok(storage.reads.includes('sunland_knowledge_user-b::memory'));
});

test('invalid requests never create an anonymous or shared fallback namespace', async () => {
  const { provider, storage } = createProvider();

  await send(provider, {
    identity: undefined,
    conversationUserId: undefined,
    input: '猫属于哺乳动物',
  });

  assert.equal(provider._engines.size, 0);
  assert.equal(storage.keys().some(key => /anonymous|guest|default/i.test(key)), false);
  assert.equal([...storage.reads, ...storage.writes].some(key => /anonymous|guest|default/i.test(key)), false);
});

test('legacy anonymous knowledge and memory are never loaded by a real user', async () => {
  const now = new Date().toISOString();
  const storage = createTrackedStorage({
    sunland_knowledge_anonymous: JSON.stringify([
      { id: 'legacy-fact', subject: '猫', relation: 'isA', object: '秘密类别', negated: false, source: 'user' },
    ]),
    'sunland_knowledge_anonymous::memory': JSON.stringify([
      { id: 'legacy-name', key: 'name', value: '匿名旧名字', createdAt: now, updatedAt: now },
    ]),
  });
  const { provider } = createProvider(storage);
  const identity = await verifiedIdentity('real-user');

  const recall = await send(provider, {
    identity,
    conversationUserId: 'real-user',
    input: '我叫什么',
  });
  const query = await send(provider, {
    identity,
    conversationUserId: 'real-user',
    input: '猫属于什么',
  });

  assert.doesNotMatch(recall.result.content, /匿名旧名字/);
  assert.doesNotMatch(query.result.content, /秘密类别/);
  assert.equal(storage.reads.some(key => key.includes('anonymous')), false);
});

test('conversation recovery reads only the validated session namespace and hides foreign Sunland owners', () => {
  const own = {
    id: 1,
    provider: 'sunland',
    model: 'frost',
    userId: 'user-a',
    history: [{ role: 'system', content: 'system' }],
  };
  const foreign = { ...own, id: 2, userId: 'user-b' };
  const storage = createTrackedStorage({
    'conversations_user-a': JSON.stringify([own, foreign]),
    'conversations_user-b': JSON.stringify([foreign]),
    'current_conversation_user-a': JSON.stringify(2),
  });
  const before = storage.dump()['conversations_user-b'];

  const result = restoreLocalConversationState({ storage, userId: 'user-a' });

  assert.deepEqual(result.conversations.map(item => item.id), [1]);
  assert.equal(result.currentId, 1);
  assert.deepEqual(storage.reads, [
    'conversations_user-a',
    'current_conversation_user-a',
  ]);
  assert.equal(storage.dump()['conversations_user-b'], before);
});

test('invalid session identity prevents conversation namespace reads entirely', () => {
  const storage = createTrackedStorage({
    conversations_anonymous: JSON.stringify([]),
    'conversations_[object Object]': JSON.stringify([]),
  });

  for (const userId of [null, undefined, '', 'anonymous', { id: 'user-a' }]) {
    const result = restoreLocalConversationState({ storage, userId });
    assert.equal(result.status, 'invalid-user');
    assert.deepEqual(result.conversations, []);
  }

  assert.deepEqual(storage.reads, []);
  assert.deepEqual(storage.writes, []);
});

test('userId format accepts production UUID/email shapes but rejects shared aliases', () => {
  assert.equal(normalizeUserId('550e8400-e29b-41d4-a716-446655440000'), '550e8400-e29b-41d4-a716-446655440000');
  assert.equal(normalizeUserId('fox@example.com'), 'fox@example.com');
  assert.equal(normalizeUserId('anonymous'), null);
  assert.equal(normalizeUserId(' user-a'), null);
  assert.equal(normalizeUserId('user/a'), null);
});

test('the live Sunland path validates session identity before mutation and passes it to the Provider', () => {
  const sendStart = aiApp.indexOf('async function send()');
  const sendEnd = aiApp.indexOf('input.addEventListener("keydown"', sendStart);
  const sendBlock = aiApp.slice(sendStart, sendEnd);
  const identityCheck = sendBlock.indexOf('!isSameUserIdentity(verifiedUserId, sendingConversation.userId)');
  const requestStart = sendBlock.indexOf('requestCoordinator.begin({');

  assert.notEqual(identityCheck, -1);
  assert.ok(identityCheck < requestStart);
  assert.match(aiApp, /identity: requestContext\.identity/);
  assert.match(aiApp, /if \(result\.blocked\) \{/);
  assert.match(aiApp, /filterConversationsForUser\([\s\S]*?normalizeCloudData\(data\.data, userId\)/);
  assert.match(aiApp, /filterConversationsForUser\([\s\S]*?normalizeCloudData\(payload\.new\?\.data, userId\)/);
});

test('logout code removes credentials but intentionally retains namespaced Sunland data', () => {
  const accountMenu = fs.readFileSync(new URL('../ai/account-menu.js', import.meta.url), 'utf8');

  assert.match(accountMenu, /removeItem\("token"\)/);
  assert.match(accountMenu, /removeItem\("user"\)/);
  assert.match(accountMenu, /clearVerifiedSession/);
  assert.doesNotMatch(accountMenu, /localStorage\.clear\(/);
  assert.doesNotMatch(accountMenu, /removeItem\([^\n]*sunland_/);
});
