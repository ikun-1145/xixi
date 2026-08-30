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

    return new Response(JSON.stringify([{ user_id: "user-1", pro: true }]), {
      status: 201,
    });
  };

  try {
    await worker.scheduled({}, env, {});
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(kvReads, ["bound-order"]);
  assert.deepEqual(kvWrites, [{ key: "bound-order", value: "1" }]);
  assert.equal(requests.length, 2);
  assert.match(requests[1].input, /supabase\.example\.test\/rest\/v1\/user_profiles/);
});
