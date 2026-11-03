/**
 * Cloudflare preproduction infrastructure isolation preflight: GET only.
 * Makes no modifications, does not inspect script bodies or secret values.
 * Expected to be run by an operator with a dedicated read-only API token.
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const STAGING = Object.freeze({
  entry: "waffopay-preprod-isolated",
  mock: "waffopay-preprod-mock",
  d1: "waffopay-preprod-ledger-isolated",
  liveWaffoD1: "9003f99a-bcef-4ba5-a961-33c399a01ab5",
});
const WORKER_PRODUCTION = Object.freeze(["waffopay", "afdianpay", "ai"]);
const ACCOUNT = /^[a-f0-9]{32}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

async function safeGet(fetchImpl, token, accountId, path) {
  let response;
  try {
    response = await fetchImpl("https://api.cloudflare.com/client/v4/accounts/" +
      accountId + path, {
        method: "GET",
        headers: { Authorization: "Bearer " + token },
        signal: AbortSignal.timeout(15_000),
      });
  } catch {
    throw new Error("Cloudflare read-only preflight network unavailable");
  }
  if (!response?.ok) throw new Error("Cloudflare read-only preflight HTTP " +
    (Number.isInteger(response?.status) ? response.status : "unknown"));
  let data;
  try { data = await response.json(); }
  catch { throw new Error("Cloudflare read-only preflight JSON invalid"); }
  if (data?.success !== true || data.result === undefined) {
    throw new Error("Cloudflare read-only preflight response incomplete");
  }
  return data;
}

async function listInventory(fetchImpl, token, accountId) {
  const workersResult = await safeGet(fetchImpl,token,accountId,"/workers/scripts");
  if (!Array.isArray(workersResult.result)) throw new Error("Worker inventory is unavailable");
  const workers = workersResult.result.map(x=>x?.id || x?.name);
  if (workers.some(x => typeof x !== "string") ||
      new Set(workers).size !== workers.length) {
    throw new Error("Worker inventory invalid");
  }

  const databases = [];
  const PAGE_SIZE=100;
  for(let page=1;page<=100;page++){
    const response = await safeGet(fetchImpl,token,accountId,
      "/d1/database?page="+page+"&per_page="+PAGE_SIZE);
    const current=response.result;
    const info=response.result_info;
    if(!Array.isArray(current)||!info ||
      !Number.isInteger(info.total_count)||info.total_count<0 ||
      !Number.isInteger(info.page)||info.page!==page ||
      !Number.isInteger(info.per_page)||info.per_page!==PAGE_SIZE) {
      throw new Error("D1 inventory pagination unverified");
    }
    for(const db of current){
      if(typeof db?.name!=="string"||!UUID.test(db?.uuid||"")) {
        throw new Error("D1 inventory item invalid");
      }
      databases.push({name:db.name,id:db.uuid.toLowerCase()});
    }
    if(databases.length>=info.total_count){
      if(databases.length!==info.total_count)throw new Error("D1 inventory count mismatch");
      break;
    }
    if(page===100||current.length===0)throw new Error("D1 inventory truncated");
  }
  if(new Set(databases.map(x=>x.id)).size!==databases.length) {
    throw new Error("Duplicate D1 inventory identifiers");
  }
  const prodBindings={};
  for(const worker of WORKER_PRODUCTION) {
    if(!workers.includes(worker)) throw new Error("Missing expected production Worker");
    const response=await safeGet(fetchImpl,token,accountId,
      "/workers/scripts/"+worker+"/settings");
    if(!Array.isArray(response.result?.bindings))throw new Error("Worker bindings unavailable");
    const extracted=response.result.bindings
      .filter(x=>x.type==="d1"||x.type==="service")
      .map(x=>({type:x.type,name:x.name,
        id:x.type==="d1"?x.id:undefined,
        service:x.type==="service"?x.service:undefined,
        environment:x.type==="service"?x.environment:undefined}));
    prodBindings[worker]=extracted;
  }
  return {workers,databases,prodBindings};
}

export function checkCloudPreprodIsolation(inventory, mode, candidateId) {
  const issues=[];
  if(!inventory || !Array.isArray(inventory.workers) ||
     !Array.isArray(inventory.databases) ||
     !inventory.prodBindings || !WORKER_PRODUCTION.every(w=>Array.isArray(inventory.prodBindings[w]))) {
    return ["Incomplete Cloudflare inventory"];
  }
  if(!["before-create","after-d1-create"].includes(mode))return ["Invalid inspection mode"];
  if (inventory.workers.includes(STAGING.entry) ||
      inventory.workers.includes(STAGING.mock)) {
    issues.push("Staging Worker name already exists; refuse potential overwrite");
  }
  const stageDatabases=inventory.databases.filter(x=>x.name===STAGING.d1);
  if(mode==="before-create" && stageDatabases.length) {
    issues.push("Staging D1 name already exists; use a separate checked lifecycle");
  }
  if(mode==="after-d1-create") {
    if(!UUID.test(candidateId||"") || stageDatabases.length!==1 ||
       stageDatabases[0].id!==candidateId.toLowerCase()) {
      issues.push("New isolated D1 identity is not verified");
    }
  }
  const ids = new Set(inventory.databases.map(x=>x.id));
  const productionIds=new Set();
  for (const [worker, bindings] of Object.entries(inventory.prodBindings)) {
    for (const b of bindings) {
      if(b.type==="d1") {
        if(!UUID.test(b.id||""))issues.push("Production D1 binding malformed: "+worker);
        else productionIds.add(b.id.toLowerCase());
      }
    }
  }
  if(!inventory.workers.includes("waffopay")||!inventory.workers.includes("ai")) {
    issues.push("Production inventory baseline missing");
  }
  const liveWaffo = inventory.prodBindings.waffopay;
  if(!liveWaffo.some(x=>x.type==="d1"&&x.name==="WAFFO_PRODUCTION_LEDGER"&&
       String(x.id).toLowerCase()===STAGING.liveWaffoD1) ||
     !ids.has(STAGING.liveWaffoD1)) {
    issues.push("Production Waffo D1 reviewed ID has drifted or vanished");
  }
  if(!liveWaffo.some(x=>x.type==="service"&&x.name==="WAFFO_IDENTITY_SERVICE"&&
       x.service==="ai"&&x.environment==="production")) {
    issues.push("Production Waffo service baseline cannot be verified");
  }
  if(mode==="after-d1-create" && UUID.test(candidateId||"") &&
      productionIds.has(candidateId.toLowerCase())) {
    issues.push("Staging D1 overlaps production Worker binding");
  }
  return issues;
}

export async function inspectCloudPreprod({
  accountId,token,mode="before-create",candidateId,fetchImpl=globalThis.fetch,
}) {
  if(!ACCOUNT.test(accountId||""))throw new Error("Invalid Cloudflare account");
  if(typeof token!=="string"||!token.trim())throw new Error("Dedicated read-only Cloudflare API token required");
  if(mode!=="before-create"&&mode!=="after-d1-create")throw new Error("Invalid inspection mode");
  if(mode==="after-d1-create"&&!UUID.test(candidateId||""))throw new Error("New D1 UUID required");
  if(typeof fetchImpl!=="function")throw new Error("Fetch unavailable");
  const inventory=await listInventory(fetchImpl,token,accountId);
  const issues=checkCloudPreprodIsolation(inventory,mode,candidateId);
  return {
    passed:issues.length===0,
    issues,
    // Return only safe metadata and counts. Never echo token or binding values.
    counts:{workers:inventory.workers.length,d1:inventory.databases.length},
    staging:{workerExists:inventory.workers.includes(STAGING.entry),
      mockExists:inventory.workers.includes(STAGING.mock),
      d1Exists:inventory.databases.some(x=>x.name===STAGING.d1)},
  };
}

export async function main(argv=process.argv.slice(2),env=process.env) {
  if(argv.length!==1 || !["before-create","after-d1-create"].includes(argv[0])) {
    throw new Error("Usage: cloud-preprod-isolation-preflight.mjs before-create|after-d1-create");
  }
  const report=await inspectCloudPreprod({
    accountId:env.CLOUDFLARE_ACCOUNT_ID,token:env.CLOUDFLARE_API_TOKEN,
    mode:argv[0],candidateId:env.WAFFO_PREPROD_D1_ID,
  });
  process.stdout.write("READ-ONLY Cloudflare inventory: "+report.counts.workers+
    " Workers, "+report.counts.d1+" D1 databases.\n");
  if(!report.passed) {
    for(const issue of report.issues)process.stderr.write("[BLOCKED] "+issue+"\n");
    process.exitCode=2;
  }else {
    process.stdout.write("PASS: staging isolation inventory matches the requested pre-create checkpoint.\n");
    process.stdout.write("No Cloudflare resources were created or changed.\n");
  }
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])) {
  main().catch(error=>{
    const allowed=String(error?.message||"").replace(/[A-Za-z0-9+_\/=-]{65,}/g,"[masked]").slice(0,130);
    process.stderr.write("[BLOCKED] "+allowed+"\n");
    process.exitCode=2;
  });
}
