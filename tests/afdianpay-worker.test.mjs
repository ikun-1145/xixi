import assert from "node:assert/strict";
import test from "node:test";

import worker from "../workers/afdianpay/worker.js";

test("afdianpay skips unbound paid orders before reading ORDERS", async () => {
  const originalFetch = globalThis.fetch;
  const kvReads = [];
  const kvWrites = [];
  const requests = [];

  const env = {
    ORDERS: {
      async get(key) {
        kvReads.push(key);
        return null;
      },
      async put(key, value) {
        kvWrites.push({ key, value });
      },
    },
    SUPABASE_KEY: "test-key",
    SUPABASE_URL: "https://supabase.example.test",
    TOKEN: "test-token",
    USER_ID: "test-user",
  };

  globalThis.fetch = async (input, init) => {
    requests.push({ input: String(input), init });
    if (String(input).includes("ifdian.net/api/open/query-order")) {
      return new Response(JSON.stringify({
        data: {
          list: [
            { status: 2, out_trade_no: "unbound-order" },
            { status: 2, out_trade_no: "bound-order", remark: "user-1" },
          ],
        },
      }), { status: 200 });
    }

    return new Response(JSON.stringify({ status: "activated" }), { status: 200 });
  };

  try {
    await worker.scheduled({}, env, {});
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(kvReads, ["bound-order"]);
  assert.deepEqual(kvWrites, [{ key: "bound-order", value: "1" }]);
  assert.equal(requests.length, 2);
  assert.match(requests[1].input, /supabase\.example\.test\/rest\/v1\/rpc\/sunland_activate_pro_from_payment/);
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    p_user_id: "user-1",
    p_order_id: "bound-order",
  });
});

test("afdianpay does not mark an order in KV when the transactional payment RPC fails", async () => {
  const originalFetch = globalThis.fetch;
  const kvWrites = [];
  const env = {
    ORDERS: {
      async get() { return null; },
      async put(key, value) { kvWrites.push({ key, value }); },
    },
    SUPABASE_KEY: "test-key",
    SUPABASE_URL: "https://supabase.example.test",
    TOKEN: "test-token",
    USER_ID: "test-user",
  };
  globalThis.fetch = async (input) => {
    if (String(input).includes("ifdian.net/api/open/query-order")) {
      return Response.json({ data: { list: [{ status: 2, out_trade_no: "retry-order", remark: "user-1" }] } });
    }
    return Response.json({ message: "database unavailable" }, { status: 500 });
  };
  try {
    await worker.scheduled({}, env, {});
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(kvWrites, []);
});

test("afdianpay safely records the KV completion marker after an idempotent payment RPC retry", async () => {
  const originalFetch = globalThis.fetch;
  const kvWrites = [];
  const env = {
    ORDERS: {
      async get() { return null; },
      async put(key, value) { kvWrites.push({ key, value }); },
    },
    SUPABASE_KEY: "test-key",
    SUPABASE_URL: "https://supabase.example.test",
    TOKEN: "test-token",
    USER_ID: "test-user",
  };
  globalThis.fetch = async (input) => {
    if (String(input).includes("ifdian.net/api/open/query-order")) {
      return Response.json({ data: { list: [{ status: 2, out_trade_no: "repeat-order", remark: "user-1" }] } });
    }
    return Response.json({ status: "already_processed" });
  };
  try {
    await worker.scheduled({}, env, {});
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(kvWrites, [{ key: "repeat-order", value: "1" }]);
});
