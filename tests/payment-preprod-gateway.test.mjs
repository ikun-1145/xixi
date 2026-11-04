import test from "node:test";
import assert from "node:assert/strict";
import gateway,{gatewayConfigured} from "../workers/waffopay/preprod-gateway-proposal.js";

const AUD="z".repeat(40);
const TOKEN="synthetic-preprod-internal-token-1234567890";
const ctx={access:{aud:AUD,async getIdentity(){return {email:"operator@example.invalid"};}}};
const baseEnv=()=>({
  WAFFO_PREPROD_GATEWAY_ENABLED:"true",
  WAFFO_PREPROD_ISOLATED:"true",
  WAFFO_PREPROD_ENTITLEMENTS_ENABLED:"false",
  WAFFO_PREPROD_ACCESS_AUD:AUD,
  WAFFO_PREPROD_GATE_TOKEN:TOKEN,
  WAFFO_PREPROD_ALLOW_WEBHOOK:"true",
  WAFFO_PREPROD_ALLOW_CRON:"false",
  WAFFO_PREPROD_TARGET:{fetch:async()=>Response.json({
    ok:true,mode:"isolated",entitlements:false,automaticCron:false,
  })},
});
const req=(path="/__preprod/health",options)=>new Request("https://gateway.example.invalid"+path,options);
async function run(path,options,env=baseEnv(),context=ctx){
  const response=await gateway.fetch(req(path,options),env,context);
  return {response,data:await response.json()};
}
const signature="t=1234567890123,v1="+"A".repeat(344);

test("gateway is disabled without all isolation flags and private binding",async()=>{
  assert.equal(gatewayConfigured(baseEnv()),true);
  for(const [key,value] of [
    ["WAFFO_PREPROD_GATEWAY_ENABLED","false"],
    ["WAFFO_PREPROD_ISOLATED","false"],
    ["WAFFO_PREPROD_ENTITLEMENTS_ENABLED","true"],
    ["WAFFO_PREPROD_ACCESS_AUD","short"],
    ["WAFFO_PREPROD_GATE_TOKEN","short"],
    ["WAFFO_PREPROD_TARGET",null],
    ["WAFFO_PRODUCTION_SERVICE_ROLE_KEY","real"],
    ["WAFFO_PRIVATE_KEY_PRODUCTION","real"],
    ["WAFFO_IDENTITY_SERVICE",{fetch(){}}],
    ["WAFFO_PRODUCTION_LEDGER",{prepare(){}}],
  ]) {
    const env={...baseEnv(),[key]:value};
    assert.equal(gatewayConfigured(env),false,key);
    const {response}=await run("/__preprod/health",{},env);
    assert.equal(response.status,503,key);
  }
});

test("Cloudflare Access context must be present, verified, and match exact audience",async()=>{
  const env=baseEnv();
  const missingCtx=await gateway.fetch(req("/__preprod/health"),env,undefined);
  assert.equal(missingCtx.status,403);
  for(const invalid of [
    null,{}, {access:{aud:"other",getIdentity:async()=>({email:"admin@example.invalid"})}},
    {access:{aud:AUD}}, {access:{aud:AUD,getIdentity:async()=>null}},
    {access:{aud:AUD,getIdentity:async()=>({email:""})}},
    {access:{aud:AUD,getIdentity:async()=>{throw Error("denied")}}},
  ]) {
    const {response}=await run("/__preprod/health",{},env,invalid);
    assert.equal(response.status,403);
  }
  // This is just an untrusted header, NOT a platform-provided Access identity.
  const attack=await gateway.fetch(req("/__preprod/health",{
    headers:{"Cf-Access-Jwt-Assertion":"forged-jwt","X-User-Email":"admin@example.invalid"},
  }),env,{});
  assert.equal(attack.status,403);
});

