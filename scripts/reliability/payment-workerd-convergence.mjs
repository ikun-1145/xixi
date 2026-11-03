/**
 * Real workerd + ephemeral D1 + STRICTLY IN-PROCESS Waffo/Supabase mocks.
 *
 * This verifies Worker orchestration and persistence boundaries, NOT the real
 * Supabase PostgreSQL transaction implementation or a live payment provider.
 * No Cloudflare credentials, production keys, actual network, or persistent DB.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync, createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const ACCOUNT_REF = "11111111-1111-4111-8111-111111111111";
const ID = {merchant:"MER_synthetic",store:"STO_synthetic",product:"PROD_synthetic",order:"ORD_one",payment:"PAY_one"};
const SERVICE_KEY = "synthetic-not-a-real-service-token";
const fakeKey = generateKeyPairSync("rsa", {modulusLength:2048});
const otherKey = generateKeyPairSync("rsa", {modulusLength:2048});
const prodPrivate = fakeKey.privateKey.export({type:"pkcs8",format:"pem"});
const testPrivate = otherKey.privateKey.export({type:"pkcs8",format:"pem"});
const prodPublic = fakeKey.publicKey.export({type:"spki",format:"pem"});
const testPublic = otherKey.publicKey.export({type:"spki",format:"pem"});
let tests = 0;

async function runtime() {
  const base = process.env.PAYMENT_MINIFLARE_ROOT;
  if (!base || !base.startsWith("/")) throw new Error("Isolated Miniflare module root required");
  const require = createRequire(join(base, "isolated-loader.cjs"));
  const imported = await import(pathToFileURL(require.resolve("miniflare")).href);
  if (!imported.Miniflare || !imported.convertV4MiniflareOptions) {
    throw new Error("Missing approved workerd runtime");
  }
  return imported;
}

function webhookEnvelope(type = "order.completed", id = ID.payment) {
  return {
    id: "synthetic-delivery-" + id,
    eventId: id,
    eventType: type,
    mode: "prod",
    storeId: ID.store,
    timestamp: Date.now(),
    data: {
      orderMerchantExternalId: ACCOUNT_REF,
      orderId: ID.order,
      paymentId: type === "order.completed" ? ID.payment : undefined,
      orderStatus: type === "order.completed" ? "completed" : undefined,
      paymentStatus: type === "order.completed" ? "succeeded" : undefined,
      currency: "CNY",
      chargedAmount: type === "order.completed" ? "15.00" : undefined,
      listPrice: type === "order.completed" ? {
        subtotal: "15.00", total: "15.00", taxAmount: "0.00",
      } : undefined,
    },
  };
}

function signedRequest(event, key = fakeKey.privateKey) {
  const raw = JSON.stringify(event);
  const t = Date.now();
  const signature = createSign("RSA-SHA256").update(String(t) + "." + raw).sign(key, "base64");
  return new Request("https://payments.unit.invalid/webhook/waffo", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Waffo-Signature": "t=" + t + ",v1=" + signature,
    },
    body: raw,
  });
}

function mockRpc(state, name, requestBody) {
  if (name !== "sunland_waffo_apply_event") return Response.json({}, { status: 403 });
  const proof = requestBody?.p_event;
  if (!proof || proof.payment_reference !== ACCOUNT_REF ||
      proof.store_id !== ID.store || proof.product_id !== ID.product ||
      proof.amount_minor !== 1500 || proof.mode !== "prod" ||
      !["order.completed", "refund.succeeded"].includes(proof.event_type)) {
    return Response.json({}, { status: 400 });
  }
  state.rpcCalls++;
  const eventKey = proof.event_type + "|" + proof.event_id;
  if (state.seen.has(eventKey)) {
    return Response.json({
      status: "duplicate",
      paymentConfirmed: state.confirmed,
      entitlementState: state.entitlement,
      version: state.version,
    });
  }
  state.seen.add(eventKey);
  if (proof.event_type === "refund.succeeded") {
    state.confirmed = false;
    state.entitlement = "revoked";
    state.version++;
  } else if (state.entitlement !== "revoked") {
    state.confirmed = true;
    state.entitlement = proof.entitlement_enabled ? "granted" : "pending";
    state.grants += proof.entitlement_enabled ? 1 : 0;
    state.version++;
  }
  const outcome = {
    status: state.entitlement === "revoked" ? "refunded" :
      state.entitlement === "granted" ? "granted" : "recorded",
    paymentConfirmed: state.confirmed,
    entitlementState: state.entitlement,
    version: state.version,
  };
  if (state.loseNextRpcResponse) {
    state.loseNextRpcResponse = false; // Simulate committed PG txn, lost HTTP ack.
    return Response.json({}, { status: 503 });
  }
  return Response.json(outcome);
}

async function setup({ Miniflare, convertV4MiniflareOptions }, bundlePath) {
  const state = {
    entitlement: "pending", confirmed: false, grants: 0, version: 0,
    seen: new Set(), rpcCalls: 0, httpCalls: 0, refunds: [],
    testMode: false, loseNextRpcResponse: false,
  };
  const fakeOutbound = async req => {
    state.httpCalls++;
    const url = new URL(req.url);
    if (url.origin === "https://api.waffo.ai" && url.pathname === "/v1/graphql") {
      const payload = await req.json();
      assert.equal(payload.variables.id, ID.order);
      assert.equal(payload.variables.merchant, ID.merchant);
      return Response.json({data:{
        merchant: {id:ID.merchant, storeMerchants:[{store:{id:ID.store}}]},
        onetimeOrder: {
          id:ID.order, store:{id:ID.store}, onetimeProduct:{id:ID.product},
          testMode:state.testMode, currency:"CNY", status:"completed",
          orderMerchantExternalId:ACCOUNT_REF,
          payments:[{id:ID.payment,status:"succeeded",refunds:state.refunds}],
        },
      }});
    }
    if (url.origin === "https://klyrasrqgxijwrxuoevj.supabase.co" &&
        url.pathname === "/rest/v1/rpc/sunland_waffo_apply_event") {
      assert.equal(req.headers.get("apikey"), SERVICE_KEY);
      return mockRpc(state, "sunland_waffo_apply_event", await req.json());
    }
    // NO real networking, including unknown or redirected URLs.
    throw new Error("unexpected synthetic outbound host");
  };
  const env = {
    WAFFO_ENVIRONMENT:"test",
    WAFFO_PRODUCTION_ENABLED:"true",
    WAFFO_PRODUCTION_ENTITLEMENT_ENABLED:"true",
    WAFFO_PROD_MERCHANT_ID:ID.merchant,
    WAFFO_PROD_STORE_ID:ID.store,
    WAFFO_PROD_PRODUCT_ID:ID.product,
    WAFFO_WEBHOOK_PUBLIC_KEY_PROD:prodPublic,
    WAFFO_WEBHOOK_PUBLIC_KEY_TEST:testPublic,
    WAFFO_PRIVATE_KEY_PRODUCTION:prodPrivate,
    WAFFO_PRIVATE_KEY_TEST:testPrivate,
    WAFFO_PRODUCTION_SERVICE_ROLE_KEY:SERVICE_KEY,
    SUPABASE_ANON_KEY:"synthetic-not-real-anon",
  };
  const mf = new Miniflare(convertV4MiniflareOptions({
    name:"payment-convergence-test",
    compatibilityDate:"2026-09-05",
    modules:[{type:"ESModule",path:"worker.js",contents:readFileSync(bundlePath,"utf8")}],
    bindings:env,
    d1Databases:{WAFFO_PRODUCTION_LEDGER:"88888888-8888-4888-8888-888888888888"},
    outboundService:fakeOutbound,
  }));
  try {
    const db = await mf.getD1Database("WAFFO_PRODUCTION_LEDGER");
    const base = new URL("../../workers/waffopay/production-backend/",import.meta.url);
    await db.exec(readFileSync(new URL("schema.sql",base),"utf8"));
    await db.exec(readFileSync(new URL("outbox.sql",base),"utf8"));
    await db.prepare("INSERT INTO payment_intents VALUES (?,'prod','synthetic-user',?,?,'CNY',1500,?,1)")
      .bind(ACCOUNT_REF, ID.store, ID.product, ACCOUNT_REF).run();
    return {mf,db,state,worker:await mf.getWorker()};
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}

async function deliver(world,event,key) {
  const result = await world.worker.fetch(signedRequest(event,key));
  return { status:result.status, body:await result.json() };
}

async function cron(world) {
  await world.db.prepare("UPDATE production_outbox SET updated_at=0 WHERE state='pending'").run();
  return world.worker.scheduled({cron:"*/5 * * * *",scheduledTime:new Date(0)});
}

