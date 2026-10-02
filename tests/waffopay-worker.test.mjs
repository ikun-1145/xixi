import assert from "node:assert/strict";
import { createSign, createVerify, generateKeyPairSync } from "node:crypto";
import test from "node:test";

import worker, {
  signApiRequest,
  parseWaffoSignatureHeader,
  normalizeWaffoEvent,
  validateWaffoAmounts,
} from "../workers/waffopay/worker.js";

const PRODUCT_ID = "PROD_4ibh2Jka4tSTmyb35okbRs";
const REFERENCE = "11111111-1111-1111-1111-111111111111";

// Test 隔离后端目标（合成值，非真实项目）：worker 校验 ref/url/schema 后才发请求。
const TEST_PROJECT_REF = "abcdefghij0123456789";
const TEST_SUPABASE_URL = `https://${TEST_PROJECT_REF}.supabase.co`;
const TEST_SUCCESS_ORIGIN = "https://waffopay.example.test";

// 一次性生成合成密钥对（绝非真实凭证）：checkout 签名 + 两套 webhook 环境公钥。
const checkoutKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const prodKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const testKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });

const CHECKOUT_PRIVATE_PEM = checkoutKeys.privateKey.export({ type: "pkcs8", format: "pem" });
const PROD_PUBLIC_PEM = prodKeys.publicKey.export({ type: "spki", format: "pem" });
const TEST_PUBLIC_PEM = testKeys.publicKey.export({ type: "spki", format: "pem" });

// worker 只做 fail-closed 预检；验签与入选测试用户校验仍由 PostgREST/RLS 完成。
// 所有令牌和 fetch 均为合成值/本地 mock。
function base64url(value) {
  return Buffer.from(value, "utf8").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeTestJwt(role, sub = "00000000-0000-0000-0000-000000000001", overrides = {}) {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ role, sub, exp: Math.floor(Date.now() / 1000) + 600, ...overrides }));
  return `${header}.${payload}.${base64url("synthetic-signature")}`;
}

const CHECKOUT_TOKEN = makeTestJwt("authenticated", undefined, { aud: "authenticated" });
// ingest bot 的标准 authenticated 令牌（合成）；数据库按 ingest_principals 白名单授权。
const INGEST_SUB = "00000000-0000-4000-8000-00000000b07b";
const LEDGER_TOKEN = makeTestJwt("authenticated", INGEST_SUB, { aud: "authenticated" });

function createEnv(overrides = {}) {
  const kv = new Map();
  return {
    SUPABASE_ANON_KEY: "anon-key",
    WAFFO_MERCHANT_ID: "MER_test",
    WAFFO_PRIVATE_KEY_TEST: CHECKOUT_PRIVATE_PEM,
    // 默认按已部署形态：环境=prod 用于 webhook 生产分支测试；checkout 走 test（见 createTestEnv）。
    WAFFO_ENVIRONMENT: "prod",
    WAFFO_STORE_ID: "STO_x",
    WAFFO_PRODUCT_ID: PRODUCT_ID,
    WAFFO_CURRENCY: "CNY",
    WAFFO_ALLOWED_ORIGINS: "https://sunland.dev",
    WAFFO_WEBHOOK_PUBLIC_KEY_PROD: PROD_PUBLIC_PEM,
    WAFFO_WEBHOOK_PUBLIC_KEY_TEST: TEST_PUBLIC_PEM,
    WAFFO_PRODUCTION_ENTITLEMENT_ENABLED: "false",
    // Test 隔离后端配置（复用现有 Supabase 的 waffo_test schema + authenticated checkout / test-only ingest）。
    WAFFO_TEST_BACKEND: "schema",
    WAFFO_TEST_SCHEMA: "waffo_test",
    WAFFO_TEST_PROJECT_REF: TEST_PROJECT_REF,
    WAFFO_TEST_SUPABASE_URL: TEST_SUPABASE_URL,
    WAFFO_TEST_SUCCESS_ORIGIN: TEST_SUCCESS_ORIGIN,
    WAFFO_TEST_INGEST_EMAIL: "ingest@waffo-test.invalid",
    WAFFO_TEST_INGEST_PASSWORD: "synthetic-password",
    WAFFO_TEST_INGEST_SUB: INGEST_SUB,
    WAFFO_EVENTS: {
      async get(key) {
        return kv.has(key) ? kv.get(key) : null;
      },
      async put(key, value) {
        kv.set(key, value);
      },
    },
    __kv: kv,
    ...overrides,
  };
}

// checkout 现为 test-only：环境必须为 test，且完整 test 后端配置齐全。
function createTestEnv(overrides = {}) {
  return createEnv({ WAFFO_ENVIRONMENT: "test", ...overrides });
}

function signWebhook(privateKey, timestamp, rawBody) {
  const signer = createSign("RSA-SHA256");
  signer.update(`${timestamp}.${rawBody}`);
  signer.end();
  return signer.sign(privateKey, "base64");
}

function completedEnvelope({ data = {}, ...top } = {}) {
  return {
    id: "evt_delivery_1",
    timestamp: Date.now(),
    eventType: "order.completed",
    eventId: "PAY_abc123",
    storeId: "STO_x",
    mode: "prod",
    data: {
      orderId: "ORD_x",
      orderStatus: "completed",
      currency: "CNY",
      chargedAmount: "15.00",
      listPrice: { total: "15.00", subtotal: "15.00", taxAmount: "0.00" },
      productId: PRODUCT_ID,
      productName: "Sunland Pro",
      paymentId: "PAY_abc123",
      paymentStatus: "succeeded",
      paymentDate: Date.now(),
      orderMerchantExternalId: REFERENCE,
      ...data,
    },
    ...top,
  };
}

function webhookRequest(envelope, { privateKey = prodKeys.privateKey, timestamp = Date.now(), rawBodyOverride = null, header = null } = {}) {
  const rawBody = rawBodyOverride ?? JSON.stringify(envelope);
  const sign = signWebhook(privateKey, timestamp, rawBody);
  const headers = { "content-type": "application/json" };
  if (header !== null) {
    if (header) headers["X-Waffo-Signature"] = header;
  } else {
    headers["X-Waffo-Signature"] = `t=${timestamp},v1=${sign}`;
  }
  return new Request("https://waffopay.example.test/webhook/waffo", {
    method: "POST",
    headers,
    body: rawBody,
  });
}