test("request path, query, method and unapproved Cron fail before private binding",async()=>{
  let calls=0;
  const env=baseEnv();env.WAFFO_PREPROD_TARGET.fetch=async()=>{calls++;return Response.json({ok:true});};
  for(const [path,options,status] of [
    ["/checkout/waffo",{},404],
    ["/__preprod/health?inject=yes",{},404],
    ["/__preprod/health",{method:"POST"},404],
    ["/__preprod/webhook",{method:"GET"},404],
    ["/__preprod/cron",{method:"POST"},403],
    ["/__preprod/cron",{method:"POST",body:"payload"},403],
  ]) {
    const r=await run(path,options,env);
    assert.equal(r.response.status,status,path);
  }
  assert.equal(calls,0);
});

test("valid health is relayed only via private binding and strips client headers",async()=>{
  const requests=[];
  const env=baseEnv();
  env.WAFFO_PREPROD_TARGET.fetch=async req=>{
    requests.push(req);
    return Response.json({ok:true,mode:"isolated",entitlements:false,
      automaticCron:false,secret:"DO_NOT_EXPOSE",user_id:"sensitive"});
  };
  const {response,data}=await run("/__preprod/health",{
    headers:{Authorization:"Bearer user",Cookie:"session=secret",
      "Cf-Access-Jwt-Assertion":"forged","X-Preprod-Test-Token":"malicious",
      "X-Payment-Reference":"do-not-relay"},
  },env);
  assert.equal(response.status,200);
  assert.deepEqual(data,{ok:true,mode:"isolated",entitlements:false,automaticCron:false});
  assert.equal(requests.length,1);
  assert.equal(requests[0].url,"https://preprod-private.invalid/__preprod/health");
  assert.equal(requests[0].headers.get("X-Preprod-Test-Token"),TOKEN);
  for(const name of ["Authorization","Cookie","Cf-Access-Jwt-Assertion","X-Payment-Reference"])
    assert.equal(requests[0].headers.has(name),false);
  assert.equal(response.headers.get("cache-control"),"no-store");
});

test("manual webhook requires explicit opt-in before Service Binding",async()=>{
  const env=baseEnv();
  let calls=0;
  env.WAFFO_PREPROD_TARGET.fetch=async()=>{calls++;return Response.json({ok:true});};
  for(const flag of [undefined,"false",null]){
    env.WAFFO_PREPROD_ALLOW_WEBHOOK=flag;
    const r=await run("/__preprod/webhook",{
      method:"POST",
      headers:{"content-type":"application/json","x-waffo-signature":signature},
      body:"{}",
    },env);
    assert.equal(r.response.status,403);
    assert.deepEqual(r.data,{ok:false,reason:"manual_webhook_disabled"});
  }
  assert.equal(calls,0);
});

test("signed webhook forwards byte-identical body, never exposes private response fields",async()=>{
  const payload=JSON.stringify({eventId:"synthetic-1",data:{nothing:"sensitive"}});
  const forwarded=[];
  const env=baseEnv();
  env.WAFFO_PREPROD_TARGET.fetch=async req=>{
    forwarded.push({url:req.url,headers:req.headers,body:await req.text()});
    return Response.json({status:"recorded",real_payment_token:"NEVER_EXPOSED"});
  };
  const {response,data}=await run("/__preprod/webhook",{
    method:"POST",headers:{"content-type":"application/json",
      "x-waffo-signature":signature,Authorization:"Basic forbidden",
      "Cf-Access-Jwt-Assertion":"untrusted"},
    body:payload,
  },env);
  assert.equal(response.status,200);
  assert.deepEqual(data,{ok:true,syntheticOnly:true});
  assert.equal(forwarded.length,1);
  assert.equal(forwarded[0].body,payload);
  assert.equal(forwarded[0].headers.get("x-waffo-signature"),signature);
  assert.equal(forwarded[0].headers.has("authorization"),false);
  assert.equal(forwarded[0].url,"https://preprod-private.invalid/__preprod/webhook");
});

