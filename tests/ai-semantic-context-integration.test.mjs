import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function createStorage() {
  const data = new Map();
  return {
    getItem: key => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key),
  };
}

globalThis.window = { localStorage: createStorage() };

const {
  applyConversationSemanticContextUpdate,
  createConversation,
  mergeConversationRecords,
  migrateLegacyConversation,
} = await import('../ai/providers/conversation.js');
const { RequestCoordinator } = await import('../ai/request-context.js');
const {
  restoreLocalConversationState,
} = await import('../ai/conversation-recovery.js');
const { SunlandProvider } = await import('../ai/providers/SunlandProvider.js');
const { IdentityAuthority } = await import('../ai/verified-identity.js');

const appSource = fs.readFileSync(
  new URL('../ai/app.js', import.meta.url),
  'utf8',
);
const deepSeekSource = fs.readFileSync(
  new URL('../ai/providers/DeepSeekProvider.js', import.meta.url),
  'utf8',
);

function tokenFor(userId) {
  const encode = value =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'test' })}.${encode({
    sub: userId,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}.signature`;
}

async function identityFor(userId) {
  const token = tokenFor(userId);
  const authority = new IdentityAuthority({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ token, user: { id: userId } }),
    }),
  });
  return (await authority.resolve({ token })).identity;
}

function context(version, subject = '猫', relation = '会') {
  return {
    schemaVersion: 1,
    version,
    recentTurns: version === 0
      ? []
      : [{
          turnId: `turn-${version}`,
          speaker: 'user',
          concepts: [],
          entityReferences: [{ kind: 'subject', value: subject }],
          focusEntity: { kind: 'subject', value: subject },
          relation,
        }],
  };
}

async function sendAndCommit(provider, identity, conversation, input, turnId) {
  const result = await provider.send({
    conversation,
    identity,
    messages: [{ role: 'user', content: input }],
    semanticContext: conversation.semanticContext,
    turnId,
    canCommitSemanticContext: () => true,
    signal: new AbortController().signal,
    onDelta: () => {},
  });
  applyConversationSemanticContextUpdate(
    conversation,
    result.semanticContextUpdate,
  );
  return result;
}

test('conversation migration owns context only for Sunland', () => {
  const sunland = createConversation({
    provider: 'sunland',
    model: 'frost',
    userId: 'user-a',
  });
  const deepseek = createConversation({
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    userId: 'user-a',
  });
  const oldSunland = migrateLegacyConversation({
    ...sunland,
    semanticContext: undefined,
  });
  const damaged = migrateLegacyConversation({
    ...sunland,
    semanticContext: { schemaVersion: 1, version: 99, recentTurns: 'bad' },
  });
  const pollutedDeepSeek = migrateLegacyConversation({
    ...deepseek,
    semanticContext: context(8, 'foreign'),
  });

  assert.deepEqual(sunland.semanticContext, context(0));
  assert.equal('semanticContext' in deepseek, false);
  assert.deepEqual(oldSunland.semanticContext, context(0));
  assert.deepEqual(damaged.semanticContext, context(0));
  assert.equal('semanticContext' in pollutedDeepSeek, false);
});

test('refresh restores valid Context and safely migrates an old Sunland conversation', () => {
  const storage = createStorage();
  const current = createConversation({
    provider: 'sunland',
    model: 'frost',
    userId: 'user-a',
  });
  current.semanticContext = context(2, '猫', '会');
  const old = {
    ...createConversation({
      provider: 'sunland',
      model: 'frost',
      userId: 'user-a',
    }),
  };
  old.id += 1;
  delete old.semanticContext;
  storage.setItem('conversations_user-a', JSON.stringify([current, old]));
  storage.setItem('current_conversation_user-a', JSON.stringify(current.id));

  const restored = restoreLocalConversationState({
    storage,
    userId: 'user-a',
  });

  assert.equal(restored.selectedConversation.semanticContext.version, 2);
  assert.equal(
    restored.selectedConversation.semanticContext.recentTurns[0].focusEntity
      .value,
    '猫',
  );
  assert.deepEqual(
    restored.conversations.find(item => item.id === old.id).semanticContext,
    context(0),
  );
});

test('cloud/realtime merge accepts only a higher valid context version', () => {
  const local = {
    ...createConversation({
      provider: 'sunland',
      model: 'frost',
      userId: 'user-a',
    }),
    semanticContext: context(3, '猫'),
    history: [{ role: 'user', content: 'local' }],
    updatedAt: 100,
  };
  const higher = {
    ...local,
    semanticContext: context(4, '鸟'),
    title: 'remote',
    updatedAt: 200,
  };
  const equal = {
    ...higher,
    semanticContext: context(3, '狗'),
    updatedAt: 300,
  };
  const damaged = {
    ...higher,
    semanticContext: { schemaVersion: 1, version: 50, recentTurns: null },
    updatedAt: 400,
  };

  const upgraded = mergeConversationRecords(local, higher);
  assert.equal(upgraded.semanticContext.version, 4);
  assert.equal(upgraded.semanticContext.focusEntity, undefined);
  assert.equal(
    upgraded.semanticContext.recentTurns[0].focusEntity.value,
    '鸟',
  );
  assert.equal(
    mergeConversationRecords(local, equal).semanticContext.recentTurns[0]
      .focusEntity.value,
    '猫',
  );
  assert.equal(
    mergeConversationRecords(local, damaged).semanticContext.version,
    3,
  );
});

test('foreign owner cannot merge context into the current conversation', () => {
  const local = {
    ...createConversation({
      provider: 'sunland',
      model: 'frost',
      userId: 'user-a',
    }),
    semanticContext: context(2, '猫'),
  };
  const foreign = {
    ...local,
    userId: 'user-b',
    semanticContext: context(9, '狗'),
    updatedAt: local.updatedAt + 100,
  };

  assert.deepEqual(
    mergeConversationRecords(local, foreign).semanticContext,
    local.semanticContext,
  );
});

test('RequestCoordinator captures and commits context to only its original target', async () => {
  const identity = await identityFor('user-a');
  const first = createConversation({
    provider: 'sunland',
    model: 'frost',
    userId: 'user-a',
  });
  const second = createConversation({
    provider: 'sunland',
    model: 'frost',
    userId: 'user-a',
  });
  second.id += 1;
  const conversations = [first, second];
  const coordinator = new RequestCoordinator({
    getConversation: id => conversations.find(item => item.id === id),
    getCurrentUserId: () => 'user-a',
  });
  const request = coordinator.begin({
    conversation: first,
    identity,
    userId: 'user-a',
    providerId: 'sunland',
    model: 'frost',
    deep: false,
    history: [],
  });
  const update = {
    kind: 'replace',
    baseVersion: 0,
    nextVersion: 1,
    context: context(1, '猫'),
  };

  assert.deepEqual(request.semanticContext, context(0));
  assert.equal(request.semanticContextVersion, 0);
  const saved = coordinator.appendMessageWithSemanticContext(
    request,
    { role: 'assistant', content: 'answer' },
    update,
  );
  assert.deepEqual(saved, { messageSaved: true, contextCommitted: true });
  assert.equal(first.semanticContext.version, 1);
  assert.equal(second.semanticContext.version, 0);
});

test('Abort, deletion, identity change and late versions discard context', async () => {
  const identity = await identityFor('user-a');
  let currentUserId = 'user-a';
  let conversations = [
    createConversation({
      provider: 'sunland',
      model: 'frost',
      userId: 'user-a',
    }),
  ];
  const coordinator = new RequestCoordinator({
    getConversation: id => conversations.find(item => item.id === id),
    getCurrentUserId: () => currentUserId,
  });
  const begin = () => coordinator.begin({
    conversation: conversations[0],
    identity,
    userId: 'user-a',
    providerId: 'sunland',
    model: 'frost',
    deep: false,
    history: [],
  });
  const update = {
    kind: 'replace',
    baseVersion: 0,
    nextVersion: 1,
    context: context(1),
  };

  const aborted = begin();
  coordinator.abort(aborted);
  assert.equal(coordinator.canCommitSemanticContext(aborted), false);
  coordinator.finish(aborted);

  const stale = begin();
  conversations[0].semanticContext = context(1, '鸟');
  assert.equal(coordinator.canCommitSemanticContext(stale), false);
  assert.equal(
    coordinator.appendMessageWithSemanticContext(
      stale,
      { role: 'assistant', content: 'late' },
      update,
    ).contextCommitted,
    false,
  );
  coordinator.finish(stale);

  const switched = begin();
  currentUserId = 'user-b';
  assert.equal(coordinator.canCommitSemanticContext(switched), false);
  currentUserId = 'user-a';
  coordinator.finish(switched);

  conversations[0].semanticContext = context(0);
  const deleted = begin();
  conversations = [];
  assert.equal(coordinator.canCommitSemanticContext(deleted), false);
});

test('SunlandProvider explicitly enables context and returns updates', async () => {
  const identity = await identityFor('provider-context@example.com');
  const provider = new SunlandProvider();
  const conversation = createConversation({
    provider: 'sunland',
    model: 'frost',
    userId: identity.userId,
  });
  const result = await sendAndCommit(
    provider,
    identity,
    conversation,
    '猫是什么',
    'turn-1',
  );

  assert.equal(provider._getEngine(identity).semanticContextMode, 'enabled');
  assert.equal(result.semanticContextUpdate.kind, 'replace');
  assert.equal(conversation.semanticContext.version, 1);
});

test('real browser Provider supports the four bounded follow-up scenarios', async () => {
  const identity = await identityFor('follow-up@example.com');
  const provider = new SunlandProvider();
  const engine = provider._getEngine(identity);
  engine.knowledgeStore.add(
    { subject: '猫', relation: '会', object: '爬树', negated: false },
    { source: 'user' },
  );
  engine.knowledgeStore.add(
    { subject: '鸟', relation: '会', object: '飞', negated: false },
    { source: 'user' },
  );

  const one = createConversation({
    provider: 'sunland', model: 'frost', userId: identity.userId,
  });
  await sendAndCommit(provider, identity, one, '猫是什么', 'one-1');
  assert.match(
    (await sendAndCommit(provider, identity, one, '它会什么', 'one-2')).content,
    /爬树/,
  );

  const two = createConversation({
    provider: 'sunland', model: 'frost', userId: identity.userId,
  });
  await sendAndCommit(provider, identity, two, '猫会什么', 'two-1');
  assert.match(
    (await sendAndCommit(provider, identity, two, '鸟呢', 'two-2')).content,
    /飞/,
  );

  const three = createConversation({
    provider: 'sunland', model: 'frost', userId: identity.userId,
  });
  await sendAndCommit(provider, identity, three, '猫有什么', 'three-1');
  await sendAndCommit(provider, identity, three, '那你呢', 'three-2');
  assert.deepEqual(three.semanticContext.recentTurns.at(-1).focusEntity, {
    kind: 'self',
    value: 'Sunland AI · Beta',
  });
  assert.equal(three.semanticContext.recentTurns.at(-1).relation, '有');

  const four = createConversation({
    provider: 'sunland', model: 'frost', userId: identity.userId,
  });
  await sendAndCommit(provider, identity, four, '霜蓝是什么意思', 'four-1');
  await sendAndCommit(provider, identity, four, 'Sunland AI 呢', 'four-2');
  assert.equal(four.semanticContext.recentTurns.at(-1).relation, '意思是');
  assert.doesNotMatch(
    JSON.stringify(four.semanticContext),
    /raw|diagnostics|confidence|完整回复/,
  );
});

test('browser Provider clarifies multiple focus entities instead of guessing', async () => {
  const identity = await identityFor('ambiguous@example.com');
  const provider = new SunlandProvider();
  const conversation = createConversation({
    provider: 'sunland', model: 'frost', userId: identity.userId,
  });
  conversation.semanticContext = {
    schemaVersion: 1,
    version: 1,
    recentTurns: [{
      turnId: 'multi',
      speaker: 'user',
      concepts: [],
      entityReferences: [
        { kind: 'subject', value: '猫' },
        { kind: 'subject', value: '狗' },
      ],
      relation: '属于',
    }],
  };

  const result = await sendAndCommit(
    provider,
    identity,
    conversation,
    '它是什么',
    'multi-2',
  );

  assert.match(result.content, /猫.*狗|狗.*猫/);
  assert.equal(conversation.semanticContext.version, 1);
});

test('aborted Provider request emits no reply or Context update', async () => {
  const identity = await identityFor('aborted@example.com');
  const provider = new SunlandProvider();
  const conversation = createConversation({
    provider: 'sunland', model: 'frost', userId: identity.userId,
  });
  const controller = new AbortController();
  controller.abort();

  const result = await provider.send({
    conversation,
    identity,
    messages: [{ role: 'user', content: '猫是什么' }],
    semanticContext: conversation.semanticContext,
    turnId: 'aborted-1',
    signal: controller.signal,
    canCommitSemanticContext: () => false,
    onDelta: () => {
      throw new Error('aborted request must not render');
    },
  });

  assert.equal(result.blocked, true);
  assert.equal(result.semanticContextUpdate, null);
  assert.equal(conversation.semanticContext.version, 0);
});

test('conversation and user boundaries never share focus', async () => {
  const identityA = await identityFor('context-a@example.com');
  const identityB = await identityFor('context-b@example.com');
  const provider = new SunlandProvider();
  const conversationA = createConversation({
    provider: 'sunland', model: 'frost', userId: identityA.userId,
  });
  const conversationB = createConversation({
    provider: 'sunland', model: 'frost', userId: identityA.userId,
  });
  const userB = createConversation({
    provider: 'sunland', model: 'frost', userId: identityB.userId,
  });

  await sendAndCommit(provider, identityA, conversationA, '猫是什么', 'a-1');
  const otherConversation = await sendAndCommit(
    provider, identityA, conversationB, '它会什么', 'a-b-1',
  );
  const otherUser = await sendAndCommit(
    provider, identityB, userB, '它是什么', 'b-1',
  );

  assert.match(otherConversation.content, /谁|什么/);
  assert.match(otherUser.content, /谁|什么/);
  assert.equal(conversationB.semanticContext.version, 0);
  assert.equal(userB.semanticContext.version, 0);
});

test('context cannot complete Memory or Knowledge side effects', async () => {
  const identity = await identityFor('context-effects@example.com');
  const provider = new SunlandProvider();
  const conversation = createConversation({
    provider: 'sunland', model: 'frost', userId: identity.userId,
  });
  const engine = provider._getEngine(identity);

  await sendAndCommit(provider, identity, conversation, '猫是什么', 'turn-1');
  await sendAndCommit(provider, identity, conversation, '它是动物', 'turn-2');
  await sendAndCommit(provider, identity, conversation, '我叫', 'turn-3');
  await sendAndCommit(provider, identity, conversation, '小明', 'turn-4');

  assert.equal(engine.knowledgeStore.all().length, 0);
  assert.equal(engine.memory.recall('name'), null);
});

test('browser app wires snapshot, version guard, original target and atomic final save', () => {
  assert.match(appSource, /semanticContext:\s*requestContext\.semanticContext/);
  assert.match(appSource, /turnId:\s*requestContext\.requestId/);
  assert.match(
    appSource,
    /requestCoordinator\.canCommitSemanticContext\(requestContext\)/,
  );
  assert.match(
    appSource,
    /appendMessageWithSemanticContext\(\s*requestContext/,
  );
  assert.doesNotMatch(deepSeekSource, /semanticContext|engine\.process/);
});
