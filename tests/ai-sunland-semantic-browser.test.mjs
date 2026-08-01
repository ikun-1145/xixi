import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function createStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

globalThis.window = { localStorage: createStorage() };

const { createSunlandEngine } = await import('../ai/vendor/sunland-core.js');
const { SunlandProvider } = await import('../ai/providers/SunlandProvider.js');
const { createProviderRegistry } = await import('../ai/providers/registry.js');
const { IdentityAuthority } = await import('../ai/verified-identity.js');

const providerSource = fs.readFileSync(
  new URL('../ai/providers/SunlandProvider.js', import.meta.url),
  'utf8',
);
const deepSeekSource = fs.readFileSync(
  new URL('../ai/providers/DeepSeekProvider.js', import.meta.url),
  'utf8',
);

function tokenFor(userId) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
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
  const result = await authority.resolve({ token });
  assert.equal(result.ok, true);
  return result.identity;
}

function fakeDeepSeekResponse(content = 'ok') {
  const encoded = new TextEncoder().encode(
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n` +
    'data: [DONE]\n',
  );
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: stream,
    text: async () => '',
  };
}

async function sendSunland(provider, identity, content) {
  return provider.send({
    conversation: {
      provider: 'sunland',
      userId: identity.userId,
    },
    identity,
    messages: [{ role: 'user', content }],
    onDelta: () => {},
  });
}

test('SunlandProvider explicitly enables passive Context mode and disables Shadow diagnostics', async () => {
  assert.match(
    providerSource,
    /createSunlandEngine\(\{[\s\S]*?semanticMode:\s*["']passive["'][\s\S]*?semanticDebug:\s*false[\s\S]*?semanticContextMode:\s*["']enabled["'][\s\S]*?\}\)/,
  );
  assert.doesNotMatch(providerSource, /console\.(?:log|debug|info)\([^)]*semantic/i);

  const identity = await identityFor('semantic-config@example.com');
  const provider = new SunlandProvider();
  const engine = provider._getEngine(identity);

  assert.equal(engine.semanticMode, 'passive');
  assert.equal(engine.semanticContextMode, 'enabled');
  assert.equal(engine.getLastSemanticShadow(), null);
  assert.equal(provider._engines.size, 1);
});

test('browser bundle exposes passive clarification and read-only Query behavior', async () => {
  const identity = await identityFor('semantic-read@example.com');
  const provider = new SunlandProvider();
  const engine = provider._getEngine(identity);

  const capability = await sendSunland(provider, identity, '你会吗');
  assert.match(capability.content, /会做什么/);
  assert.deepEqual(engine.knowledgeStore.all(), []);

  const incomplete = await sendSunland(provider, identity, '猫是');
  assert.match(incomplete.content, /缺少|还缺少|再告诉我/);
  assert.deepEqual(engine.knowledgeStore.all(), []);

  engine.knowledgeStore.add(
    { subject: '鸟', relation: '有', object: '翅膀', negated: false },
    { source: 'user' },
  );
  const query = await sendSunland(provider, identity, '鸟有什么');
  assert.match(query.content, /翅膀/);

  const greeting = await sendSunland(provider, identity, '你好');
  assert.ok(greeting.content.length > 0);
  assert.doesNotMatch(
    `${capability.content}\n${incomplete.content}\n${query.content}\n${greeting.content}`,
    /parser|intent|candidate|confidence|reasonCodes|diagnostics|语法规则/i,
  );
});

test('browser passive mode keeps admitted positive Memory and Knowledge writes on Legacy only', async () => {
  const identity = await identityFor('semantic-write@example.com');
  const provider = new SunlandProvider();
  const engine = provider._getEngine(identity);

  const remembered = await sendSunland(provider, identity, '我叫小明');
  assert.match(remembered.content, /小明/);
  assert.equal(engine.memory.recall('name')?.value, '小明');

  const learned = await sendSunland(provider, identity, '猫属于动物');
  assert.match(learned.content, /猫/);
  assert.equal(
    engine.knowledgeStore.has({
      subject: '猫',
      relation: '属于',
      object: '动物',
      negated: false,
    }),
    true,
  );

  await sendSunland(provider, identity, '鸟有翅膀');
  assert.equal(
    engine.knowledgeStore.has({
      subject: '鸟',
      relation: '有',
      object: '翅膀',
      negated: false,
    }),
    true,
  );

  await sendSunland(provider, identity, '猫不是狗');
  assert.equal(
    engine.knowledgeStore.has({
      subject: '猫',
      relation: '是',
      object: '狗',
      negated: true,
    }),
    false,
  );

  const factCount = engine.knowledgeStore.all().length;
  await sendSunland(provider, identity, '猫会飞还是会游泳');
  await sendSunland(provider, identity, '鸟有没有翅膀');
  assert.equal(engine.knowledgeStore.all().length, factCount);
  assert.equal(engine.getLastSemanticShadow(), null);
});

test('browser bundle aligns read-only definition queries without new writes', async () => {
  const identity = await identityFor('relation-alignment@example.com');
  const provider = new SunlandProvider();
  const engine = provider._getEngine(identity);

  await sendSunland(provider, identity, '猫属于动物');
  const beforeNaturalQuery = JSON.stringify(engine.knowledgeStore.all());
  const naturalQuery = await sendSunland(
    provider,
    identity,
    '猫是什么',
  );
  assert.match(naturalQuery.content, /动物/);
  assert.equal(
    JSON.stringify(engine.knowledgeStore.all()),
    beforeNaturalQuery,
  );

  await sendSunland(provider, identity, '狐狸是一种动物');
  const beforeLegacyQuery = JSON.stringify(engine.knowledgeStore.all());
  const legacyQuery = await sendSunland(
    provider,
    identity,
    '狐狸属于什么',
  );
  assert.match(legacyQuery.content, /动物/);
  assert.doesNotMatch(legacyQuery.content, /一种动物/);
  assert.equal(
    JSON.stringify(engine.knowledgeStore.all()),
    beforeLegacyQuery,
  );

  assert.doesNotMatch(
    `${naturalQuery.content}\n${legacyQuery.content}`,
    /relation-alignment|queriedRelation|matchedRelation|policyId/i,
  );
});

test('browser bundle falls back to Legacy when Semantic throws', () => {
  const legacy = createSunlandEngine({
    personalityId: 'plain',
    semanticMode: 'off',
  });
  const fallback = createSunlandEngine({
    personalityId: 'plain',
    semanticMode: 'passive',
    semanticDebug: false,
    semanticRuntime: {
      analyze() {
        throw new Error('semantic failed');
      },
    },
  });

  assert.equal(fallback.respond('你好'), legacy.respond('你好'));
  fallback.knowledgeStore.add({
    subject: '猫',
    relation: '属于',
    object: '动物',
    negated: false,
  });
  assert.doesNotMatch(fallback.respond('猫是什么'), /动物/);
  assert.equal(fallback.getLastSemanticShadow(), null);
});

test('completely unknown browser input keeps diagnostics out of the final reply', async () => {
  const identity = await identityFor('semantic-unknown@example.com');
  const provider = new SunlandProvider();
  const reply = await sendSunland(provider, identity, '完全未知的表达 🐾');

  assert.match(reply.content, /没理解清楚|换一种说法|相关信息/);
  assert.doesNotMatch(
    reply.content,
    /parser|intent|candidate|confidence|reasonCodes|diagnostics|语法规则/i,
  );
});

test('DeepSeek Provider path does not reference or instantiate Semantic Core', async () => {
  assert.doesNotMatch(
    deepSeekSource,
    /sunland-core|createSunlandEngine|analyzeSemanticInput|planUnderstanding|semanticMode/,
  );

  const registry = createProviderRegistry({
    sendRequest: async () => fakeDeepSeekResponse('DeepSeek only'),
  });
  const sunland = registry.get('sunland');
  assert.equal(sunland._engines.size, 0);

  const result = await registry.get('deepseek').send({
    conversation: {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
    },
    messages: [{ role: 'user', content: '你好' }],
    onDelta: () => {},
  });

  assert.equal(result.content, 'DeepSeek only');
  assert.equal(sunland._engines.size, 0);
});