// test-mode webhook 在验证通过后会向隔离 ledger RPC 落账，必须显式 mock 其返回。
function ledgerMock(recorded = []) {
  return async (input, init) => {
    if (String(input).includes("/auth/v1/token")) {
      return Response.json({ access_token: LEDGER_TOKEN, token_type: "bearer", expires_in: 600, refresh_token: "synthetic-refresh" });
    }
    if (String(input).includes("/rpc/record_event")) {
      recorded.push(JSON.parse(init.body));
      return Response.json([{ result: "recorded" }]);
    }
    if (String(input).includes("/rpc/get_or_create_intent")) {
      return Response.json([{ payment_reference: REFERENCE, status: "pending" }]);
    }
    // 生产开通 RPC 绝不应被调用；命中即让测试失败。
    if (String(input).includes("/rpc/sunland_activate_pro_from_payment")) {
      throw new Error("entitlement RPC must never be called");
    }
    return Response.json({});
  };
}

function findRpc(requests, name) {
  return requests.find(({ input }) => input.includes(`/rpc/${name}`));
}

// ---------------------------------------------------------------- Checkout

test("checkout rejects an unauthenticated caller and never calls Waffo", async () => {
  const originalFetch = globalThis.fetch;
  let waffoCalled = false;
  globalThis.fetch = async input => {
    if (String(input).includes("waffo")) waffoCalled = true;
    return Response.json({});
  };
  try {
    const response = await worker.fetch(
      new Request("https://waffopay.example.test/checkout/waffo", { method: "POST", body: "{}" }),
      createTestEnv(),
    );
    assert.equal(response.status, 401);
    assert.equal(waffoCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("checkout rejects the ingest bot token before any backend call", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return Response.json({}); };
  try {
    // ingest bot 不能调用 checkout。
    const response = await worker.fetch(
      new Request("https://waffopay.example.test/checkout/waffo", {
        method: "POST",
        headers: { Authorization: `Bearer ${LEDGER_TOKEN}` },
        body: "{}",
      }),
      createTestEnv(),
    );
    assert.equal(response.status, 401);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

for (const [name, claims] of Object.entries({
  "legacy checkout role": { role: "waffo_test_checkout" },
  "anon role": { role: "anon" },
  "service role": { role: "service_role" },
  "missing audience": { aud: undefined },
  "wrong audience": { aud: "waffo_test_checkout" },
  "array audience": { aud: ["authenticated"] },
  "missing subject": { sub: undefined },
  "malformed subject": { sub: "not-a-uuid" },
  "array subject": { sub: ["00000000-0000-0000-0000-000000000001"] },
  "missing expiry": { exp: undefined },
  "expired token": { exp: 1 },
  "string expiry": { exp: "9999999999" },
  "fractional expiry": { exp: 9999999999.5 },
  "unsafe expiry": { exp: Number.MAX_SAFE_INTEGER + 1 },
  "future not-before": { nbf: 9999999999 },
})) {
  test(`checkout rejects ${name} before any backend call`, async () => {
    let calls = 0;
    await withFetch(async () => { calls += 1; return Response.json({}); }, async () => {
      const token = makeTestJwt("authenticated", undefined, { aud: "authenticated", ...claims });
      const response = await worker.fetch(checkoutRequest({}, { Authorization: `Bearer ${token}` }), createTestEnv());
      assert.equal(response.status, 401);
      assert.equal(calls, 0);
    });
  });
}

test("checkout accepts standard authenticated claims with a configurable session lifetime", async () => {
  const token = makeTestJwt("authenticated", undefined, {
    aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 7200,
  });
  const requests = [];
  await withFetch(async (input, init) => {
    requests.push({ input: String(input), init });
    return Response.json(String(input).includes("/rpc/") ? goodIntent : goodSession);
  }, async () => {
    assert.equal((await worker.fetch(checkoutRequest({}, { Authorization: `Bearer ${token}` }), createTestEnv())).status, 200);
    assert.equal(findRpc(requests, "get_or_create_intent").init.headers.Authorization, `Bearer ${token}`);
  });
});

for (const status of [401, 403]) {
  test(`checkout requires PostgREST authentication and RLS approval (${status})`, async () => {
    const requests = [];
    await withFetch(async input => {
      requests.push(String(input));
      return new Response(null, { status });
    }, async () => {
      assert.equal((await worker.fetch(checkoutRequest(), createTestEnv())).status, 401);
      assert.equal(requests.length, 1);
      assert.equal(requests[0], `${TEST_SUPABASE_URL}/rest/v1/rpc/get_or_create_intent`);
    });
  });
}

test("checkout creates a Waffo session with the server-generated reference as orderMerchantExternalId", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init) => {
    const request = { input: String(input), init };
    requests.push(request);
    if (request.input.includes("/rpc/get_or_create_intent")) {
      return Response.json([{ payment_reference: REFERENCE, status: "pending" }]);
    }
    if (request.input.includes("/checkout/create-session")) {
      return Response.json({ data: { checkoutUrl: "https://pancake.waffo.ai/store/s/checkout/sess_1" } });
    }
    return Response.json({});
  };
  try {
    const response = await worker.fetch(
      new Request("https://waffopay.example.test/checkout/waffo", {
        method: "POST",
        headers: { Authorization: `Bearer ${CHECKOUT_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ language: "zh" }),
      }),
      createTestEnv(),
    );
    assert.equal(response.status, 200);
    assert.match((await response.json()).checkoutUrl, /^https:\/\//);

    // intent RPC 走 waffo_test schema，携带用户令牌与 Content-Profile。
    const intentRequest = requests.find(r => r.input.includes("/rpc/get_or_create_intent"));
    assert.ok(intentRequest, "expected an isolated intent RPC call");
    assert.match(intentRequest.input, /abcdefghij0123456789\.supabase\.co/);
    assert.equal(intentRequest.init.headers["Content-Profile"], "waffo_test");
    assert.equal(intentRequest.init.headers.Authorization, `Bearer ${CHECKOUT_TOKEN}`);

    const waffoRequest = requests.find(r => r.input.includes("/checkout/create-session"));
    assert.ok(waffoRequest, "expected a Waffo checkout call");
    const body = JSON.parse(waffoRequest.init.body);
    assert.equal(body.orderMerchantExternalId, REFERENCE);
    assert.equal(body.metadata.payment_reference, REFERENCE);
    assert.equal(body.productId, PRODUCT_ID);
    assert.equal(body.currency, "CNY");
    assert.equal(body.successUrl, "https://waffopay.example.test/test/done");
    // 服务端 API Key 签名头必须存在，且绝不出现在前端可见处。
    assert.ok(waffoRequest.init.headers["X-Signature"]);
    assert.ok(waffoRequest.init.headers["X-Merchant-Id"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("checkout fails closed when the isolated intent is not pending", async () => {
  const originalFetch = globalThis.fetch;
  let waffoCalled = false;
  globalThis.fetch = async input => {
    if (String(input).includes("/rpc/get_or_create_intent")) {
      return Response.json([{ payment_reference: REFERENCE, status: "activated" }]);
    }
    if (String(input).includes("/checkout/create-session")) waffoCalled = true;
    return Response.json({});
  };
  try {
    const response = await worker.fetch(
      new Request("https://waffopay.example.test/checkout/waffo", {
        method: "POST",
        headers: { Authorization: `Bearer ${CHECKOUT_TOKEN}` },
        body: "{}",
      }),
      createTestEnv(),
    );
    // Test intent 受 schema 约束只能 pending；异常状态一律 fail-closed，不发起结账。
    assert.equal(response.status, 502);
    assert.equal(waffoCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("checkout maps an unauthorized intent RPC to 401", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    if (String(input).includes("/rpc/")) return new Response("no", { status: 401 });
    return Response.json();
  };
  try {
    const response = await worker.fetch(
      new Request("https://waffopay.example.test/checkout/waffo", {
        method: "POST",
        headers: { Authorization: `Bearer ${CHECKOUT_TOKEN}` },
        body: "{}",
      }),
      createTestEnv(),
    );
    assert.equal(response.status, 401);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a Waffo API failure surfaces as 502 and never as a paid success", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    if (String(input).includes("/rpc/get_or_create_intent")) {
      return Response.json([{ payment_reference: REFERENCE, status: "pending" }]);
    }
    if (String(input).includes("/checkout/create-session")) {
      return new Response("upstream down", { status: 500 });
    }
    return Response.json({});
  };
  try {
    const response = await worker.fetch(
      new Request("https://waffopay.example.test/checkout/waffo", {
        method: "POST",
        headers: { Authorization: `Bearer ${CHECKOUT_TOKEN}` },
        body: "{}",
      }),
      createTestEnv(),
    );
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.alreadyActivated, undefined);
    assert.equal(body.checkoutUrl, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ----------------------------------------------------------------- Webhook

test("webhook rejects a missing signature header", async () => {
  const response = await worker.fetch(
    webhookRequest(completedEnvelope(), { header: "" }),
    createEnv(),
  );
  assert.equal(response.status, 401);
});

test("webhook rejects a tampered body under a valid-looking signature", async () => {
  const timestamp = Date.now();
  const envelope = completedEnvelope();
  const raw = JSON.stringify(envelope);
  const sign = signWebhook(prodKeys.privateKey, timestamp, raw);
  // 篡改 body 但沿用原签名头 → 验签必失败。
  const tampered = raw.replace("15.00", "9999.00");
  const request = new Request("https://waffopay.example.test/webhook/waffo", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Waffo-Signature": `t=${timestamp},v1=${sign}` },
    body: tampered,
  });
  const response = await worker.fetch(request, createEnv());
  assert.equal(response.status, 401);
});

test("webhook rejects a timestamp outside the 45-minute tolerance", async () => {
  const stale = Date.now() - 46 * 60 * 1000;
  const response = await worker.fetch(
    webhookRequest(completedEnvelope(), { timestamp: stale }),
    createEnv(),
  );
  assert.equal(response.status, 401);
});

test("even prod key + production flag cannot grant Pro before the verification contract is approved", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ input: String(input), init });
    return Response.json({ status: "activated" });
  };
  try {
    const env = createEnv({ WAFFO_PRODUCTION_ENTITLEMENT_ENABLED: "true" });
    const response = await worker.fetch(webhookRequest(completedEnvelope()), env);
    assert.equal(response.status, 503);
    assert.equal(findRpc(requests, "sunland_activate_pro_from_payment"), undefined);
    assert.equal(requests.length, 0);
    assert.equal(env.__kv.size, 0, "unapproved entitlement must not be marked handled");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a verified test-mode webhook records an isolated observation and never grants Pro", async () => {
  const recorded = [];
  await withFetch(ledgerMock(recorded), async () => {
    const env = createTestEnv();
    const response = await worker.fetch(
      webhookRequest(completedEnvelope({ mode: "test" }), { privateKey: testKeys.privateKey }),
      env,
    );
    assert.equal(response.status, 200);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].p_mode, "test");
    assert.equal(recorded[0].p_observation_code, "valid_observation");
  });
});

// 每个用例用独立 bot 邮箱，避免模块级 token 缓存在用例间串扰。
function ingestEnv(email, overrides = {}) {
  return createTestEnv({ WAFFO_TEST_INGEST_EMAIL: email, ...overrides });
}

function testDelivery(id) {
  return webhookRequest(completedEnvelope({ mode: "test", id: `evt_${id}` }), { privateKey: testKeys.privateKey });
}

test("test ledger uses the ingest bot token, caches it, and never stores the refresh token", async () => {
  const requests = [];
  const mock = ledgerMock();
  await withFetch(async (input, init) => { requests.push({ input: String(input), init }); return mock(input, init); }, async () => {
    const env = ingestEnv("cache@waffo-test.invalid");
    const [first, second] = await Promise.all([worker.fetch(testDelivery("c1"), env), worker.fetch(testDelivery("c2"), env)]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal((await worker.fetch(testDelivery("c3"), env)).status, 200);
    const grants = requests.filter(({ input }) => input.includes("/auth/v1/token"));
    assert.equal(grants.length, 1, "concurrent and later deliveries share one password grant");
    assert.equal(grants[0].input, `${TEST_SUPABASE_URL}/auth/v1/token?grant_type=password`);
    assert.equal(grants[0].init.headers.apikey, "anon-key");
    assert.deepEqual(JSON.parse(grants[0].init.body), { email: "cache@waffo-test.invalid", password: "synthetic-password" });
    const rpcs = requests.filter(({ input }) => input.includes("/rpc/record_event"));
    assert.equal(rpcs.length, 3);
    for (const { init } of rpcs) {
      assert.equal(init.headers.Authorization, `Bearer ${LEDGER_TOKEN}`);
      assert.equal(init.headers["Content-Profile"], "waffo_test");
    }
    assert.equal(JSON.stringify(requests).includes("synthetic-refresh"), false);
    assert.equal(findRpc(requests, "sunland_activate_pro_from_payment"), undefined);
  });
});

for (const [name, grant] of Object.entries({
  "rejected password grant": () => Response.json({ error: "invalid_grant" }, { status: 400 }),
  "token for a different subject": () => Response.json({ access_token: makeTestJwt("authenticated", REFERENCE, { aud: "authenticated" }) }),
  "non-authenticated token": () => Response.json({ access_token: makeTestJwt("service_role", INGEST_SUB) }),
  "expired token": () => Response.json({ access_token: makeTestJwt("authenticated", INGEST_SUB, { aud: "authenticated", exp: 1 }) }),
  "missing token": () => Response.json({}),
})) {
  test(`test ledger fails closed on ${name} without calling record_event`, async () => {
    let rpc = 0;
    await withFetch(async input => {
      if (String(input).includes("/auth/v1/token")) return grant();
      rpc += 1;
      return Response.json([{ result: "recorded" }]);
    }, async () => {
      const env = ingestEnv(`fail-${name.replace(/\W+/g, "-")}@waffo-test.invalid`);
      assert.equal((await worker.fetch(testDelivery("f1"), env)).status, 503);
      assert.equal(rpc, 0);
    });
  });
}

for (const [name, overrides] of Object.entries({
  "missing bot email": { WAFFO_TEST_INGEST_EMAIL: "" },
  "missing bot password": { WAFFO_TEST_INGEST_PASSWORD: undefined },
  "missing bot subject": { WAFFO_TEST_INGEST_SUB: "" },
  "malformed bot subject": { WAFFO_TEST_INGEST_SUB: "not-a-uuid" },
})) {
  test(`test ledger with ${name} returns 503 before any backend call`, async () => {
    let calls = 0;
    await withFetch(async () => { calls += 1; return Response.json([{ result: "recorded" }]); }, async () => {
      assert.equal((await worker.fetch(testDelivery("m1"), createTestEnv(overrides))).status, 503);
      assert.equal(calls, 0);
    });
  });
}

test("a rejected ingest token is dropped so the Waffo retry re-authenticates", async () => {
  let grants = 0;
  let rpcStatus = 401;
  await withFetch(async (input, init) => {
    if (String(input).includes("/auth/v1/token")) grants += 1;
    if (String(input).includes("/rpc/record_event")) {
      return rpcStatus === 200 ? Response.json([{ result: "recorded" }]) : Response.json({ code: "PGRST303" }, { status: rpcStatus });
    }
    return ledgerMock()(input, init);
  }, async () => {
    const env = ingestEnv("retry@waffo-test.invalid");
    assert.equal((await worker.fetch(testDelivery("r1"), env)).status, 503);
    rpcStatus = 403;
    assert.equal((await worker.fetch(testDelivery("r1"), env)).status, 503);
    assert.equal(grants, 2, "401 drops the cached token");
    assert.equal((await worker.fetch(testDelivery("r1"), env)).status, 503);
    assert.equal(grants, 2, "403 (bot not enrolled) does not mint a new session per retry");
    rpcStatus = 200;
    assert.equal((await worker.fetch(testDelivery("r1"), env)).status, 200);
  });
});

test("an unsigned or forged test webhook never triggers the ingest password grant", async () => {
  let calls = 0;
  await withFetch(async () => { calls += 1; return Response.json({}); }, async () => {
    const env = ingestEnv("unsigned@waffo-test.invalid");
    const forged = webhookRequest(completedEnvelope({ mode: "test" }), { privateKey: prodKeys.privateKey });
    assert.equal((await worker.fetch(forged, env)).status, 401);
    const unsigned = webhookRequest(completedEnvelope({ mode: "test" }), { header: "" });
    assert.equal((await worker.fetch(unsigned, env)).status, 401);
    assert.equal(calls, 0);
  });
});

test("test mode remains isolated when production entitlement is enabled", async () => {
  const recorded = [];
  await withFetch(ledgerMock(recorded), async () => {
    const env = createTestEnv({ WAFFO_PRODUCTION_ENTITLEMENT_ENABLED: "true" });
    const response = await worker.fetch(
      webhookRequest(completedEnvelope({ mode: "test" }), { privateKey: testKeys.privateKey }), env);
    assert.equal(response.status, 200);
    assert.equal(recorded.length, 1);
  });
});

test("a verified prod webhook with the production flag OFF does not grant Pro", async () => {
  const originalFetch = globalThis.fetch;
  let rpcCalled = false;
  globalThis.fetch = async input => {
    if (String(input).includes("/rpc/sunland_activate_pro_from_payment")) rpcCalled = true;
    return Response.json({ status: "activated" });
  };
  try {
    const response = await worker.fetch(webhookRequest(completedEnvelope()), createEnv());
    assert.equal(response.status, 200);
    assert.equal(rpcCalled, false); // 默认开关 false
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a duplicate delivery id is deduplicated within the same environment and event type", async () => {
  const originalFetch = globalThis.fetch;
  let rpcCalls = 0;
  globalThis.fetch = async input => {
    if (String(input).includes("/rpc/sunland_activate_pro_from_payment")) rpcCalls += 1;
    return Response.json({ status: "activated" });
  };
  try {
    const env = createEnv();
    const first = await worker.fetch(webhookRequest(completedEnvelope()), env);
    const second = await worker.fetch(webhookRequest(completedEnvelope()), env);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(rpcCalls, 0);
    assert.equal(env.__kv.size, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an unknown event type is acknowledged without any business action", async () => {
  const originalFetch = globalThis.fetch;
  let rpcCalled = false;
  globalThis.fetch = async input => {
    if (String(input).includes("/rpc/")) rpcCalled = true;
    return Response.json({});
  };
  try {
    const env = createEnv({ WAFFO_PRODUCTION_ENTITLEMENT_ENABLED: "true" });
    const response = await worker.fetch(
      webhookRequest(completedEnvelope({ eventType: "subscription.renewed" })),
      env,
    );
    assert.equal(response.status, 200);
    assert.equal(rpcCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a currency mismatch is recorded but never grants Pro", async () => {
  const originalFetch = globalThis.fetch;
  let rpcCalled = false;
  globalThis.fetch = async input => {
    if (String(input).includes("/rpc/sunland_activate_pro_from_payment")) rpcCalled = true;
    return Response.json({ status: "activated" });
  };
  try {
    const env = createEnv();
    const response = await worker.fetch(
      webhookRequest(completedEnvelope({ data: { currency: "USD" } })),
      env,
    );
    assert.equal(response.status, 200);
    assert.equal(rpcCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a completed order missing the trusted reference is not activated", async () => {
  const originalFetch = globalThis.fetch;
  let rpcCalled = false;
  globalThis.fetch = async input => {
    if (String(input).includes("/rpc/sunland_activate_pro_from_payment")) rpcCalled = true;
    return Response.json({ status: "activated" });
  };
  try {
    const env = createEnv();
    const response = await worker.fetch(
      webhookRequest(completedEnvelope({ data: { orderMerchantExternalId: "" } })),
      env,
    );
    assert.equal(response.status, 200);
    assert.equal(rpcCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a refund.succeeded event is recorded and never revokes Pro this round", async () => {
  const originalFetch = globalThis.fetch;
  let rpcCalled = false;
  globalThis.fetch = async input => {
    if (String(input).includes("/rpc/")) rpcCalled = true;
    return Response.json({});
  };
  try {
    const env = createEnv({ WAFFO_PRODUCTION_ENTITLEMENT_ENABLED: "true" });
    const envelope = completedEnvelope({
      eventType: "refund.succeeded",
      eventId: "REF_1",
      data: { refundId: "REF_1" },
    });
    const response = await worker.fetch(webhookRequest(envelope), env);
    assert.equal(response.status, 200);
    assert.equal(rpcCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a malformed JSON body under a valid signature returns 400", async () => {
  const timestamp = Date.now();
  const raw = "not-json{";
  const sign = signWebhook(prodKeys.privateKey, timestamp, raw);
  const request = new Request("https://waffopay.example.test/webhook/waffo", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Waffo-Signature": `t=${timestamp},v1=${sign}` },
    body: raw,
  });
  const response = await worker.fetch(request, createEnv());
  assert.equal(response.status, 400);
});

test("an unapproved production entitlement returns 503 for retry and performs no downstream write", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    if (String(input).includes("/rpc/sunland_activate_pro_from_payment")) {
      return new Response("db down", { status: 500 });
    }
    return Response.json();
  };
  try {
    const env = createEnv({ WAFFO_PRODUCTION_ENTITLEMENT_ENABLED: "true" });
    const response = await worker.fetch(webhookRequest(completedEnvelope()), env);
    assert.equal(response.status, 503);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("webhook rejects non-POST methods", async () => {
  const response = await worker.fetch(
    new Request("https://waffopay.example.test/webhook/waffo", { method: "GET" }),
    createEnv(),
  );
  assert.equal(response.status, 405);
});

// -------------------------------------------------------------- Unit-level

test("signApiRequest signs the canonical METHOD\\nPATH\\nTS\\nSHA256(body) string", async () => {
  const timestamp = "1700000000000";
  const body = JSON.stringify({ productId: PRODUCT_ID });
  const signatureB64 = await signApiRequest(
    CHECKOUT_PRIVATE_PEM,
    "POST",
    "/v1/actions/checkout/create-session",
    timestamp,
    body,
  );
  const { createHash } = await import("node:crypto");
  const digest = createHash("sha256").update(body).digest("base64");
  const canonical = ["POST", "/v1/actions/checkout/create-session", timestamp, digest].join("\n");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(canonical);
  verifier.end();
  assert.equal(
    verifier.verify(checkoutKeys.publicKey, Buffer.from(signatureB64, "base64")),
    true,
  );
});

test("parseWaffoSignatureHeader extracts t and v1 and rejects malformed headers", () => {
  assert.deepEqual(parseWaffoSignatureHeader("t=1700000000000,v1=YWJj"), { t: "1700000000000", v1: "YWJj" });
  assert.deepEqual(parseWaffoSignatureHeader("v1=YWJj,t=1700000000000,extra=x"), { t: "1700000000000", v1: "YWJj" });
  assert.equal(parseWaffoSignatureHeader("t=abc,v1=x"), null);
  assert.equal(parseWaffoSignatureHeader("garbage"), null);
  assert.equal(parseWaffoSignatureHeader(""), null);
});

test("normalizeWaffoEvent never treats deprecated amount as proof of an actual charge", () => {
  const withCharged = normalizeWaffoEvent(completedEnvelope({ data: { chargedAmount: "15.00", amount: "12.00" } }));
  assert.equal(withCharged.order.chargedAmount, "15.00");
  const withoutCharged = normalizeWaffoEvent(completedEnvelope({ data: { chargedAmount: undefined, amount: "12.00" } }));
  assert.equal(withoutCharged.order.chargedAmount, null);
  assert.equal(withCharged.deliveryId, "evt_delivery_1");
  assert.equal(withCharged.order.reference, REFERENCE);
});

// 独立审计回归：官方 API 时间戳为秒，Webhook 时间戳才是毫秒。
test("checkout signs a seconds timestamp and includes a per-operation idempotency key", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("/rpc/")) return Response.json({ payment_reference: REFERENCE, status: "pending" });
    calls.push(init);
    return Response.json({ data: { checkoutUrl: "https://checkout.waffo.ai/store/checkout/session" } });
  };
  try {
    await worker.fetch(new Request("https://waffopay.example.test/checkout/waffo", {
      method: "POST", headers: { Authorization: `Bearer ${CHECKOUT_TOKEN}`, Origin: "https://sunland.dev" }, body: "{}",
    }), createTestEnv());
    assert.ok(calls.length);
    assert.ok(Math.abs(Number(calls[0].headers["X-Timestamp"]) - Math.floor(Date.now() / 1000)) < 2);
    assert.match(calls[0].headers["X-Idempotency-Key"], /^MER_test-[0-9a-f-]{36}$/);
  } finally { globalThis.fetch = originalFetch; }
});

test("duplicate signature fields and excessive future timestamps are rejected", async () => {
  assert.equal(parseWaffoSignatureHeader("t=123,t=456,v1=YWJj"), null);
  assert.equal(parseWaffoSignatureHeader("t=123,v1=YWJj,v1=YWJj"), null);
  const response = await worker.fetch(webhookRequest(completedEnvelope(), { timestamp: Date.now() + 2 * 60 * 1000 }), createEnv());
  assert.equal(response.status, 401);
});

test("a disallowed Origin cannot trigger checkout side effects", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return Response.json({}); };
  try {
    const response = await worker.fetch(new Request("https://waffopay.example.test/checkout/waffo", {
      method: "POST", headers: { Origin: "https://attacker.example", Authorization: `Bearer ${CHECKOUT_TOKEN}` }, body: "{}",
    }), createTestEnv());
    assert.equal(response.status, 403);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

function checkoutRequest(body = {}, headers = {}) {
  return new Request("https://waffopay.example.test/checkout/waffo", {
    method: "POST",
    headers: { Authorization: `Bearer ${CHECKOUT_TOKEN}`, Origin: "https://sunland.dev", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function withFetch(mock, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;
  try { return await run(); } finally { globalThis.fetch = originalFetch; }
}

const goodSession = { data: { checkoutUrl: "https://checkout.waffo.ai/store/checkout/cs_test" } };
const goodIntent = { payment_reference: REFERENCE, status: "pending" };

test("checkout ignores all caller-supplied business fields and forwards only the caller token to intent RPC", async () => {
  const requests = [];
  await withFetch(async (input, init) => {
    requests.push({ input: String(input), init });
    return Response.json(String(input).includes("/rpc/") ? goodIntent : goodSession);
  }, async () => {
    const response = await worker.fetch(checkoutRequest({
      user_id: "attacker", payment_reference: "attacker", productId: "PROD_wrong", currency: "USD",
      amount: "0.01", priceSnapshot: { amount: "0.01" }, successUrl: "https://attacker.example",
      originOrderId: "ORD_other", language: "zh-Hant", darkMode: true,
    }), createTestEnv());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://sunland.dev");
    const intentRequest = requests.find(r => r.input.includes("/rpc/"));
    assert.equal(intentRequest.init.headers.Authorization, `Bearer ${CHECKOUT_TOKEN}`);
    assert.equal(intentRequest.init.body, "{}");
    const apiRequest = requests.find(r => r.input.includes("create-session"));
    const body = JSON.parse(apiRequest.init.body);
    assert.equal(body.productId, PRODUCT_ID);
    assert.equal(body.currency, "CNY");
    assert.equal(body.orderMerchantExternalId, REFERENCE);
    assert.equal(body.successUrl, "https://waffopay.example.test/test/done");
    assert.equal(body.language, "zh-Hant-TW");
    assert.equal(body.user_id, undefined);
    assert.equal(body.amount, undefined);
    assert.equal(body.priceSnapshot, undefined);
    assert.equal(body.originOrderId, undefined);
    assert.equal(apiRequest.init.headers["X-Environment"], undefined, "API environment comes from its key");
    assert.equal(apiRequest.init.redirect, "manual");
  });
});

for (const [name, override] of Object.entries({
  "missing mode": { WAFFO_ENVIRONMENT: undefined },
  "invalid mode": { WAFFO_ENVIRONMENT: "live" },
  "missing store": { WAFFO_STORE_ID: "" },
  "invalid product": { WAFFO_PRODUCT_ID: "PROD_other" },
  "invalid currency": { WAFFO_CURRENCY: "USD" },
  "missing test key": { WAFFO_PRIVATE_KEY_TEST: undefined },
  "missing test backend ref": { WAFFO_TEST_PROJECT_REF: "" },
  "test backend url mismatch": { WAFFO_TEST_SUPABASE_URL: "https://evil.supabase.co" },
})) {
  test(`checkout fails closed for ${name} without network calls`, async () => {
    let calls = 0;
    await withFetch(async () => { calls += 1; return Response.json({}); }, async () => {
      const response = await worker.fetch(checkoutRequest(), createTestEnv(override));
      assert.equal(response.status, 503);
      assert.equal(calls, 0);
    });
  });
}

for (const body of ["{", "null", "[]", '"text"']) {
  test(`checkout rejects invalid JSON structure ${body}`, async () => {
    let calls = 0;
    await withFetch(async () => { calls += 1; return Response.json({}); }, async () => {
      assert.equal((await worker.fetch(checkoutRequest(body), createTestEnv())).status, 400);
      assert.equal(calls, 0);
    });
  });
}

test("CORS preflight permits exact known origin and rejects an unrelated origin", async () => {
  for (const [origin, expected] of [["https://sunland.dev", 204], ["https://sunland.dev.attacker.example", 403], ["null", 403]]) {
    const response = await worker.fetch(new Request("https://waffopay.example.test/checkout/waffo", {
      method: "OPTIONS", headers: { Origin: origin },
    }), createTestEnv());
    assert.equal(response.status, expected);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), expected === 204 ? origin : null);
  }
});

test("intent service failure is 503, distinct from authentication rejection", async () => {
  await withFetch(async () => new Response("down", { status: 500 }), async () => {
    assert.equal((await worker.fetch(checkoutRequest(), createTestEnv())).status, 503);
  });
});

for (const [name, session] of Object.entries({
  "API errors beside data": { ...goodSession, errors: [{ message: "rejected", layer: "gateway" }] },
  "malformed errors": { ...goodSession, errors: "invalid" },
  "untrusted redirect": { data: { checkoutUrl: "https://attacker.example/pay" } },
  "credentials in URL": { data: { checkoutUrl: "https://user:pass@checkout.waffo.ai/pay" } },
  "HTTP redirect": { data: { checkoutUrl: "http://checkout.waffo.ai/pay" } },
  "nonofficial response shape": { checkoutUrl: goodSession.data.checkoutUrl },
})) {
  test(`checkout rejects ${name}`, async () => {
    await withFetch(async input => Response.json(String(input).includes("/rpc/") ? goodIntent : session), async () => {
      const response = await worker.fetch(checkoutRequest(), createTestEnv());
      assert.equal(response.status, 502);
      assert.equal((await response.json()).checkoutUrl, undefined);
    });
  });
}

test("two independent checkout operations get different idempotency keys", async () => {
  const keys = [];
  await withFetch(async (input, init) => {
    if (String(input).includes("/rpc/")) return Response.json(goodIntent);
    keys.push(init.headers["X-Idempotency-Key"]);
    return Response.json(goodSession);
  }, async () => {
    await worker.fetch(checkoutRequest(), createTestEnv());
    await worker.fetch(checkoutRequest(), createTestEnv());
    assert.equal(new Set(keys).size, 2, "identical purchases must not share a cached expired session");
  });
});

for (const status of [400, 401, 409, 429, 500]) {
  test(`Waffo API HTTP ${status} never retries a write or reports payment success`, async () => {
    let writes = 0;
    await withFetch(async input => {
      if (String(input).includes("/rpc/")) return Response.json(goodIntent);
      writes += 1;
      return new Response("failure", { status });
    }, async () => {
      assert.equal((await worker.fetch(checkoutRequest(), createTestEnv())).status, 502);
      assert.equal(writes, 1);
    });
  });
}

test("checkout response-body timeout aborts and fails closed after headers arrived", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let aborted = false;
  globalThis.setTimeout = callback => { queueMicrotask(callback); return 1; };
  globalThis.clearTimeout = () => {};
  try {
    await withFetch(async (input, init) => {
      if (String(input).includes("/rpc/")) return Response.json(goodIntent);
      return new Response(new ReadableStream({
        start(controller) {
          init.signal.addEventListener("abort", () => {
            aborted = true;
            controller.error(new DOMException("aborted", "AbortError"));
          });
        },
      }));
    }, async () => {
      assert.equal((await worker.fetch(checkoutRequest(), createTestEnv())).status, 502);
      assert.equal(aborted, true);
    });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("raw webhook whitespace and key ordering are verified without reserialization", async () => {
  const envelope = completedEnvelope();
  const raw = JSON.stringify(envelope, null, 2) + "\n";
  const response = await worker.fetch(webhookRequest(envelope, { rawBodyOverride: raw }), createEnv());
  assert.equal(response.status, 200);
});

for (const [name, envelope, env, key, expected] of [
  ["different store", completedEnvelope({ storeId: "STO_other" }), {}, prodKeys.privateKey, 400],
  ["missing mode", completedEnvelope({ mode: undefined }), {}, prodKeys.privateKey, 400],
  ["prod key with test mode", completedEnvelope({ mode: "test" }), {}, prodKeys.privateKey, 400],
  ["test key with forged prod mode", completedEnvelope(), { WAFFO_ENVIRONMENT: "test" }, testKeys.privateKey, 400],
  ["test signature at prod endpoint", completedEnvelope(), {}, testKeys.privateKey, 401],
  ["prod signature at test endpoint", completedEnvelope({ mode: "test" }), { WAFFO_ENVIRONMENT: "test" }, prodKeys.privateKey, 401],
  ["missing configured store", completedEnvelope(), { WAFFO_STORE_ID: "" }, prodKeys.privateKey, 503],
  ["missing prod key", completedEnvelope(), { WAFFO_WEBHOOK_PUBLIC_KEY_PROD: undefined }, prodKeys.privateKey, 401],
  ["same key assigned to test and prod", completedEnvelope(), { WAFFO_WEBHOOK_PUBLIC_KEY_PROD: TEST_PUBLIC_PEM }, testKeys.privateKey, 401],
  ["missing event id", completedEnvelope({ eventId: undefined }), {}, prodKeys.privateKey, 400],
  ["missing delivery id", completedEnvelope({ id: undefined }), {}, prodKeys.privateKey, 400],
]) {
  test(`webhook rejects ${name} without a downstream action`, async () => {
    let calls = 0;
    await withFetch(async () => { calls += 1; return Response.json({}); }, async () => {
      const configured = createEnv({ WAFFO_PRODUCTION_ENTITLEMENT_ENABLED: "true", ...env });
      assert.equal((await worker.fetch(webhookRequest(envelope, { privateKey: key }), configured)).status, expected);
      assert.equal(calls, 0);
      assert.equal(configured.__kv.size, 0);
    });
  });
}

for (const [name, data] of Object.entries({
  "missing currency": { currency: undefined },
  "whitespace currency": { currency: " CNY " },
  "payment failed despite completed order": { paymentStatus: "failed" },
  "pending order despite successful payment": { orderStatus: "pending" },
  "mismatched business payment id": { paymentId: "PAY_other" },
  "legacy-looking account binding": { orderMerchantExternalId: "user@example.test" },
  "charged amount absent even with deprecated amount": { chargedAmount: undefined, amount: "15.00" },
  "missing price breakdown": { listPrice: undefined },
})) {
  test(`unapproved production ${name} remains retryable and performs no entitlement action`, async () => {
    let calls = 0;
    await withFetch(async () => { calls += 1; return Response.json({}); }, async () => {
      const env = createEnv({ WAFFO_PRODUCTION_ENTITLEMENT_ENABLED: "true" });
      assert.equal((await worker.fetch(webhookRequest(completedEnvelope({ data })), env)).status, 503);
      assert.equal(calls, 0);
      assert.equal(env.__kv.size, 0);
    });
  });
}

for (const amount of [null, 15, "NaN", "Infinity", "-Infinity", "1e2", "0x0f", "+15", "-15", "15.001", " 15.00", "15.00 ", "015.00", "1,500", "15000000000", "0.00"]) {
  test(`amount validation rejects ${JSON.stringify(amount)}`, () => {
    assert.equal(validateWaffoAmounts({ chargedAmount: amount, listPrice: { total: "15", subtotal: "15", taxAmount: "0" } }).valid, false);
  });
}

test("tax arithmetic is exact and a list-price mismatch or unknown discount is not accepted", () => {
  assert.equal(validateWaffoAmounts({ chargedAmount: "16.50", listPrice: { total: "16.5", subtotal: "15", taxAmount: "1.50" } }).valid, true);
  assert.equal(validateWaffoAmounts({ chargedAmount: "15", listPrice: { total: "16.5", subtotal: "15", taxAmount: "1.50" } }).valid, false);
  assert.equal(validateWaffoAmounts({ chargedAmount: "16.5", listPrice: { total: "16.5", subtotal: "15", taxAmount: "1.51" } }).valid, false);
  // 格式和算术通过不代表有资格；商品和原价证明没有，因此生产仍 503。
});

test("official completed payload with no productId is observed in test but cannot grant in prod", async () => {
  const official = completedEnvelope({ data: { productId: undefined } });
  const recorded = [];
  await withFetch(ledgerMock(recorded), async () => {
    const prod = createEnv({ WAFFO_PRODUCTION_ENTITLEMENT_ENABLED: "true" });
    assert.equal((await worker.fetch(webhookRequest(official), prod)).status, 503);
    const testEnv = createTestEnv();
    assert.equal((await worker.fetch(webhookRequest({ ...official, mode: "test" }, { privateKey: testKeys.privateKey }), testEnv)).status, 200);
    assert.equal(recorded.length, 1);
  });
});

test("refund success and failure sharing an entity id are separately recorded without revoking Pro", async () => {
  const env = createEnv();
  let writes = 0;
  await withFetch(async () => { writes += 1; return Response.json({}); }, async () => {
    for (const eventType of ["refund.succeeded", "refund.failed"]) {
      const envelope = completedEnvelope({ id: "REF_123", eventId: "REF_123", eventType, data: { refundId: "REF_123" } });
      assert.equal((await worker.fetch(webhookRequest(envelope), env)).status, 200);
    }
    assert.equal(env.__kv.size, 2);
    assert.equal(writes, 0);
  });
});

test("test and prod observations cannot share a delivery cache key", async () => {
  await withFetch(ledgerMock(), async () => {
    const env = createEnv();
    assert.equal((await worker.fetch(webhookRequest(completedEnvelope()), env)).status, 200);
    env.WAFFO_ENVIRONMENT = "test";
    assert.equal((await worker.fetch(webhookRequest(completedEnvelope({ mode: "test" }), { privateKey: testKeys.privateKey }), env)).status, 200);
    assert.equal(env.__kv.size, 2);
  });
});

test("suppressed observations do not mark a later entitlement attempt processed", async () => {
  const env = createEnv();
  assert.equal((await worker.fetch(webhookRequest(completedEnvelope()), env)).status, 200);
  env.WAFFO_PRODUCTION_ENTITLEMENT_ENABLED = "true";
  assert.equal((await worker.fetch(webhookRequest(completedEnvelope()), env)).status, 503);
  assert.equal(env.__kv.size, 1);
});

test("KV outage cannot trigger entitlement writes and a retry remains fail closed", async () => {
  const env = createEnv({
    WAFFO_PRODUCTION_ENTITLEMENT_ENABLED: "true",
    WAFFO_EVENTS: { async get() { throw new Error("unavailable"); }, async put() { throw new Error("unavailable"); } },
  });
  let writes = 0;
  await withFetch(async () => { writes += 1; return Response.json({}); }, async () => {
    assert.equal((await worker.fetch(webhookRequest(completedEnvelope()), env)).status, 503);
    assert.equal((await worker.fetch(webhookRequest(completedEnvelope()), env)).status, 503);
    assert.equal(writes, 0);
  });
});

test("request body size is bounded even without Content-Length", async () => {
  const request = new Request("https://waffopay.example.test/webhook/waffo", { method: "POST", body: "x".repeat(65537) });
  assert.equal((await worker.fetch(request, createEnv())).status, 413);
});

test("an allowed checkout Origin receives CORS even on a streamed body-size error", async () => {
  const response = await worker.fetch(checkoutRequest("x".repeat(65537)), createTestEnv());
  assert.equal(response.status, 413);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://sunland.dev");
  assert.deepEqual(await response.json(), { ok: false });
});

test("an inherited property name is not a cashier language", async () => {
  let language;
  await withFetch(async (input, init) => {
    if (String(input).includes("/rpc/")) return Response.json(goodIntent);
    language = JSON.parse(init.body).language;
    return Response.json(goodSession);
  }, async () => {
    assert.equal((await worker.fetch(checkoutRequest({ language: "__proto__" }), createTestEnv())).status, 200);
    assert.equal(language, "en");
  });
});


test("intent diagnostics classify failures without exposing credentials or response text", async () => {
  const canary = "SECRET_RESPONSE_TOKEN_PASSWORD_CANARY";
  const cases = [
    [() => { throw new TypeError(canary); }, "intent_network", 503],
    [() => new Response(canary), "intent_json_parse", 503],
    [() => Response.json([]), "intent_json_shape", 503],
    [() => Response.json({ code: "PGRST202", message: canary, [canary]: canary }, { status: 400 }), "intent_http", 503],
    [() => new Response(canary, { status: 403 }), "intent_unauthorized", 401],
    [() => new Response(canary.repeat(6000)), "intent_body_too_large", 503],
    [() => new Response(null, { status: 204 }), "intent_response_reconstruction", 503],
    [() => new Response(new ReadableStream({ start(controller) { controller.error(new Error(canary)); } })), "intent_body_read", 503],
  ];
  const originalLog = console.log;
  try {
    for (const [mock, reason, status] of cases) {
      const logs = [];
      console.log = value => logs.push(JSON.parse(value));
      await withFetch(mock, async () => {
        const response = await worker.fetch(checkoutRequest(), createTestEnv());
        assert.equal(response.status, status);
      });
      const diagnostic = logs.find(log => log.event === "waffo_intent_failed");
      assert.equal(diagnostic.reason, reason);
      assert.equal(typeof diagnostic.elapsed_ms, "number");
      const serialized = JSON.stringify(logs);
      assert.equal(serialized.includes(canary), false);
      assert.equal(serialized.includes(CHECKOUT_TOKEN), false);
      assert.equal(serialized.includes(CHECKOUT_PRIVATE_PEM), false);
      if (reason === "intent_http") assert.equal(diagnostic.postgrest_code, "PGRST202");
      if (reason === "intent_body_too_large") assert.ok(diagnostic.body_bytes > 64 * 1024);
    }
  } finally { console.log = originalLog; }
});

test("intent diagnostics distinguish timeout during response body reading", async () => {
  const originalTimer = globalThis.setTimeout;
  const originalLog = console.log;
  const logs = [];
  globalThis.setTimeout = callback => { queueMicrotask(callback); return 0; };
  console.log = value => logs.push(JSON.parse(value));
  try {
    await withFetch(async (_, init) => new Response(new ReadableStream({ start(controller) {
      const abort = () => controller.error(new DOMException("sensitive abort message", "AbortError"));
      if (init.signal.aborted) abort(); else init.signal.addEventListener("abort", abort);
    } })), async () => {
      assert.equal((await worker.fetch(checkoutRequest(), createTestEnv())).status, 503);
    });
    assert.equal(logs.find(log => log.event === "waffo_intent_failed").reason, "intent_timeout");
    assert.equal(JSON.stringify(logs).includes("sensitive abort message"), false);
  } finally { globalThis.setTimeout = originalTimer; console.log = originalLog; }
});


test("checkout uses workerd-supported manual redirects and rejects credential forwarding", async () => {
  let calls = 0;
  await withFetch(async (_, init) => {
    calls += 1;
    assert.equal(init.redirect, "manual");
    return new Response(null, { status: 302, headers: { Location: "https://attacker.example/secret" } });
  }, async () => {
    const response = await worker.fetch(checkoutRequest(), createTestEnv());
    assert.equal(response.status, 503);
    const diagnostic = JSON.parse(response.headers.get("X-Waffo-Intent-Diagnostic"));
    assert.equal(diagnostic.reason, "intent_redirect");
    assert.equal(diagnostic.http_status, 302);
    assert.equal(calls, 1);
  });
});

test("Test webhook store IDs are case-sensitive opaque identifiers including l versus 1", async () => {
  const expectedStore = "STO_fixturel";
  for (const storeId of ["STO_fixture1", expectedStore]) {
    const envelope = completedEnvelope();
    envelope.mode = "test";
    envelope.storeId = storeId;
    let ledgerCalls = 0;
    const mock = ledgerMock();
    await withFetch(async (input, init) => {
      if (String(input).includes("/rpc/record_event")) ledgerCalls += 1;
      return mock(input, init);
    }, async () => {
      const response = await worker.fetch(webhookRequest(envelope, { privateKey: testKeys.privateKey }), createTestEnv({ WAFFO_STORE_ID: expectedStore }));
      assert.equal(response.status, storeId === expectedStore ? 200 : 400);
      assert.equal(ledgerCalls, storeId === expectedStore ? 1 : 0);
    });
  }
});


test("intent diagnostic byte count measures raw stream bytes before UTF-8 decoding", async () => {
  const originalLog = console.log;
  const logs = [];
  console.log = value => logs.push(JSON.parse(value));
  try {
    await withFetch(async () => new Response(new Uint8Array([0xff])), async () => {
      assert.equal((await worker.fetch(checkoutRequest(), createTestEnv())).status, 503);
    });
    assert.equal(logs.find(log => log.event === "waffo_intent_failed").body_bytes, 1);
  } finally { console.log = originalLog; }
});