test("missing signature, JSON content type or oversized body fail closed",async()=>{
  let calls=0;
  const env=baseEnv();env.WAFFO_PREPROD_TARGET.fetch=async()=>{calls++;return Response.json({ok:true});};
  for(const options of [
    {method:"POST",headers:{"content-type":"application/json"},body:"{}"},
    {method:"POST",headers:{"content-type":"text/plain","x-waffo-signature":signature},body:"{}"},
    {method:"POST",headers:{"content-type":"application/json","x-waffo-signature":"fake"},body:"{}"},
    {method:"POST",headers:{"content-type":"application/json","x-waffo-signature":signature},
      body:"x".repeat(16385)},
  ]) {
    const r=await run("/__preprod/webhook",options,env);
    assert.ok([400,413].includes(r.response.status));
  }
  assert.equal(calls,0);
});

test("Cron needs explicit second opt-in and only returns approved counters",async()=>{
  const env=baseEnv();env.WAFFO_PREPROD_ALLOW_CRON="true";
  let calls=0;
  env.WAFFO_PREPROD_TARGET.fetch=async(req)=>{
    calls++;assert.equal(req.method,"POST");
    assert.equal(req.url,"https://preprod-private.invalid/__preprod/cron");
    return Response.json({status:"completed",due:10,processed:8,failed:1,unbound:1,
      rawOrderId:"DO_NOT_EXPOSE"});
  };
  const {response,data}=await run("/__preprod/cron",{method:"POST"},env);
  assert.equal(response.status,200);
  assert.deepEqual(data,{status:"completed",due:10,processed:8,failed:1,unbound:1});
  assert.equal(calls,1);
  env.WAFFO_PREPROD_TARGET.fetch=async()=>Response.json({status:"completed",due:"10",
    processed:8,failed:1,unbound:1});
  assert.equal((await run("/__preprod/cron",{method:"POST"},env)).response.status,502);
});

test("temporary health diagnostics identify failing gate without leaking private response",async()=>{
  const env=baseEnv();
  env.WAFFO_PREPROD_DIAGNOSTICS_ENABLED="true";
  let r=await run("/__preprod/health",{},env,{});
  assert.equal(r.response.status,403);
  assert.deepEqual(r.data,{ok:false,reason:"access_context_rejected"});

  env.WAFFO_PREPROD_TARGET.fetch=async()=>Response.json({secret:"NEVER_LOG_ME"},{status:403});
  r=await run("/__preprod/health",{},env);
  assert.equal(r.response.status,403);
  assert.deepEqual(r.data,{ok:false,reason:"private_worker_gate_rejected"});

  env.WAFFO_PREPROD_TARGET.fetch=async()=>Response.json({secret:"NEVER_LOG_ME"},{status:503});
  r=await run("/__preprod/health",{},env);
  assert.equal(r.response.status,503);
  assert.deepEqual(r.data,{ok:false,reason:"private_worker_not_ready"});

  env.WAFFO_PREPROD_TARGET.fetch=async()=>Response.json({ok:true,mode:"wrong",secret:"NEVER_LOG_ME"});
  r=await run("/__preprod/health",{},env);
  assert.equal(r.response.status,502);
  assert.deepEqual(r.data,{ok:false,reason:"private_health_payload_mismatch"});

  env.WAFFO_PREPROD_DIAGNOSTICS_ENABLED="false";
  r=await run("/__preprod/health",{},env,{});
  assert.deepEqual(r.data,{ok:false});

  // Even with diagnostics enabled, non-health routes retain generic denial.
  env.WAFFO_PREPROD_DIAGNOSTICS_ENABLED="true";
  r=await run("/__preprod/webhook",{method:"POST",headers:{"content-type":"application/json"},body:"{}"},env,{});
  assert.deepEqual(r.data,{ok:false});
});

