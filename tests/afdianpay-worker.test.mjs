import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import test from "node:test";

import worker from "../workers/afdianpay/worker.js";

const PLAN_ID = "4c2527fc6c7411f1bbe45254001e7c00";

function createEnv(overrides = {}) {
  const reads = [];
  const writes = [];
  return {
    AFDIAN_PLAN_ID: PLAN_ID,
    ORDERS: {
      async get(key) {
        reads.push(key);
        return null;
      },
      async put(key, value) {
        writes.push({ key, value });
      },
    },
    SUPABASE_KEY: "test-key",
    SUPABASE_URL: "https://supabase.example.test",
    TOKEN: "test-token",
    USER_ID: "test-user",
    __reads: reads,
    __writes: writes,
    ...overrides,
  };
}

function queryResponse(list, totalPage = 1) {
  return Response.json({ ec: 200, data: { list, total_page: totalPage } });
}

function paidOrder(overrides = {}) {
  return {
    status: 2,
    out_trade_no: "order-1",
    plan_id: PLAN_ID,
    total_amount: "10.00",
    custom_order_id: "payment-reference",
    remark: "legacy-user",
    ...overrides,
  };
}

function rpcResponse(status = "activated") {
  return Response.json({ status });
}

function readRpcBody(requests) {
  const rpcRequest = requests.find(({ input }) => input.includes("/rpc/sunland_activate_pro_from_payment"));
  assert.ok(rpcRequest, "expected a payment activation RPC request");
  return JSON.parse(rpcRequest.init.body);
}

test("afdianpay prefers custom_order_id over the buyer remark", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const env = createEnv();
  globalThis.fetch = async (input, init) => {
    const request = { input: String(input), init };
    requests.push(request);
    if (request.input.includes("query-order")) return queryResponse([paidOrder()]);
    return rpcResponse();
  };

  try {
    await worker.scheduled({}, env, {});
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(readRpcBody(requests), {
    p_order_id: "order-1",
    p_payment_reference: "payment-reference",
    p_binding_source: "intent",
    p_plan_id: PLAN_ID,
    p_total_amount: 10,
    p_paid_at: null,
  });
  assert.equal(env.__reads.includes("order-1"), false, "KV must not be the order ledger");
});

test("afdianpay only falls back to a legacy remark when custom_order_id is absent", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const env = createEnv();
  globalThis.fetch = async (input, init) => {
    const request = { input: String(input), init };
    requests.push(request);
    if (request.input.includes("query-order")) {
      return queryResponse([paidOrder({
        custom_order_id: "",
        remark: "e736a9426c7311f1851452540025c377",
      })]);
    }
    return rpcResponse();
  };

  try {
    await worker.scheduled({}, env, {});
  } finally {
    globalThis.fetch = originalFetch;
  }

  const body = readRpcBody(requests);
  assert.equal(body.p_payment_reference, "e736a9426c7311f1851452540025c377");
  assert.equal(body.p_binding_source, "legacy");
});

test("afdianpay recognizes a legacy user UUID already stored in custom_order_id", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const env = createEnv();
  globalThis.fetch = async (input, init) => {
    const request = { input: String(input), init };
    requests.push(request);
    if (request.input.includes("query-order")) {
      return queryResponse([paidOrder({
        custom_order_id: "e736a9426c7311f1851452540025c377",
        remark: "thanks-pro",
      })]);
    }
    return rpcResponse();
  };

  try {
    await worker.scheduled({}, env, {});
  } finally {
    globalThis.fetch = originalFetch;
  }

  const body = readRpcBody(requests);
  assert.equal(body.p_payment_reference, "e736a9426c7311f1851452540025c377");
  assert.equal(body.p_binding_source, "legacy");
});

test("afdianpay never treats a buyer message as a legacy account binding", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const env = createEnv();
  globalThis.fetch = async (input, init) => {
    const request = { input: String(input), init };
    requests.push(request);
    if (request.input.includes("query-order")) {
      return queryResponse([paidOrder({ custom_order_id: "", remark: "thanks-pro" })]);
    }
    return rpcResponse("unresolved");
  };

  try {
    await worker.scheduled({}, env, {});
  } finally {
    globalThis.fetch = originalFetch;
  }

  const body = readRpcBody(requests);
  assert.equal(body.p_payment_reference, null);
  assert.equal(body.p_binding_source, "unresolved");
});

