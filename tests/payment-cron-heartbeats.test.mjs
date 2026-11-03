import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import waffoWorker from "../workers/waffopay/worker.js";
import { reconcileProductionOutbox } from "../workers/waffopay/production.js";

function readonlyLedger(rows) {
  const calls = [];
  return {
    calls,
    prepare(statement) {
      calls.push(statement);
      return {
        bind(...args) {
          return {
            async all() {
              assert.match(statement, /SELECT payload FROM production_outbox/u);
              assert.equal(args.length, 1);
              return { results: rows };
            },
            async first() {
              assert.match(statement, /SELECT \* FROM payment_intents/u);
              return null;
            },
            async run() {
              throw new Error("payment heartbeat test must not write D1");
            },
          };
        },
      };
    },
  };
}

function outboxEnv(ledger) {
  return {
    WAFFO_ENVIRONMENT: "test",
    WAFFO_PRODUCTION_ENABLED: "true",
    WAFFO_PRODUCTION_ENTITLEMENT_ENABLED: "false",
    WAFFO_PRODUCTION_LEDGER: ledger,
    WAFFO_PROD_MERCHANT_ID: "MER_test",
    WAFFO_PROD_STORE_ID: "STO_test",
    WAFFO_PROD_PRODUCT_ID: "PROD_test",
    WAFFO_WEBHOOK_PUBLIC_KEY_PROD: "dummy-prod-public-key",
    WAFFO_WEBHOOK_PUBLIC_KEY_TEST: "dummy-test-public-key",
  };
}

test("unconfigured Waffo outbox is never reported as successful", async () => {
  assert.deepEqual(await reconcileProductionOutbox({}), {
    status: "disabled", due: 0, processed: 0, failed: 0, unbound: 0,
  });
});

test("configured empty Waffo outbox returns completed with zero due records", async () => {
  const ledger = readonlyLedger([]);
  const result = await reconcileProductionOutbox(outboxEnv(ledger));
  assert.deepEqual(result, {
    status: "completed", due: 0, processed: 0, failed: 0, unbound: 0,
  });
  assert.equal(ledger.calls.length, 1);
});

test("an unbound pending Waffo event is not misclassified as completed", async () => {
  const ledger = readonlyLedger([
    { payload: JSON.stringify({ order: { reference: "test-reference" } }) },
  ]);
  const result = await reconcileProductionOutbox(outboxEnv(ledger));
  assert.deepEqual(result, {
    status: "incomplete", due: 1, processed: 0, failed: 0, unbound: 1,
  });
  assert.equal(ledger.calls.length, 2);
});

test("bad pending Waffo payload is accounted as failed and does not leak its content", async () => {
  const ledger = readonlyLedger([{ payload: "{SENSITIVE_FAKE_DATA" }]);
  const logs = [];
  const originalError = console.error;
  console.error = value => logs.push(String(value));
  let result;
  try {
    result = await reconcileProductionOutbox(outboxEnv(ledger));
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(result, {
    status: "incomplete", due: 1, processed: 0, failed: 1, unbound: 0,
  });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /waffo_production_failed/u);
  assert.doesNotMatch(logs[0], /SENSITIVE_FAKE_DATA/u);
});

test("Waffo scheduled handler emits only explicit non-sensitive disabled state", async () => {
  const logged = [];
  const awaited = [];
  const originalLog = console.log;
  console.log = value => logged.push(String(value));
  try {
    await waffoWorker.scheduled({ cron: "*/5 * * * *" }, {}, {
      waitUntil(promise) { awaited.push(promise); },
    });
    assert.equal(awaited.length, 1);
    await Promise.all(awaited);
  } finally {
    console.log = originalLog;
  }
  assert.equal(logged.length, 1);
  assert.deepEqual(JSON.parse(logged[0]), {
    event: "waffo_production_outbox_cycle",
    status: "disabled",
    due: 0,
    processed: 0,
    failed: 0,
    unbound: 0,
  });
});

test("Afdian heartbeat occurs only after all reconciliation lane errors are checked", () => {
  const source = fs.readFileSync(new URL("../workers/afdianpay/worker.js", import.meta.url), "utf8");
  const handler = source.split("async scheduled(controller, env) {")[1]?.split("async fetch(request, env) {")[0];
  assert.ok(handler);
  const failGate = handler.indexOf("if (errors.length) throw new Error('RECONCILIATION_INCOMPLETE')");
  const successEvent = handler.indexOf("event: 'reconciliation_cycle_completed'");
  assert.ok(failGate >= 0 && successEvent > failGate);
  assert.match(handler, /outcomes = await Promise\.allSettled/u);
  assert.match(handler, /retryKnownOrders\(env\)/u);
});

test("production code keeps existing payout, subscription and entitlement processing", () => {
  const source = fs.readFileSync(new URL("../workers/waffopay/production.js", import.meta.url), "utf8");
  assert.match(source, /await processProductionEvent\(env,event,intent\)/u);
  assert.match(source, /if\(!intent\)\{unbound\+\+;continue;\}/u);
  assert.match(source, /productionFailure\(error\)/u);
  assert.match(source, /entitlement_enabled=env\.WAFFO_PRODUCTION_ENTITLEMENT_ENABLED==='true'/u);
});
