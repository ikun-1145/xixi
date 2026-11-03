/**
 * Real Cloudflare workerd integration across TWO internal Worker service bindings
 * plus ephemeral D1. No production credentials, URLs, transactions, or egress.
 * Both Workers are Wrangler's compiled candidate modules, not JS stub copies.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { generateKeyPairSync, createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import preprodGateway from "../../workers/waffopay/preprod-gateway-proposal.js";

const REF = "11111111-1111-4111-8111-111111111111";
const D1_ID = "88888888-8888-4888-8888-888888888888";
const TOKEN = "synthetic-preprod-only-gate-token-1234567890";
const MERCHANT = "MER_PREPROD1";
const STORE = "STO_PREPROD1";
const PRODUCT = "PROD_PREPROD1";
const ORDER = "ORD_PREPROD1";
const PAYMENT = "PAY_PREPROD1";
const createKeys = () => generateKeyPairSync("rsa", { modulusLength: 2048 });
const signing = createKeys();
const alternate = createKeys();
const priv = signing.privateKey.export({ type: "pkcs8", format: "pem" });
const pub = signing.publicKey.export({ type: "spki", format: "pem" });
const otherPub = alternate.publicKey.export({ type: "spki", format: "pem" });
let cases = 0;

function signedWebhook(privateKey = signing.privateKey) {
  const data = {
    id:"synthetic-delivery-01",
    eventId:PAYMENT,eventType:"order.completed",mode:"prod",
    storeId:STORE,timestamp:Date.now(),
    data:{
      orderMerchantExternalId:REF,orderId:ORDER,paymentId:PAYMENT,
      orderStatus:"completed",paymentStatus:"succeeded",
      currency:"CNY",chargedAmount:"15.00",
      listPrice:{subtotal:"15.00",total:"15.00",taxAmount:"0.00"},
    },
  };
  const raw = JSON.stringify(data);
  const now = Date.now();
  const signature = createSign("RSA-SHA256")
    .update(String(now) + "." + raw).sign(privateKey, "base64");
  return new Request("https://preprod.test.invalid/__preprod/webhook", {
    method: "POST",
    headers: {
      "content-type":"application/json",
      "X-Preprod-Test-Token":TOKEN,
      "X-Waffo-Signature":"t=" + now + ",v1=" + signature,
    },
    body: raw,
  });
}

async function loadRuntime() {
  const root = process.env.PAYMENT_MINIFLARE_ROOT;
  if (!root?.startsWith("/")) throw new Error("No isolated Miniflare runtime");
  const require = createRequire(join(root,"entry.cjs"));
  const loaded = await import(pathToFileURL(require.resolve("miniflare")).href);
  if (typeof loaded.Miniflare !== "function" ||
      typeof loaded.convertV4MiniflareOptions !== "function")
    throw new Error("Invalid Miniflare runtime");
  return {Miniflare:loaded.Miniflare,convertV4MiniflareOptions:loaded.convertV4MiniflareOptions};
}

async function seedLocalD1(db) {
  const root = new URL("../../workers/waffopay/production-backend/",import.meta.url);
  for (const file of ["schema.sql","outbox.sql"]) {
    const sql = readFileSync(new URL(file,root),"utf8")
      .split("\n").filter(line=>!line.trimStart().startsWith("--"))
      .join(" ").split(";").map(x=>x.trim()).filter(Boolean);
    for (const statement of sql) await db.prepare(statement).run();
  }
  await db.prepare(
    "INSERT INTO payment_intents(payment_reference,mode,user_id,store_id,product_id,currency,amount_minor,request_key,created_at)" +
    " VALUES(?,'prod','synthetic-preprod-user',?,?,'CNY',1500,?,?)"
  ).bind(REF,STORE,PRODUCT,REF,Date.now()).run();
}

async function testStep(description, fn) {
  await fn();
  cases++;
  process.stdout.write("PASS isolated preprod workerd: " + description + "\n");
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || !argv[0]?.startsWith("/")) throw new Error("Expected absolute compiled staging module root");
  const root = resolve(argv[0]);
  const preprod = readFileSync(join(root,"worker","preprod-worker.js"),"utf8");
  const mock = readFileSync(join(root,"mock","preprod-mock.js"),"utf8");
  if (preprod.length < 1000 || mock.length < 400) throw new Error("Compiled preprod modules missing");
  const {Miniflare,convertV4MiniflareOptions} = await loadRuntime();
  // The gateway's Cloudflare Access context is locally simulated in Node.
  // The private Worker, Mock Worker, Service Bindings, and D1 run in workerd.
  const gatewayAudit = "synthetic-test-Access-AUD-not-production-12345678";
  const gatewayIdentity = {access:{aud:gatewayAudit,
    async getIdentity(){return {email:"synthetic-operator@example.invalid"};}}};
  let unmockedOutbound = 0;
  const blocked = async () => {
    unmockedOutbound++;
    return new Response("NETWORK_DISABLED", {status:503});
  };
  const workerConfig = convertV4MiniflareOptions({
        name:"waffopay-preprod-isolated",
        compatibilityDate:"2026-09-05",
        modules:[{type:"ESModule",path:"preprod-worker.js",contents:preprod}],
        bindings:{
          WAFFO_PREPROD_ISOLATED:"true",
          WAFFO_ENVIRONMENT:"test",
          WAFFO_PRODUCTION_ENABLED:"true",
          WAFFO_PRODUCTION_ENTITLEMENT_ENABLED:"false",
          WAFFO_PREPROD_GATE_TOKEN:TOKEN,
          WAFFO_PREPROD_SIGNING_KEY:priv,
          WAFFO_PREPROD_RPC_TEST_KEY:"waffo-preprod-synthetic-rpc-test-only-123456",
          WAFFO_WEBHOOK_PUBLIC_KEY_PROD:pub,
          WAFFO_WEBHOOK_PUBLIC_KEY_TEST:otherPub,
          WAFFO_PROD_MERCHANT_ID:MERCHANT,
          WAFFO_PROD_STORE_ID:STORE,
          WAFFO_PROD_PRODUCT_ID:PRODUCT,
        },
        d1Databases:{WAFFO_PRODUCTION_LEDGER:D1_ID},
        serviceBindings:{
          WAFFO_PREPROD_PROVIDER:"waffopay-preprod-mock",
          WAFFO_PREPROD_RPC:"waffopay-preprod-mock",
        },
        outboundService:blocked,
  });
  const mockConfig = convertV4MiniflareOptions({
        name:"waffopay-preprod-mock",
        compatibilityDate:"2026-09-05",
        modules:[{type:"ESModule",path:"preprod-mock.js",contents:mock}],
        outboundService:blocked,
  });
  // v5 takes the converted Cloudflare config representation, not raw v4
  // WorkerOptions objects. Merging only converted worker entries keeps both
  // service-bound Workers in the same isolated workerd instance.
  const mf = new Miniflare({
    ...workerConfig,
    workers:[...workerConfig.workers,...mockConfig.workers],
  });
  try {
    const db = await mf.getD1Database("WAFFO_PRODUCTION_LEDGER");
    await seedLocalD1(db);
    const worker = await mf.getWorker("waffopay-preprod-isolated");
    const gatewayEnv = {
      WAFFO_PREPROD_GATEWAY_ENABLED:"true",
      WAFFO_PREPROD_ISOLATED:"true",
      WAFFO_PREPROD_ENTITLEMENTS_ENABLED:"false",
      WAFFO_PREPROD_ACCESS_AUD:gatewayAudit,
      WAFFO_PREPROD_GATE_TOKEN:TOKEN,
      WAFFO_PREPROD_ALLOW_CRON:"false",
      WAFFO_PREPROD_TARGET:{fetch:request=>worker.fetch(request)},
    };

    await testStep("no token is rejected without D1 modifications",async()=>{
      const r=await worker.fetch(new Request("https://preprod.test.invalid/__preprod/health"));
      assert.equal(r.status,403);
      const table=await db.prepare("SELECT COUNT(*) AS n FROM event_ledger").first();
      assert.equal(table.n,0);
    });
    await testStep("authorized health has no automatic Cron or entitlements",async()=>{
      const r=await worker.fetch(new Request("https://preprod.test.invalid/__preprod/health",{
        headers:{"X-Preprod-Test-Token":TOKEN},
      }));
      assert.equal(r.status,200);
      const result=await r.json();
      assert.equal(result.mode,"isolated");
      assert.equal(result.entitlements,false);
      assert.equal(result.automaticCron,false);
    });
    await testStep("invalid webhook signature rejected before D1 write",async()=>{
      const r=await worker.fetch(signedWebhook(alternate.privateKey));
      assert.equal(r.status,401);
      assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM event_ledger").first()).n,0);
    });
    await testStep("Access-gated synthetic Webhook traverses Gateway to both real Worker bindings and D1",async()=>{
      const original=signedWebhook();
      // The external caller supplies only Waffo's RSA signature. The gateway
      // adds its private token and must never forward client credentials.
      const incoming=new Request(original.url,{method:"POST",
        headers:{"content-type":"application/json",
          "x-waffo-signature":original.headers.get("X-Waffo-Signature"),
          "Authorization":"Bearer untrusted","Cookie":"session=untrusted"},
        body:await original.text()});
      const r=await preprodGateway.fetch(incoming,gatewayEnv,gatewayIdentity);
      const body=await r.json();
      assert.equal(r.status,200,JSON.stringify(body));
      assert.deepEqual(body,{ok:true,syntheticOnly:true});
      const record=await db.prepare(
        "SELECT state,attempt_count FROM production_outbox WHERE event_id=?"
      ).bind(PAYMENT).first();
      assert.equal(record.state,"delivered");
      assert.equal(record.attempt_count,1);
      assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM event_ledger").first()).n,1);
    });
    await testStep("repeated synthetic payment cannot duplicate D1 ledger row",async()=>{
      const r=await worker.fetch(signedWebhook());
      assert.equal(r.status,200);
      assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM event_ledger").first()).n,1);
      assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM production_outbox").first()).n,1);
    });
    await testStep("manual Cron reports empty queue without any production egress",async()=>{
      const r=await worker.fetch(new Request("https://preprod.test.invalid/__preprod/cron",{
        method:"POST",headers:{"X-Preprod-Test-Token":TOKEN},
      }));
      assert.equal(r.status,200);
      const body=await r.json();
      assert.equal(body.status,"completed");
      assert.equal(body.due,0);
      assert.equal(body.failed,0);
    });
    await testStep("gateway denies unsigned Access context without touching D1",async()=>{
      const before=(await db.prepare("SELECT COUNT(*) AS n FROM event_ledger").first()).n;
      for(const context of [null,{}, {access:{aud:"wrong",getIdentity:gatewayIdentity.access.getIdentity}}]){
        const r=await preprodGateway.fetch(
          new Request("https://gateway.test.invalid/__preprod/health"),gatewayEnv,context);
        assert.equal(r.status,403);
      }
      assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM event_ledger").first()).n,before);
    });
    await testStep("Access gateway returns only safe health information through private Worker",async()=>{
      const r=await preprodGateway.fetch(
        new Request("https://gateway.test.invalid/__preprod/health",{
          headers:{"Authorization":"Bearer ignore","Cf-Access-Jwt-Assertion":"spoofed"},
        }),gatewayEnv,gatewayIdentity);
      assert.equal(r.status,200);
      assert.deepEqual(await r.json(),
        {ok:true,mode:"isolated",entitlements:false,automaticCron:false});
    });
    await testStep("Gateway blocks manual Cron without second opt-in, then reports safe counters",async()=>{
      const request=()=>new Request("https://gateway.test.invalid/__preprod/cron",{method:"POST"});
      const before=await preprodGateway.fetch(request(),gatewayEnv,gatewayIdentity);
      assert.equal(before.status,403);
      gatewayEnv.WAFFO_PREPROD_ALLOW_CRON="true";
      const after=await preprodGateway.fetch(request(),gatewayEnv,gatewayIdentity);
      assert.equal(after.status,200);
      assert.deepEqual(await after.json(),
        {status:"completed",due:0,processed:0,failed:0,unbound:0});
      gatewayEnv.WAFFO_PREPROD_ALLOW_CRON="false";
    });
    await testStep("Gateway rejects non-test routes, URL queries and forged Access headers",async()=>{
      for(const path of ["/checkout/waffo","/webhook/waffo",
        "/__preprod/health?leak=1"]){
        const r=await preprodGateway.fetch(new Request("https://gateway.test.invalid"+path,{
          headers:{"X-User-Email":"attacker@invalid"},
        }),gatewayEnv,gatewayIdentity);
        assert.equal(r.status,404,path);
      }
      const fake=await preprodGateway.fetch(new Request(
        "https://gateway.test.invalid/__preprod/health",{
          headers:{"Cf-Access-Jwt-Assertion":"fake","X-User-Email":"admin@invalid"},
        }),gatewayEnv,{});
      assert.equal(fake.status,403);
    });
    await testStep("public checkout and status endpoints remain inaccessible",async()=>{
      for(const path of ["/checkout/waffo","/v1/account/identity","/webhook/waffo"]){
        const r=await worker.fetch(new Request("https://preprod.test.invalid"+path,{
          method:"POST",headers:{"X-Preprod-Test-Token":TOKEN},
        }));
        assert.equal(r.status,404,path);
      }
      assert.equal(unmockedOutbound,0,"worker must not use network fetch");
    });
    process.stdout.write("PASS: "+cases+" isolated Cloudflare workerd preprod E2E cases, zero global network calls.\n");
  }finally{
    await mf.dispose();
  }
}

if(process.argv[1] && fileURLToPath(import.meta.url)===resolve(process.argv[1])){
  main().catch(error=>{
    const message=String(error?.message||"unknown")
      .replace(/https?:\/\/\S+/g,"[endpoint]")
      .replace(/[A-Za-z0-9+_/=-]{75,}/g,"[masked]")
      .split("\n").slice(0,4).join(" | ").slice(0,360);
    process.stderr.write("[BLOCKED] isolated preprod workerd E2E: "+message+"\n");
    process.exitCode=2;
  });
}