async function outbox(world) {
  return world.db.prepare("SELECT state,attempt_count,last_error FROM production_outbox WHERE event_type='order.completed' AND event_id=?")
    .bind(ID.payment).first();
}

async function scenario(title,bundlePath,runtimeModule,run) {
  const world = await setup(runtimeModule,bundlePath);
  try {
    await run(world);
    tests++;
    process.stdout.write("PASS workerd convergence: " + title + "\n");
  } finally {
    await world.mf.dispose();
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || !argv[0]?.startsWith("/")) throw new Error("Missing compiled candidate bundle root");
  const path = resolve(argv[0],"waffopay","candidate","worker.js");
  const run = await runtime();

  await scenario("signed payment proof grants once; same webhook replays without double-grant",path,run,async w => {
    const event = webhookEnvelope();
    const first = await deliver(w,event);
    assert.equal(first.status,200,JSON.stringify(first.body));
    assert.equal(w.state.entitlement,"granted");
    assert.equal(w.state.grants,1);
    assert.equal((await outbox(w)).state,"delivered");
    const second = await deliver(w,event);
    assert.equal(second.status,200,JSON.stringify(second.body));
    assert.equal(second.body.status,"duplicate");
    assert.equal(w.state.grants,1);
    const row = await w.db.prepare("SELECT COUNT(*) AS n FROM event_ledger").first();
    assert.equal(row.n,1);
  });

  await scenario("refund tombstone prevents later completion from re-granting",path,run,async w => {
    const event = webhookEnvelope();
    assert.equal((await deliver(w,event)).status,200);
    w.state.refunds = [{id:"rf-1",status:"succeeded"}];
    const refund = await deliver(w,webhookEnvelope("refund.succeeded","rf-1"));
    assert.equal(refund.status,200,JSON.stringify(refund.body));
    assert.equal(w.state.entitlement,"revoked");
    assert.equal(w.state.confirmed,false);
    const repeat = await deliver(w,event);
    assert.equal(repeat.status,200,JSON.stringify(repeat.body));
    assert.equal(w.state.entitlement,"revoked");
    assert.equal(w.state.grants,1);
  });

  await scenario("lost RPC response leaves outbox pending and Cron retry does not double-grant",path,run,async w => {
    w.state.loseNextRpcResponse = true;
    const first = await deliver(w,webhookEnvelope());
    assert.equal(first.status,503,JSON.stringify(first.body));
    assert.equal(w.state.grants,1);
    assert.equal((await outbox(w)).state,"pending");
    await cron(w);
    assert.equal((await outbox(w)).state,"delivered");
    assert.equal(w.state.grants,1);
    assert.equal(w.state.entitlement,"granted");
    assert.equal(w.state.rpcCalls,2);
  });

  await scenario("invalid signature and provider Test-mode proof cannot grant",path,run,async w => {
    const untrusted = await deliver(w,webhookEnvelope(),otherKey.privateKey);
    assert.equal(untrusted.status,401);
    assert.equal(w.state.rpcCalls,0);
    w.state.testMode = true;
    const proof = await deliver(w,webhookEnvelope());
    assert.notEqual(proof.status,200);
    assert.equal(w.state.rpcCalls,0);
    assert.equal(w.state.grants,0);
    assert.equal((await outbox(w)).state,"pending");
  });
  process.stdout.write("PASS: " + tests +
    " genuine workerd+D1+mock RPC/payment scenarios; outbound requests handled only by in-process allowlist.\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    // No real credentials exist; still avoid raw payloads and stack traces.
    const msg = String(error?.message || "unknown").replace(/https?:\/\/\S+/g,"[endpoint]")
      .replace(/[A-Za-z0-9+_/-]{75,}/g,"[masked]").slice(0,260);
    process.stderr.write("[BLOCKED] workerd payment convergence: " + msg + "\n");
    process.exitCode=2;
  });
}
