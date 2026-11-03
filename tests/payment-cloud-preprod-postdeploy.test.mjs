import test from "node:test";
import assert from "node:assert/strict";
import {
  auditDeployedCloudPreprod,validateDeployedCloudPreprod,
} from "../scripts/reliability/cloud-preprod-postdeploy-audit.mjs";

const account="a".repeat(32);
const zone="b".repeat(32);
const d1="11111111-1111-4111-8111-111111111111";
const liveD1="9003f99a-bcef-4ba5-a961-33c399a01ab5";
const token="synthetic-readonly-cloud-token-not-real";
const entry="waffopay-preprod-isolated",mock="waffopay-preprod-mock";
const flags={
  WAFFO_PREPROD_ISOLATED:"true",
  WAFFO_ENVIRONMENT:"test",
  WAFFO_PRODUCTION_ENABLED:"true",
  WAFFO_PRODUCTION_ENTITLEMENT_ENABLED:"false",
  WAFFO_PROD_MERCHANT_ID:"MER_PREPROD1",
  WAFFO_PROD_STORE_ID:"STO_PREPROD1",
  WAFFO_PROD_PRODUCT_ID:"PROD_PREPROD1",
};
const secretNames=[
  "WAFFO_PREPROD_GATE_TOKEN","WAFFO_PREPROD_SIGNING_KEY",
  "WAFFO_PREPROD_RPC_TEST_KEY","WAFFO_WEBHOOK_PUBLIC_KEY_PROD",
  "WAFFO_WEBHOOK_PUBLIC_KEY_TEST",
];
function healthySnapshot() {
  const bindings=[
    ...Object.entries(flags).map(([name,text])=>({name,type:"plain_text",text})),
    ...secretNames.map(name=>({name,type:"secret_text"})),
    {name:"WAFFO_PRODUCTION_LEDGER",type:"d1",id:d1},
    {name:"WAFFO_PREPROD_PROVIDER",type:"service",service:mock},
    {name:"WAFFO_PREPROD_RPC",type:"service",service:mock},
  ];
  const make=(arr)=>({
    subdomain:{enabled:false,previews_enabled:false},
    schedules:[],
    settings:{compatibility_date:"2026-09-05",bindings:arr},
    deployment:{versions:[{version_id:"synthetic-version",percentage:100}]},
  });
  return {
    database:{name:"waffopay-preprod-ledger-isolated",uuid:d1},
    domains:[{service:"unrelated-worker"}],
    zones:[{routes:[{script:"unrelated-worker"}]}],
    workers:{[entry]:make(bindings),[mock]:make([])},
  };
}

function fakeApi(snapshot=healthySnapshot(),override={}) {
  const calls=[];
  const fetchImpl=async (url,init)=>{
    calls.push({url,method:init.method});
    assert.equal(init.method,"GET");
    assert.equal(init.headers.Authorization,"Bearer "+token);
    assert.ok(url.startsWith("https://api.cloudflare.com/client/v4/"));
    const path=url.replace("https://api.cloudflare.com/client/v4","");
    if(override.status)return new Response("PRODUCTION_SECRET_NOT_FOR_LOGS",{status:override.status});
    let result,result_info;
    if(path==="/accounts/"+account+"/d1/database/"+d1)result=snapshot.database;
    else if(path.startsWith("/accounts/"+account+"/workers/domains?")){
      result=snapshot.domains; result_info={page:1,per_page:100,total_count:result.length};
    }else if(path.startsWith("/zones?")){
      result=snapshot.zones.map(()=>({id:zone}));
      result_info={page:1,per_page:100,total_count:result.length};
    }else if(path==="/zones/"+zone+"/workers/routes")result=snapshot.zones[0].routes;
    else {
      const hit=[entry,mock].find(name=>path.startsWith("/accounts/"+account+"/workers/scripts/"+name+"/"));
      assert.ok(hit,"Unexpected cloud endpoint: "+path);
      const suffix=path.slice(("/accounts/"+account+"/workers/scripts/"+hit+"/").length);
      const worker=snapshot.workers[hit];
      if(suffix==="subdomain")result=worker.subdomain;
      else if(suffix==="schedules")result={schedules:worker.schedules};
      else if(suffix==="settings")result=worker.settings;
      else if(suffix==="deployments?page=1&per_page=1")result={deployments:[worker.deployment]};
      else assert.fail("Unexpected read endpoint: "+suffix);
    }
    if(override.incompleteDomain && path.startsWith("/accounts/"+account+"/workers/domains?"))
      result_info=undefined;
    return Response.json({success:true,result,...(result_info?{result_info}:{})});
  };
  return {calls,fetchImpl};
}

