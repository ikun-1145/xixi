/**
 * Manual smoke test for the Provider framework -- NOT wired into any CI
 * (the production site has none). Run by hand after touching anything in
 * `ai/providers/` or after re-running `npm run build:lib`:
 *
 *   node ai/providers/selftest.mjs
 *
 * No framework, no dependencies: plain assertions, non-zero exit on
 * failure. Mocks `window.localStorage` (Node has no DOM) so
 * `SunlandProvider` can be exercised exactly as it runs in the browser.
 */
import assert from "node:assert/strict";

// --- minimal window.localStorage mock (Node has no DOM) ---
function createFakeLocalStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
}
globalThis.window = { localStorage: createFakeLocalStorage() };

const { createProviderRegistry } = await import("./registry.js");
const {
  createConversation,
  hasConversationStarted,
  mergeConversationRecords,
  migrateLegacyConversation,
  migrateLegacyConversations,
} =
  await import("./conversation.js");
const { IdentityAuthority } = await import("../verified-identity.js");

let passed = 0;
function check(label, condition) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok - ${label}`);
}

function tokenFor(userId) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "test" })}.${encode({ sub: userId, exp: Math.floor(Date.now() / 1000) + 3600 })}.signature`;
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

// --- fake DeepSeek SSE response, mimicking api.sunland.dev's real shape ---
function fakeSSEResponse(chunks, { status = 200, remain = 42 } = {}) {
  const encoder = new TextEncoder();
  let i = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]));
        i += 1;
      } else {
        controller.close();
      }
    },
  });
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => (k === "x-remain" ? String(remain) : null) },
    body: stream,
    text: async () => "mock error body",
  };
}

console.log("Provider framework self-test");

// 1. DeepSeekProvider: streams delta.content, respects x-remain, injected sendRequest.
{
  const sseBody =
    `data: ${JSON.stringify({ choices: [{ delta: { content: "你" } }] })}\n` +
    `data: ${JSON.stringify({ choices: [{ delta: { content: "好" } }] })}\n` +
    `data: [DONE]\n`;
  let sentBody = null;
  const registry = createProviderRegistry({
    sendRequest: async (body) => {
      sentBody = body;
      return fakeSSEResponse([sseBody]);
    },
  });
  const deepseek = registry.get("deepseek");
  check("registry resolves deepseek provider", deepseek.id === "deepseek");
  check("deepseek provider is never Pro-gated at the Provider layer", deepseek.requiresPro === false);

  const deltas = [];
  const result = await deepseek.send({
    conversation: { provider: "deepseek", model: "deepseek-v4-flash" },
    messages: [{ role: "user", content: "你好" }],
    onDelta: (text) => deltas.push(text),
  });
  check("deepseek forwards model/messages to sendRequest", sentBody?.model === "deepseek-v4-flash");
  check("deepseek streams accumulating deltas", deltas.join("|") === "你|你好");
  check("deepseek returns final content", result.content === "你好");
  check("deepseek surfaces x-remain as `remaining`", result.remaining === 42);
}

// 2. DeepSeekProvider: 429 -> RATE_LIMITED error, non-ok -> HTTP_ERROR.
{
  const registry = createProviderRegistry({ sendRequest: async () => ({ status: 429, ok: false }) });
  let threw = null;
  try {
    await registry.get("deepseek").send({ conversation: {}, messages: [], onDelta: () => {} });
  } catch (e) {
    threw = e;
  }
  check("429 response throws a RATE_LIMITED error", threw?.code === "RATE_LIMITED");
}

