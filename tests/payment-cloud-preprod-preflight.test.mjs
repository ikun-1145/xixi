import test from "node:test";
import assert from "node:assert/strict";
import { inspectCloudPreprod, checkCloudPreprodIsolation } from "../scripts/reliability/cloud-preprod-isolation-preflight.mjs";

const account = "a".repeat(32);
const token = "synthetic-readonly-token-not-real";
const LIVE_D1 = "9003f99a-bcef-4ba5-a961-33c399a01ab5";
const NEW_D1 = "11111111-1111-4111-8111-111111111111";
const WORKERS = ["ai","waffopay","afdianpay","other-staging"];
const base = () => ({
  workers: [...WORKERS],
  databases:[{name:"waffo-production-observation-ledger",id:LIVE_D1}],
  prodBindings:{
    waffopay:[
      {type:"d1",name:"WAFFO_PRODUCTION_LEDGER",id:LIVE_D1},
      {type:"service",name:"WAFFO_IDENTITY_SERVICE",service:"ai",environment:"production"},
    ],
    afdianpay:[{type:"service",name:"AFDIAN_IDENTITY_SERVICE",service:"ai",environment:"production"}],
    ai:[],
  },
});

function cloudFake(inventory=base(),options={}) {
  const calls=[];
  const fetchImpl=async (url,init) => {
    calls.push({url,init});
    assert.equal(init.method,"GET","preflight must never write Cloudflare");
    assert.equal(init.headers.Authorization,"Bearer "+token);
    assert.ok(url.startsWith("https://api.cloudflare.com/client/v4/accounts/"+account+"/"));
    const path=url.split("/accounts/"+account)[1];
    if(options.status)return new Response("SENSITIVE_DO_NOT_LOG",{status:options.status});
    let result, info;
    if(path==="/workers/scripts")result=inventory.workers.map(id=>({id}));
    else if(path.startsWith("/d1/database?")) {
      const page=Number(new URL(url).searchParams.get("page"));
      const per=Number(new URL(url).searchParams.get("per_page"));
      assert.equal(per,100);
      const slice=inventory.databases.slice((page-1)*100,page*100);
      result=slice.map(db=>({name:db.name,uuid:db.id}));
      info={page,per_page:per,total_count:inventory.databases.length,count:slice.length};
    } else if(path.startsWith("/workers/scripts/")&&path.endsWith("/settings")) {
      const name=path.slice("/workers/scripts/".length,-"/settings".length);
      result={bindings:inventory.prodBindings[name]};
    } else assert.fail("Unexpected read-only Cloudflare endpoint: "+path);
    if(options.malformedD1 && path.startsWith("/d1/database"))info=null;
    return Response.json({success:true,result,...(info?{result_info:info}:{})});
  };
  return {calls,fetchImpl};
}

test("before-create verifies existing production, denies writes and absent staging names",async()=>{
  const remote=cloudFake();
  const result=await inspectCloudPreprod({accountId:account,token,fetchImpl:remote.fetchImpl});
  assert.equal(result.passed,true);
  assert.deepEqual(result.counts,{workers:4,d1:1});
  assert.deepEqual(result.staging,{workerExists:false,mockExists:false,d1Exists:false});
  assert.equal(remote.calls.length,5);
  assert.ok(remote.calls.every(x=>x.init.method==="GET"));
  assert.doesNotMatch(JSON.stringify(result),/synthetic-readonly-token|SENSITIVE_DO_NOT_LOG/);
});

test("D1 after-create checkpoint only passes with exact dedicated non-production UUID",async()=>{
  const inventory=base();
  inventory.databases.push({name:"waffopay-preprod-ledger-isolated",id:NEW_D1});
  const remote=cloudFake(inventory);
  const result=await inspectCloudPreprod({
    accountId:account,token,mode:"after-d1-create",candidateId:NEW_D1,fetchImpl:remote.fetchImpl,
  });
  assert.equal(result.passed,true);
  const wrong=await inspectCloudPreprod({
    accountId:account,token,mode:"after-d1-create",candidateId:LIVE_D1,fetchImpl:remote.fetchImpl,
  });
  assert.equal(wrong.passed,false);
  assert.match(wrong.issues.join(";"),/identity|overlaps/);
  assert.ok(checkCloudPreprodIsolation(inventory,"before-create").some(x=>x.includes("Staging D1")));
});

test("staging Worker existence blocks even when D1 is isolated",()=>{
  const x=base();
  x.workers.push("waffopay-preprod-mock");
  assert.ok(checkCloudPreprodIsolation(x,"before-create").some(v=>v.includes("Worker name")));
  x.workers.push("waffopay-preprod-isolated");
  assert.ok(checkCloudPreprodIsolation(x,"after-d1-create",NEW_D1).some(v=>v.includes("Worker name")));
});

test("production D1 baseline and identity service target drift block the check",()=>{
  const x=base();
  x.prodBindings.waffopay[0].id=NEW_D1;
  assert.ok(checkCloudPreprodIsolation(x,"before-create").some(v=>v.includes("D1 baseline")));
  const y=base();
  y.prodBindings.waffopay[1].service="waffopay-preprod-mock";
  assert.ok(checkCloudPreprodIsolation(y,"before-create").some(v=>v.includes("service baseline")));
});

test("large D1 inventory exhaustively checks pagination instead of trusting first page",async()=>{
  const x=base();
  for(let i=0;i<145;i++){
    const id=i.toString(16).padStart(12,"0");
    x.databases.push({name:"synthetic-db-"+i,id:"11111111-1111-4111-8111-"+id});
  }
  const remote=cloudFake(x);
  const result=await inspectCloudPreprod({accountId:account,token,fetchImpl:remote.fetchImpl});
  assert.equal(result.passed,true);
  assert.equal(result.counts.d1,146);
  assert.equal(remote.calls.filter(x=>x.url.includes("/d1/database?")).length,2);
});

test("malformed inventory, missing permission, incomplete paging always block",async()=>{
  await assert.rejects(inspectCloudPreprod({accountId:account,token:""}),/token required/);
  await assert.rejects(inspectCloudPreprod({accountId:"bad",token}),/account/);
  await assert.rejects(inspectCloudPreprod({accountId:account,token,mode:"after-d1-create",candidateId:"bad"}),/UUID/);
  const noPermission=cloudFake(base(),{status:403});
  await assert.rejects(inspectCloudPreprod({accountId:account,token,fetchImpl:noPermission.fetchImpl}),
    error=>/HTTP 403/.test(error.message) && !error.message.includes("SENSITIVE"));
  const noPage=cloudFake(base(),{malformedD1:true});
  await assert.rejects(inspectCloudPreprod({accountId:account,token,fetchImpl:noPage.fetchImpl}),/pagination unverified/);
});

test("inventory never calls unapproved endpoints, even with suspicious staging identifiers",async()=>{
  const x=base();
  x.workers.push("waffopay-preprod-isolated");
  x.databases.push({name:"waffopay-preprod-ledger-isolated",id:LIVE_D1});
  // Duplicated ID must fail closed rather than accepting name-based "isolation".
  await assert.rejects(inspectCloudPreprod({accountId:account,token,fetchImpl:cloudFake(x).fetchImpl}),
    /Duplicate D1 inventory/);
  assert.deepEqual(checkCloudPreprodIsolation(null,"before-create"),["Incomplete Cloudflare inventory"]);
  assert.deepEqual(checkCloudPreprodIsolation(base(),"invalid"),["Invalid inspection mode"]);
});