test("strict postdeploy audit passes only with two isolated Workers and full GET inventory",async()=>{
  const remote=fakeApi();
  const r=await auditDeployedCloudPreprod({accountId:account,apiToken:token,d1Id:d1,fetchImpl:remote.fetchImpl});
  assert.equal(r.passed,true);
  assert.deepEqual(r.issues,[]);
  assert.equal(r.checkedWorkers,2);
  assert.equal(r.checkedZones,1);
  assert.equal(remote.calls.length,12);
  assert.ok(remote.calls.every(x=>x.method==="GET"));
  assert.doesNotMatch(JSON.stringify(r),/synthetic-readonly|PRODUCTION_SECRET/);
});

test("workers.dev and preview/version URLs independently block",()=>{
  for(const name of [entry,mock]){
    for(const field of ["enabled","previews_enabled"]){
      const s=healthySnapshot();
      s.workers[name].subdomain[field]=true;
      assert.ok(validateDeployedCloudPreprod(s,d1).some(x=>x.includes("URL is enabled")));
      delete s.workers[name].subdomain[field];
      assert.ok(validateDeployedCloudPreprod(s,d1).some(x=>x.includes("URL is enabled")));
    }
  }
});

test("zone routes, custom domains, Cron and deployment splits block",()=>{
  const a=healthySnapshot();a.zones[0].routes.push({script:entry});
  assert.ok(validateDeployedCloudPreprod(a,d1).some(x=>x.includes("zone route")));
  const b=healthySnapshot();b.domains.push({service:mock});
  assert.ok(validateDeployedCloudPreprod(b,d1).some(x=>x.includes("custom domain")));
  const c=healthySnapshot();c.workers[entry].schedules=[{cron:"* * * * *"}];
  assert.ok(validateDeployedCloudPreprod(c,d1).some(x=>x.includes("Cron")));
  const d=healthySnapshot();
  d.workers[entry].deployment.versions=[{version_id:"old",percentage:50},{version_id:"new",percentage:50}];
  assert.ok(validateDeployedCloudPreprod(d,d1).some(x=>x.includes("100%")));
});

test("wrong D1, production D1, modified service and extra secrets block",()=>{
  const a=healthySnapshot();
  a.workers[entry].settings.bindings.find(x=>x.type==="d1").id=liveD1;
  assert.ok(validateDeployedCloudPreprod(a,d1).some(x=>x.includes("not the isolated")));
  assert.deepEqual(validateDeployedCloudPreprod(healthySnapshot(),liveD1),["Unapproved or production D1 UUID"]);
  const b=healthySnapshot();b.workers[entry].settings.bindings.find(x=>x.name==="WAFFO_PREPROD_RPC").service="ai";
  assert.ok(validateDeployedCloudPreprod(b,d1).some(x=>x.includes("isolated Mock")));
  const c=healthySnapshot();c.workers[entry].settings.bindings.push({name:"WAFFO_PRODUCTION_SERVICE_ROLE_KEY",type:"secret_text"});
  assert.ok(validateDeployedCloudPreprod(c,d1).some(x=>x.includes("unexpected binding")));
  const d=healthySnapshot();d.workers[entry].settings.bindings.find(x=>x.name==="WAFFO_PRODUCTION_ENTITLEMENT_ENABLED").text="true";
  assert.ok(validateDeployedCloudPreprod(d,d1).some(x=>x.includes("mode flag")));
  const e=healthySnapshot();e.workers[entry].settings.bindings.find(x=>x.name==="WAFFO_PREPROD_GATE_TOKEN").type="plain_text";
  assert.ok(validateDeployedCloudPreprod(e,d1).some(x=>x.includes("wrong binding type")));
  const f=healthySnapshot();f.database.name="waffo-production-observation-ledger";
  assert.ok(validateDeployedCloudPreprod(f,d1).some(x=>x.includes("mismatched")));
});

test("missing permissions or incomplete domain paging fail closed without leaking body",async()=>{
  await assert.rejects(auditDeployedCloudPreprod({accountId:"invalid",apiToken:token,d1Id:d1}),/account/);
  await assert.rejects(auditDeployedCloudPreprod({accountId:account,apiToken:"",d1Id:d1}),/read-only token/);
  await assert.rejects(auditDeployedCloudPreprod({accountId:account,apiToken:token,d1Id:liveD1}),/non-production D1/);
  const denied=fakeApi(healthySnapshot(),{status:403});
  await assert.rejects(auditDeployedCloudPreprod({accountId:account,apiToken:token,d1Id:d1,fetchImpl:denied.fetchImpl}),
    err=>/HTTP 403/.test(err.message)&&!err.message.includes("PRODUCTION_SECRET"));
  const incomplete=fakeApi(healthySnapshot(),{incompleteDomain:true});
  await assert.rejects(auditDeployedCloudPreprod({accountId:account,apiToken:token,d1Id:d1,fetchImpl:incomplete.fetchImpl}),/pagination/);
});