test("opt-in Gateway trace emits only stable stages and safe request buckets",async()=>{
  const env=baseEnv();
  const notes=[];
  const original=console.info;
  const hidden="top-secret-value-PRIVATE-123";
  const fakeEmail="private@example.invalid";
  env.WAFFO_PREPROD_DIAGNOSTICS_ENABLED="true";
  console.info=(...parts)=>notes.push(parts);
  try {
    // These probes must not log raw URL path, query value or credentials.
    let r=await run("/__preprod/health?secret="+hidden,{
      headers:{Cookie:"sid="+hidden,Authorization:"Bearer "+hidden},
    },env);
    assert.equal(r.response.status,404);
    assert.deepEqual(r.data,{ok:false});
    r=await run("/nonapproved/"+hidden,{},env);
    assert.equal(r.response.status,404);
    r=await run("/__preprod/health",{method:"POST"},env);
    assert.equal(r.response.status,404);
    r=await run("/__preprod/health",{},env,{access:{
      aud:"wrong",getIdentity:async()=>({email:fakeEmail}),
    }});
    assert.equal(r.response.status,403);
    assert.deepEqual(r.data,{ok:false,reason:"access_context_rejected"});

    env.WAFFO_PREPROD_TARGET.fetch=async()=>Response.json({
      secret:hidden,email:fakeEmail,
    },{status:503});
    r=await run("/__preprod/health",{},env);
    assert.equal(r.response.status,503);
    assert.equal(r.data.reason,"private_worker_not_ready");

    env.WAFFO_PREPROD_TARGET.fetch=async()=>Response.json({
      ok:true,mode:"isolated",entitlements:false,automaticCron:false,
      secret:hidden,email:fakeEmail,
    });
    r=await run("/__preprod/health",{},env);
    assert.equal(r.response.status,200);
    assert.deepEqual(r.data,{
      ok:true,mode:"isolated",entitlements:false,automaticCron:false,
    });

    const stages=notes.map(part=>part[1]?.stage);
    assert.deepEqual(stages,[
      "route_rejected","route_rejected","route_rejected",
      "access_rejected","private_non_200","health_pass",
    ]);
    for(const [tag,fields] of notes){
      assert.equal(tag,"waffo_preprod_gateway_diag");
      assert.deepEqual(Object.keys(fields).sort(),[
        "extraParams","method","route","schema","stage","status",
      ].sort());
      assert.equal(fields.schema,1);
      assert.ok(["health","webhook","cron","other","invalid"].includes(fields.route));
      assert.ok(["GET","POST","OTHER"].includes(fields.method));
    }
    assert.equal(notes[0][1].route,"health");
    assert.equal(notes[0][1].extraParams,true);
    assert.equal(notes[1][1].route,"other");
    assert.equal(notes[2][1].method,"POST");

    const serialized=JSON.stringify(notes);
    for(const sensitive of [hidden,fakeEmail,TOKEN,
      "sid=", "Bearer", "/nonapproved", "private@example.invalid"]){
      assert.equal(serialized.includes(sensitive),false,sensitive);
    }

    env.WAFFO_PREPROD_DIAGNOSTICS_ENABLED="false";
    await run("/__preprod/health",{},env);
    assert.equal(notes.length,6,"logs disabled when opt-in flag is not true");
  } finally {
    console.info=original;
  }
});

test("private target failures do not leak response bodies or exception messages",async()=>{
  const env=baseEnv();
  env.WAFFO_PREPROD_TARGET.fetch=async()=>{throw Error("internal secret details");};
  const r=await run("/__preprod/health",{},env);
  assert.equal(r.response.status,503);
  assert.doesNotMatch(JSON.stringify(r.data),/secret/);
  env.WAFFO_PREPROD_TARGET.fetch=async()=>new Response("internal secret",{status:500});
  const s=await run("/__preprod/health",{},env);
  assert.equal(s.response.status,502);
  assert.doesNotMatch(JSON.stringify(s.data),/secret/);
  env.WAFFO_PREPROD_TARGET.fetch=async()=>Response.json({ok:true,mode:"isolated",
    entitlements:true,automaticCron:false});
  assert.equal((await run("/__preprod/health",{},env)).response.status,502);
});
