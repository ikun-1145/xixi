import test from "node:test";
import assert from "node:assert/strict";

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

const { createSunlandEngine } = await import("../ai/vendor/sunland-core.js");
const { SunlandProvider } = await import("../ai/providers/SunlandProvider.js");
const { IdentityAuthority } = await import("../ai/verified-identity.js");

const INTERNAL_TERMS =
  /\b(?:parser|intent|candidate|confidence|reasoncodes?|diagnostics?|syntax|rule|memorymanager|knowledgestore)\b|语法规则|推理失败|没有匹配|知识节点|证据不可用/i;

function createEngine(options = {}) {
  return createSunlandEngine({
    semanticMode: "passive",
    semanticDebug: true,
    ...options,
  });
}

function snapshot(engine) {
  return {
    memory: engine.memory.list().map(({ key, value }) => ({ key, value })),
    knowledge: engine.knowledgeStore.all().map(
      ({ subject, relation, object, negated }) => ({
        subject,
        relation,
        object,
        negated,
      }),
    ),
  };
}

function respondWithAudit(engine, input) {
  const before = snapshot(engine);
  let reply = "";
  let error = null;
  try {
    reply = engine.respond(input);
  } catch (caught) {
    error = caught;
  }
  const after = snapshot(engine);
  return {
    reply,
    error,
    shadow: engine.getLastSemanticShadow(),
    memoryChanged:
      JSON.stringify(before.memory) !== JSON.stringify(after.memory),
    knowledgeChanged:
      JSON.stringify(before.knowledge) !== JSON.stringify(after.knowledge),
    leakedInternalTerm: INTERNAL_TERMS.test(reply),
    before,
    after,
  };
}