// 3. SunlandProvider: independent per-user shared brain, no network.
{
  const registry = createProviderRegistry({ sendRequest: async () => fakeSSEResponse([]) });
  const sunland = registry.get("sunland");
  check("registry resolves sunland provider", sunland.id === "sunland");
  check("sunland is never Pro-gated (free for all regular users)", sunland.requiresPro === false);
  const identity1 = await identityFor("user-1");
  const identity2 = await identityFor("user-2");

  const convoA1 = { provider: "sunland", userId: "user-1" };
  const engineA = sunland._getEngine(identity1);
  check("sunland browser engine explicitly runs passive semantic mode", engineA.semanticMode === "passive");
  check("sunland browser engine explicitly enables semantic conversation context", engineA.semanticContextMode === "enabled");
  check("sunland production engine does not retain Shadow diagnostics", engineA.getLastSemanticShadow() === null);

  const contextConversation = createConversation({
    provider: "sunland",
    model: "frost",
    userId: "user-1",
  });
  const clarification = await sunland.send({
    conversation: contextConversation,
    identity: identity1,
    messages: [{ role: "user", content: "你会吗" }],
    semanticContext: contextConversation.semanticContext,
    turnId: "selftest-turn-1",
    canCommitSemanticContext: () => true,
    onDelta: () => {},
  });
  check("passive semantic mode asks for missing capability detail", clarification.content.includes("会做什么"));
  check("Sunland observation stays off unless explicitly requested", !("observationSummary" in clarification));
  check("incomplete capability input never becomes taught Knowledge", !engineA.knowledgeStore.has({ subject: "你", relation: "会", object: "吗", negated: false }));
  const observedGreeting = await sunland.send({
    conversation: contextConversation,
    identity: identity1,
    messages: [{ role: "user", content: "你好" }],
    semanticContext: contextConversation.semanticContext,
    turnId: "selftest-observation",
    canCommitSemanticContext: () => true,
    observationMode: "summary",
    onDelta: () => {},
  });
  check("explicit summary mode returns a whitelisted ObservationSummary", observedGreeting.observationSummary?.resultCategory === "understood");
  check("ObservationSummary contains no input, identity or entity values", !/你好|user-1|subject|object|requestId|conversationId/u.test(JSON.stringify(observedGreeting.observationSummary)));
  const contextProbe = await sunland.send({
    conversation: contextConversation,
    identity: identity1,
    messages: [{ role: "user", content: "猫是什么" }],
    semanticContext: contextConversation.semanticContext,
    turnId: "selftest-turn-2",
    canCommitSemanticContext: () => true,
    onDelta: () => {},
  });
  check("SunlandProvider returns a structured semantic Context update", contextProbe.semanticContextUpdate?.kind === "replace");

  const remembered = await sunland.send({ conversation: convoA1, identity: identity1, messages: [{ role: "user", content: "我叫小明" }], onDelta: () => {} });
  check("RememberName still writes through the legacy path", remembered.content.includes("小明") && engineA.memory.recall("name")?.value === "小明");

  await sunland.send({ conversation: convoA1, identity: identity1, messages: [{ role: "user", content: "我的名字是 Alice Chen" }], onDelta: () => {} });
  check("lossless Legacy name extraction preserves internal spaces", engineA.memory.recall("name")?.value === "Alice Chen");

  const recalled = await sunland.send({ conversation: convoA1, identity: identity1, messages: [{ role: "user", content: "你记得我叫什么吗" }], onDelta: () => {} });
  check("explicit RecallName is a read-only Semantic adoption", recalled.content.includes("Alice Chen") && engineA.memory.list().length === 1);

  const nameBeforeCompound = engineA.memory.recall("name")?.value;
  const knowledgeBeforeCompound = engineA.knowledgeStore.all().length;
  await sunland.send({ conversation: convoA1, identity: identity1, messages: [{ role: "user", content: "我叫小明，猫属于动物" }], onDelta: () => {} });
  check("compound side effects do not corrupt Memory or Knowledge", engineA.memory.recall("name")?.value === nameBeforeCompound && engineA.knowledgeStore.all().length === knowledgeBeforeCompound);

  const r1 = await sunland.send({ conversation: convoA1, identity: identity1, messages: [{ role: "user", content: "猫属于哺乳动物" }], onDelta: () => {} });
  check("sunland learns a taught fact and replies about it", r1.content.includes("猫") && r1.content.includes("哺乳动物"));

  await sunland.send({ conversation: convoA1, identity: identity1, messages: [{ role: "user", content: "鸟有翅膀" }], onDelta: () => {} });
  check("complete has-relation teaching stays on the admitted Legacy path", engineA.knowledgeStore.has({ subject: "鸟", relation: "有", object: "翅膀", negated: false }));

  const factsBeforeQuestion = engineA.knowledgeStore.all().length;
  await sunland.send({ conversation: convoA1, identity: identity1, messages: [{ role: "user", content: "猫会飞还是会游泳" }], onDelta: () => {} });
  check("alternative questions never become taught Knowledge", engineA.knowledgeStore.all().length === factsBeforeQuestion);

  // A brand-new conversation object, SAME user -> shared brain sees the fact.
  const convoA2 = { provider: "sunland", userId: "user-1" };
  const r2 = await sunland.send({ conversation: convoA2, identity: identity1, messages: [{ role: "user", content: "猫属于什么" }], onDelta: () => {} });
  check("a second conversation for the same user shares the learned fact", r2.content.includes("哺乳动物"));

  // A different user -> must NOT see user-1's fact.
  const convoB = { provider: "sunland", userId: "user-2" };
  const r3 = await sunland.send({ conversation: convoB, identity: identity2, messages: [{ role: "user", content: "猫属于什么" }], onDelta: () => {} });
  check("a different user's brain is isolated (does not see user-1's fact)", !r3.content.includes("哺乳动物"));

  await sunland.send({ conversation: convoA1, identity: identity1, messages: [{ role: "user", content: "猫不是狗" }], onDelta: () => {} });
  check("passive semantic mode does not persist negated Knowledge", !engineA.knowledgeStore.has({ subject: "猫", relation: "是", object: "狗", negated: true }));
}

