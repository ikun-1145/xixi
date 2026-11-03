/**
 * Read-only post-deployment safety audit for the TWO isolated Waffo Workers.
 *
 * This does not deploy, mutate D1, invoke webhooks, or read any secret values.
 * It deliberately requires broader GET-only permissions (zones/routes/domains).
 * Missing permissions or incomplete inventory => BLOCKED.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ACCOUNT=/^[a-f0-9]{32}$/;
const ENTRY="waffopay-preprod-isolated";
const MOCK="waffopay-preprod-mock";
const D1_NAME="waffopay-preprod-ledger-isolated";
const PROD_D1="9003f99a-bcef-4ba5-a961-33c399a01ab5";
const EXPECTED_VARS=Object.freeze({
  WAFFO_PREPROD_ISOLATED:"true",
  WAFFO_ENVIRONMENT:"test",
  WAFFO_PRODUCTION_ENABLED:"true",
  WAFFO_PRODUCTION_ENTITLEMENT_ENABLED:"false",
  WAFFO_PROD_MERCHANT_ID:"MER_PREPROD1",
  WAFFO_PROD_STORE_ID:"STO_PREPROD1",
  WAFFO_PROD_PRODUCT_ID:"PROD_PREPROD1",
});
const EXPECTED_SECRETS=Object.freeze([
  "WAFFO_PREPROD_GATE_TOKEN",
  "WAFFO_PREPROD_SIGNING_KEY",
  "WAFFO_PREPROD_RPC_TEST_KEY",
  "WAFFO_WEBHOOK_PUBLIC_KEY_PROD",
  "WAFFO_WEBHOOK_PUBLIC_KEY_TEST",
]);

async function get(fetchImpl, token, path) {
  let res;
  try {
    res=await fetchImpl("https://api.cloudflare.com/client/v4"+path,{
      method:"GET",headers:{Authorization:"Bearer "+token},
      signal:AbortSignal.timeout(15_000),
    });
  } catch {throw new Error("GET-only Cloudflare inspection failed");}
  if(!res?.ok)throw new Error("Cloudflare read-only inspection HTTP "+(res?.status??"unknown"));
  let value;
  try{value=await res.json();}catch{throw new Error("Cloudflare inspection invalid JSON");}
  if(value?.success!==true||value.result===undefined)throw new Error("Cloudflare inspection incomplete response");
  return value;
}

async function listPages(fetchImpl,token,path,{perPage=100,maxPages=20}={}) {
  const items=[];
  for(let page=1;page<=maxPages;page++){
    const delimiter=path.includes("?")?"&":"?";
    const data=await get(fetchImpl,token,path+delimiter+"page="+page+"&per_page="+perPage);
    if(!Array.isArray(data.result)||!Number.isInteger(data.result_info?.total_count)||
       data.result_info?.page!==page)throw new Error("Cloudflare inventory pagination incomplete");
    items.push(...data.result);
    if(items.length===data.result_info.total_count)return items;
    if(items.length>data.result_info.total_count||data.result.length===0)
      throw new Error("Cloudflare inventory count mismatch");
  }
  throw new Error("Cloudflare inventory exceeded audited limit");
}

function bindingMap(bindings,worker,issues) {
  if(!Array.isArray(bindings)){issues.push(worker+": bindings unavailable");return null;}
  const result=new Map();
  for(const b of bindings) {
    if(typeof b?.name!=="string"||typeof b?.type!=="string"||result.has(b.name)) {
      issues.push(worker+": malformed or duplicated binding");
      continue;
    }
    result.set(b.name,b);
  }
  return result;
}

function checkBindings(settings,name,d1Id,issues) {
  const bindings=bindingMap(settings?.bindings,name,issues);
  if(!bindings)return;
  const expect=new Map();
  if(name===ENTRY) {
    for(const key of Object.keys(EXPECTED_VARS))expect.set(key,"plain_text");
    for(const key of EXPECTED_SECRETS)expect.set(key,"secret_text");
    expect.set("WAFFO_PRODUCTION_LEDGER","d1");
    expect.set("WAFFO_PREPROD_PROVIDER","service");
    expect.set("WAFFO_PREPROD_RPC","service");
  }
  for(const [key,kind] of expect) {
    const b=bindings.get(key);
    if(b?.type!==kind){issues.push(name+": missing or wrong binding type "+key);continue;}
    if(kind==="plain_text" && b.text!==EXPECTED_VARS[key])
      issues.push(name+": non-secret mode flag differs "+key);
    if(kind==="d1" && String(b.id).toLowerCase()!==d1Id)
      issues.push(name+": D1 binding is not the isolated database");
    if(kind==="service" && (b.service!==MOCK || (b.environment && b.environment!=="production")))
      issues.push(name+": Service Binding no longer targets isolated Mock");
  }
  for(const key of bindings.keys()) {
    if(!expect.has(key))issues.push(name+": unexpected binding "+key);
  }
}

export function validateDeployedCloudPreprod(snapshot,d1Id) {
  const issues=[];
  if(!UUID.test(d1Id||"") || d1Id.toLowerCase()===PROD_D1)
    return ["Unapproved or production D1 UUID"];
  if(!snapshot || !Array.isArray(snapshot.domains) || !Array.isArray(snapshot.zones) ||
     !snapshot.workers || snapshot.database?.uuid?.toLowerCase()!==d1Id.toLowerCase() ||
     snapshot.database?.name!==D1_NAME)return ["Incomplete or mismatched staging resource inventory"];
  for(const d of snapshot.domains) {
    if([ENTRY,MOCK].includes(d?.service))
      issues.push("Staging Worker is routed through a custom domain");
  }
  for(const zone of snapshot.zones) {
    if(!Array.isArray(zone.routes)){
      issues.push("Cannot verify every Worker route in zone");continue;
    }
    if(zone.routes.some(r=>[ENTRY,MOCK].includes(r?.script)))
      issues.push("Staging Worker has public zone route");
  }
  for(const name of [ENTRY,MOCK]) {
    const w=snapshot.workers[name];
    if(!w){issues.push(name+": missing Worker inspection data");continue;}
    if(w.subdomain?.enabled!==false || w.subdomain?.previews_enabled!==false)
      issues.push(name+": workers.dev or version/preview URL is enabled or unverified");
    if(!Array.isArray(w.schedules)||w.schedules.length!==0)
      issues.push(name+": Cron trigger is enabled or unverified");
    const versions=w.deployment?.versions;
    if(!Array.isArray(versions) || versions.length!==1 ||
       versions[0].percentage!==100 || !versions[0].version_id)
      issues.push(name+": deployed version is not a single verified 100% version");
    if(w.settings?.compatibility_date!=="2026-09-05")
      issues.push(name+": compatibility date differs from tested runtime");
    checkBindings(w.settings,name,d1Id.toLowerCase(),issues);
  }
  return issues;
}

export async function auditDeployedCloudPreprod({
  accountId,apiToken,d1Id,fetchImpl=globalThis.fetch,
}) {
  if(!ACCOUNT.test(accountId||""))throw new Error("Invalid Cloudflare account ID");
  if(typeof apiToken!=="string"||!apiToken.trim())throw new Error("Dedicated read-only token required");
  if(!UUID.test(d1Id||"")||d1Id.toLowerCase()===PROD_D1)
    throw new Error("Dedicated non-production D1 UUID required");
  if(typeof fetchImpl!=="function")throw new Error("Fetch unavailable");
  const a="/accounts/"+accountId;
  const database=(await get(fetchImpl,apiToken,a+"/d1/database/"+d1Id)).result;
  const domains=await listPages(fetchImpl,apiToken,a+"/workers/domains");
  const zoneList=await listPages(fetchImpl,apiToken,"/zones?account.id="+accountId);
  const zones=[];
  for(const zone of zoneList) {
    if(!/^[a-f0-9]{32}$/i.test(zone?.id||""))throw new Error("Malformed Cloudflare zone inventory");
    const routes=(await get(fetchImpl,apiToken,"/zones/"+zone.id+"/workers/routes")).result;
    if(!Array.isArray(routes))throw new Error("Unable to verify zone routes");
    zones.push({routes:routes.map(x=>({script:x.script}))});
  }
  const workers={};
  for(const name of [ENTRY,MOCK]) {
    const base=a+"/workers/scripts/"+name;
    const [subdomain,schedules,settings,deployments]=await Promise.all([
      get(fetchImpl,apiToken,base+"/subdomain"),
      get(fetchImpl,apiToken,base+"/schedules"),
      get(fetchImpl,apiToken,base+"/settings"),
      get(fetchImpl,apiToken,base+"/deployments?page=1&per_page=1"),
    ]);
    const rawSchedules=Array.isArray(schedules.result)?schedules.result:schedules.result?.schedules;
    workers[name]={
      subdomain:subdomain.result,
      schedules:rawSchedules,
      settings:settings.result,
      deployment:deployments.result?.deployments?.[0],
    };
  }
  const issues=validateDeployedCloudPreprod({
    database,domains:domains.map(x=>({service:x.service})),zones,workers,
  },d1Id);
  return {passed:issues.length===0,issues,
    checkedWorkers:2,checkedZones:zones.length,checkedDomains:domains.length};
}

async function main(argv=process.argv.slice(2),env=process.env) {
  if(argv.length)throw new Error("Usage: cloud-preprod-postdeploy-audit.mjs");
  const result=await auditDeployedCloudPreprod({
    accountId:env.CLOUDFLARE_ACCOUNT_ID,
    apiToken:env.CLOUDFLARE_API_TOKEN,
    d1Id:env.WAFFO_PREPROD_D1_ID,
  });
  process.stdout.write("GET-only postdeploy audit: "+result.checkedWorkers+
    " Workers, "+result.checkedZones+" zones, "+result.checkedDomains+" domains inspected.\n");
  if(!result.passed){
    for(const issue of result.issues)process.stderr.write("[BLOCKED] "+issue+"\n");
    process.exitCode=2;
    return;
  }
  process.stdout.write("PASS: isolated Cloudflare staging bindings, no public routes or Cron.\n");
  process.stdout.write("This does NOT prove payment E2E or authorize any deployment.\n");
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
  main().catch(error=>{
    process.stderr.write("[BLOCKED] "+String(error?.message||"audit failed")
      .replace(/[A-Za-z0-9+_\/=-]{65,}/g,"[masked]").slice(0,160)+"\n");
    process.exitCode=2;
  });
}