function tokenFor(userId) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "test" })}.${encode({
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

async function send(provider, identity, content) {
  return provider.send({
    conversation: {
      provider: "sunland",
      userId: identity.userId,
    },
    identity,
    messages: [{ role: "user", content }],
    onDelta() {},
  });
}

test("A: passive intents stay read-only and never expose internal terms", () => {
  const inputs = [
    "你好",
    "你好呀",
    "hello Sunland AI",
    "谢谢你",
    "多谢啦",
    "再见",
    "先走啦",
    "你是谁",
    "你叫什么",
    "Sunland AI 是什么",
    "你叫啥呀",
  ];

  for (const input of inputs) {
    const result = respondWithAudit(createEngine(), input);
    assert.equal(result.error, null, input);
    assert.equal(result.memoryChanged, false, input);
    assert.equal(result.knowledgeChanged, false, input);
    assert.equal(result.leakedInternalTerm, false, input);
    assert.equal(result.shadow?.semanticAdopted, true, input);
  }
});

test("B: low-evidence and negated name inputs never write Memory", () => {
  for (const input of ["名字", "名字小明", "我不是小明", "不要记住我叫小明"]) {
    const result = respondWithAudit(createEngine(), input);
    assert.equal(result.error, null, input);
    assert.equal(result.memoryChanged, false, input);
    assert.equal(result.leakedInternalTerm, false, input);
  }
});

test("B: an English display name remains lossless through the Legacy write path", () => {
  const engine = createEngine();
  const result = respondWithAudit(engine, "我的名字是 Alice Chen");

  assert.equal(result.error, null);
  assert.equal(result.memoryChanged, true);
  assert.equal(engine.memory.recall("name")?.value, "Alice Chen");
});

test("B: a supported explicit call-me expression still writes through Legacy", () => {
  const engine = createEngine();
  const result = respondWithAudit(engine, "你可以叫我霜蓝");

  assert.equal(result.error, null);
  assert.equal(result.memoryChanged, true);
  assert.equal(engine.memory.recall("name")?.value, "霜蓝");
  assert.equal(result.shadow?.fellBackToLegacy, true);
});

test("B/E: Greeting plus one explicit name writes exactly once", () => {
  const engine = createEngine();
  const result = respondWithAudit(engine, "你好，我叫小明");

  assert.equal(result.error, null);
  assert.equal(result.memoryChanged, true);
  assert.deepEqual(result.after.memory, [{ key: "name", value: "小明" }]);
  assert.deepEqual(result.after.knowledge, []);
  assert.equal(result.shadow?.fellBackToLegacy, true);
});

test("B: Semantic RecallName remains a read-only Memory lookup", () => {
  const engine = createEngine();
  engine.respond("我叫小明");
  const before = snapshot(engine);
  const result = respondWithAudit(engine, "你记得我叫什么吗");

  assert.equal(result.error, null);
  assert.equal(result.memoryChanged, false);
  assert.deepEqual(result.after, before);
  assert.match(result.reply, /小明/);
  assert.equal(result.shadow?.adapterKind, "adopt");
});

test("C: complete Legacy teaching writes only the intended triple", () => {
  const cases = [
    ["猫属于动物", { subject: "猫", relation: "属于", object: "动物" }],
    ["猫是一种动物", { subject: "猫", relation: "是", object: "一种动物" }],
    ["猫会爬树", { subject: "猫", relation: "会", object: "爬树" }],
    ["鸟有翅膀", { subject: "鸟", relation: "有", object: "翅膀" }],
    [
      "霜蓝指的是我的角色名",
      { subject: "霜蓝", relation: "意思是", object: "我的角色名" },
    ],
  ];

  for (const [input, expected] of cases) {
    const engine = createEngine();
    const result = respondWithAudit(engine, input);
    assert.equal(result.error, null, input);
    assert.equal(result.knowledgeChanged, true, input);
    assert.deepEqual(
      result.after.knowledge,
      [{ ...expected, negated: false }],
      input,
    );
    assert.equal(result.shadow?.fellBackToLegacy, true, input);
  }
});

test("C/D: queries, incomplete expressions, negation and prohibitions never teach", () => {
  const inputs = [
    "猫是什么",
    "猫会什么",
    "鸟有什么",
    "霜蓝是什么意思",
    "猫是",
    "你会吗",
    "教你一个事实",
    "猫不是狗",
    "猫不会飞",
    "鸟没有翅膀",
    "鸟有没有翅膀",
    "猫是不是动物",
    "别记住这个事实",
    "你好，我不是小明",
  ];

  for (const input of inputs) {
    const result = respondWithAudit(createEngine(), input);
    assert.equal(result.error, null, input);
    assert.equal(result.memoryChanged, false, input);
    assert.equal(result.knowledgeChanged, false, input);
    assert.equal(result.leakedInternalTerm, false, input);
  }
});

test("E: compound name plus teaching cannot corrupt either store", () => {
  const engine = createEngine();
  const result = respondWithAudit(engine, "我叫小明，猫属于动物");

  assert.equal(result.error, null);
  assert.equal(result.memoryChanged, false);
  assert.equal(result.knowledgeChanged, false);
  assert.deepEqual(result.after, { memory: [], knowledge: [] });
  assert.equal(result.leakedInternalTerm, false);
});

test("E: an alternative question never becomes a positive fact", () => {
  const engine = createEngine();
  const result = respondWithAudit(engine, "猫会飞还是会游泳");

  assert.equal(result.error, null);
  assert.equal(result.knowledgeChanged, false);
  assert.equal(result.leakedInternalTerm, false);
});

test("F: unknown, empty, emoji, mixed, long and punctuated inputs stay safe", () => {
  const inputs = [
    "xqzv-7391-random",
    "   ",
    "🦊",
    "猫 qzv 蓝色 API?",
    `${"这是一段很长但合理的输入，".repeat(80)}请告诉我你是否理解。`,
    "？！；，……Hello——猫？？",
  ];

  for (const input of inputs) {
    const result = respondWithAudit(createEngine(), input);
    assert.equal(result.error, null, input.slice(0, 40));
    assert.equal(result.memoryChanged, false, input.slice(0, 40));
    assert.equal(result.knowledgeChanged, false, input.slice(0, 40));
    assert.equal(result.leakedInternalTerm, false, input.slice(0, 40));
  }
});

test("F: Semantic exceptions fall back without breaking the next message", () => {
  const engine = createEngine({
    semanticRuntime: {
      analyze() {
        throw new Error("forced semantic failure");
      },
    },
  });

  const first = respondWithAudit(engine, "你好");
  const second = respondWithAudit(engine, "谢谢你");

  assert.equal(first.error, null);
  assert.equal(second.error, null);
  assert.equal(first.shadow?.semanticError, true);
  assert.equal(second.shadow?.semanticError, true);
  assert.equal(first.leakedInternalTerm, false);
  assert.equal(second.leakedInternalTerm, false);
});

test("G: Provider engines isolate two verified users and never share names", async () => {
  const provider = new SunlandProvider();
  const userA = await identityFor("acceptance-a@example.com");
  const userB = await identityFor("acceptance-b@example.com");

  await send(provider, userA, "我叫小明");
  const recallA = await send(provider, userA, "我叫什么");
  const recallB = await send(provider, userB, "我叫什么");

  assert.match(recallA.content, /小明/);
  assert.doesNotMatch(recallB.content, /小明/);
  assert.equal(provider._engines.size, 2);
  assert.notEqual(provider._getEngine(userA), provider._getEngine(userB));
});