// 4. Unknown providers are invalid and never route to DeepSeek.
{
  const registry = createProviderRegistry({ sendRequest: async () => fakeSSEResponse([]) });
  check("unknown provider id is rejected", registry.get(undefined) === null && registry.get("unknown") === null);
  check("list() exposes every registered provider", registry.list().map((p) => p.id).sort().join(",") === "deepseek,sunland");
}

// 5. conversation.js (Stage 3.6): creation, legacy migration, "started" detection.
{
  const fresh = createConversation({ provider: "sunland", model: "frost", userId: "user-1" });
  check("createConversation binds provider at creation time", fresh.provider === "sunland");
  check("createConversation starts with empty history", Array.isArray(fresh.history) && fresh.history.length === 0);
  check("createConversation sets createdAt/updatedAt", typeof fresh.createdAt === "number" && typeof fresh.updatedAt === "number");

  const legacy = { id: 123, title: "旧对话", history: [{ role: "system", content: "x" }], updatedAt: 456 };
  const migrated = migrateLegacyConversation(legacy);
  check("legacy conversation (no provider) defaults to deepseek", migrated.provider === "deepseek");
  check("legacy conversation gets a default model", migrated.model === "deepseek-v4-flash");
  check("legacy conversation keeps its original history untouched", migrated.history === legacy.history);

  const alreadyMigrated = migrateLegacyConversation(migrated);
  check("migrating an already-migrated conversation is a no-op", alreadyMigrated === migrated);

  const list = migrateLegacyConversations([legacy, { ...legacy, id: 124, provider: "sunland" }]);
  check("migrateLegacyConversations only touches the legacy one", list[0].provider === "deepseek" && list[1].provider === "sunland");
  check("migrateLegacyConversations tolerates non-array input", migrateLegacyConversations(null) === null);

  check("hasConversationStarted is false for a fresh conversation", hasConversationStarted(fresh) === false);
  const started = { ...fresh, history: [{ role: "user", content: "hi" }] };
  check("hasConversationStarted is true after the first non-system message", hasConversationStarted(started) === true);
  check("system-only history remains selectable", hasConversationStarted({ ...fresh, history: [{ role: "system", content: "x" }] }) === false);
  check("hasConversationStarted tolerates null/undefined", hasConversationStarted(null) === false && hasConversationStarted(undefined) === false);

  const cloudChangedProvider = {
    ...started,
    provider: "deepseek",
    model: "deepseek-v4-flash",
    title: "云端新标题",
    updatedAt: fresh.updatedAt + 10,
  };
  const merged = mergeConversationRecords(started, cloudChangedProvider);
  check("started conversation keeps its original provider during merge", merged.provider === "sunland");
  check("provider-conflicting model is not imported", merged.model === "frost");
  check("other newer cloud fields still merge", merged.title === "云端新标题");

  let invalidCreateRejected = false;
  try { createConversation({ provider: "unknown" }); } catch { invalidCreateRejected = true; }
  check("unknown provider cannot create a conversation", invalidCreateRejected);
  check("unknown persisted provider is rejected", migrateLegacyConversation({ ...legacy, provider: "unknown" }) === null);
}

console.log(`\n${passed} checks passed.`);