test("afdianpay persists an eligible order with no usable binding as unresolved", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const env = createEnv();
  globalThis.fetch = async (input, init) => {
    const request = { input: String(input), init };
    requests.push(request);
    if (request.input.includes("query-order")) {
      return queryResponse([paidOrder({ custom_order_id: "", remark: "" })]);
    }
    return rpcResponse("unresolved");
  };

  try {
    await worker.scheduled({}, env, {});
  } finally {
    globalThis.fetch = originalFetch;
  }

  const body = readRpcBody(requests);
  assert.equal(body.p_payment_reference, null);
  assert.equal(body.p_binding_source, "unresolved");
});

test("afdianpay records other paid plans as ineligible instead of granting Pro", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const env = createEnv();
  globalThis.fetch = async (input, init) => {
    const request = { input: String(input), init };
    requests.push(request);
    if (request.input.includes("query-order")) {
      return queryResponse([paidOrder({ plan_id: "other-plan" })]);
    }
    return rpcResponse("ineligible");
  };

  try {
    await worker.scheduled({}, env, {});
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(readRpcBody(requests).p_plan_id, "other-plan");
});

test("afdianpay retries an idempotent Supabase activation failure before leaving it for cron", async () => {
  const originalFetch = globalThis.fetch;
  let rpcAttempts = 0;
  const env = createEnv();
  globalThis.fetch = async input => {
    if (String(input).includes("query-order")) return queryResponse([paidOrder()]);
    rpcAttempts += 1;
    return rpcAttempts === 1
      ? Response.json({ message: "temporary failure" }, { status: 503 })
      : rpcResponse();
  };

  try {
    await worker.scheduled({}, env, {});
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(rpcAttempts, 2);
});

test("afdianpay advances a durable reconciliation cursor for older pages", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const env = createEnv({
    ORDERS: {
      async get(key) {
        env.__reads.push(key);
        return key === "pro-reconcile:next-page" ? "2" : null;
      },
      async put(key, value) {
        env.__writes.push({ key, value });
      },
    },
  });
  globalThis.fetch = async (input, init) => {
    const request = { input: String(input), init };
    requests.push(request);
    if (!request.input.includes("query-order")) return rpcResponse();
    const params = JSON.parse(JSON.parse(init.body).params);
    return params.page === 1
      ? queryResponse([], 2)
      : queryResponse([paidOrder({ out_trade_no: "older-order" })], 2);
  };

  try {
    await worker.scheduled({}, env, {});
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(readRpcBody(requests).p_order_id, "older-order");
  assert.ok(env.__writes.some(({ key, value }) => key === "pro-reconcile:next-page" && value === "1"));
  assert.ok(
    env.__writes.some(({ key, value }) => key === "pro-reconcile:last-full-scan-day" && /^\d{4}-\d{2}-\d{2}$/.test(value)),
    "finishing the final history page must record a completed full scan",
  );
});

test("afdianpay rejects the retired public test endpoint and unauthenticated admin replay", async () => {
  const env = createEnv({ ADMIN_TOKEN: "admin-secret" });
  const testResponse = await worker.fetch(new Request("https://worker.example.test/test"), env, {});
  const adminResponse = await worker.fetch(new Request("https://worker.example.test/admin/reconcile", {
    method: "POST",
    body: JSON.stringify({ out_trade_no: "order-1" }),
  }), env, {});

  assert.equal(testResponse.status, 404);
  assert.equal(adminResponse.status, 404);
});

test("afdianpay verifies signed webhooks and acknowledges only durable outcomes", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const order = paidOrder({ out_trade_no: "webhook-order" });
  const signer = createSign("RSA-SHA256");
  signer.update(`${order.out_trade_no}${order.user_id || ""}${order.plan_id}${order.total_amount}`);
  signer.end();
  const sign = signer.sign(privateKey, "base64");
  const env = createEnv({ AFDIAN_WEBHOOK_PUBLIC_KEY: publicKeyPem });
  const originalFetch = globalThis.fetch;
  let rpcRequests = 0;
  globalThis.fetch = async input => {
    if (String(input).includes("/rpc/")) rpcRequests += 1;
    return rpcResponse();
  };

  try {
    const accepted = await worker.fetch(new Request("https://worker.example.test/webhook/afdian", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ec: 200, data: { type: "order", order }, sign }),
    }), env, {});
    const rejected = await worker.fetch(new Request("https://worker.example.test/webhook/afdian", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ec: 200, data: { type: "order", order }, sign: "invalid" }),
    }), env, {});

    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { ec: 200, em: "" });
    assert.equal(rejected.status, 401);
    assert.equal(rpcRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
