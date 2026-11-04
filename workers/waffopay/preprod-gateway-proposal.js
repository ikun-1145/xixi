/**
 * DORMANT preproduction test gateway proposal. This module is NOT deployed,
 * has no Wrangler route/config and does not create Cloudflare Access policies.
 *
 * When a separately approved Cloudflare Access application directly invokes
 * this gateway, ctx.access is platform-verified (not a request header).
 * Only forwards fixed operations to a private preprod Service Binding.
 */
const ALLOWED = Object.freeze({
  "/__preprod/health": "GET",
  "/__preprod/webhook": "POST",
  "/__preprod/cron": "POST",
});
const MAX_BODY = 16384;

function noCache(payload,status=200) {
  return Response.json(payload,{status,headers:{"Cache-Control":"no-store"}});
}

// Temporary stage-only health diagnostics. Never disclose private responses,
// identities, tokens, D1 details, or errors. Default is fully fail-closed.
function healthDiagnostic(request,env,status,reason) {
  let health=false;
  try { const url=new URL(request.url);health=url.pathname==="/__preprod/health" && !url.search && request.method==="GET"; }
  catch {}
  if(health && env?.WAFFO_PREPROD_DIAGNOSTICS_ENABLED==="true")
    return noCache({ok:false,reason},status);
  return noCache({ok:false},status);
}

// Diagnostic events are deliberately low-cardinality and contain no URL,
// query value, header, Cookie, identity, secret, request body or private response.
const DIAGNOSTIC_STAGES=new Set([
  "config_rejected","access_rejected","route_rejected",
  "webhook_disabled","cron_disabled","webhook_invalid",
  "webhook_body_invalid","cron_body_invalid","private_target_unavailable",
  "private_non_200","private_json_invalid","private_health_mismatch",
  "health_pass","webhook_pass","cron_payload_invalid","cron_pass",
]);
function traceProbe(request,env,stage,status) {
  if(env?.WAFFO_PREPROD_DIAGNOSTICS_ENABLED!=="true" ||
     !DIAGNOSTIC_STAGES.has(stage)) return;
  let route="invalid",extraParams=false;
  try {
    const u=new URL(request.url);
    route=u.pathname==="/__preprod/health" ? "health" :
      u.pathname==="/__preprod/webhook" ? "webhook" :
      u.pathname==="/__preprod/cron" ? "cron" : "other";
    extraParams=!!(u.search||u.hash);
  }catch {}
  const method=request.method==="GET" ? "GET" :
    request.method==="POST" ? "POST" : "OTHER";
  console.info("waffo_preprod_gateway_diag",{
    schema:1,stage,status,route,method,extraParams,
  });
}

export function gatewayConfigured(env) {
  return !!(
    env?.WAFFO_PREPROD_GATEWAY_ENABLED==="true" &&
    env.WAFFO_PREPROD_ISOLATED==="true" &&
    env.WAFFO_PREPROD_ENTITLEMENTS_ENABLED==="false" &&
    typeof env.WAFFO_PREPROD_ACCESS_AUD==="string" &&
    /^[a-zA-Z0-9_-]{32,128}$/.test(env.WAFFO_PREPROD_ACCESS_AUD) &&
    typeof env.WAFFO_PREPROD_GATE_TOKEN==="string" &&
    env.WAFFO_PREPROD_GATE_TOKEN.length>=32 &&
    typeof env.WAFFO_PREPROD_TARGET?.fetch==="function" &&
    !env.WAFFO_PRODUCTION_SERVICE_ROLE_KEY &&
    !env.WAFFO_PRIVATE_KEY_PRODUCTION &&
    !env.WAFFO_IDENTITY_SERVICE &&
    !env.WAFFO_PRODUCTION_LEDGER
  );
}

async function verifiedAccess(ctx,audience) {
  // Client-supplied JWT/identity headers are intentionally ignored.
  if(!ctx?.access || ctx.access.aud!==audience ||
     typeof ctx.access.getIdentity!=="function") return false;
  try {
    const identity=await ctx.access.getIdentity();
    return typeof identity?.email==="string" && identity.email.includes("@");
  } catch { return false; }
}

async function readLimited(request) {
  const declared=request.headers.get("content-length");
  if(declared!==null && (!/^\d+$/.test(declared)||Number(declared)>MAX_BODY))
    return null;
  const reader=request.body?.getReader();
  if(!reader)return null;
  let size=0;
  const pieces=[];
  try {
    while(true) {
      const {done,value}=await reader.read();
      if(done)break;
      size+=value.byteLength;
      if(size>MAX_BODY) {
        await reader.cancel().catch(()=>{});
        return null;
      }
      pieces.push(value);
    }
  }catch{return null;}
  if(size===0)return null;
  const result=new Uint8Array(size);
  let offset=0;
  for(const chunk of pieces){result.set(chunk,offset);offset+=chunk.byteLength;}
  return result;
}

function classifyStatus(status) {
  // Restrict outwardly visible status; never expose raw target errors or PII.
  return [200,400,401,403,404,409,413,429,503].includes(status)?status:502;
}

export default {
  async fetch(request,env,ctx) {
    const reply=(body,status,stage)=>{
      traceProbe(request,env,stage,status);
      return noCache(body,status);
    };
    const healthFail=(status,reason,stage)=>{
      traceProbe(request,env,stage,status);
      return healthDiagnostic(request,env,status,reason);
    };
    if(!gatewayConfigured(env))
      return reply({ok:false,reason:"gateway_disabled"},503,"config_rejected");
    if(!(await verifiedAccess(ctx,env.WAFFO_PREPROD_ACCESS_AUD)))
      return healthFail(403,"access_context_rejected","access_rejected");

    const url=new URL(request.url);
    if(url.search || url.hash || !Object.hasOwn(ALLOWED,url.pathname) ||
       request.method!==ALLOWED[url.pathname])
      return reply({ok:false},404,"route_rejected");
    if(url.pathname==="/__preprod/webhook" &&
       env.WAFFO_PREPROD_ALLOW_WEBHOOK!=="true")
      return reply({ok:false,reason:"manual_webhook_disabled"},403,"webhook_disabled");
    if(url.pathname==="/__preprod/cron" &&
       env.WAFFO_PREPROD_ALLOW_CRON!=="true")
      return reply({ok:false,reason:"manual_cron_disabled"},403,"cron_disabled");

    const headers=new Headers({
      "X-Preprod-Test-Token":env.WAFFO_PREPROD_GATE_TOKEN,
      "Cache-Control":"no-store",
    });
    let body;
    if(request.method==="POST" && url.pathname==="/__preprod/webhook") {
      const contentType=request.headers.get("content-type")||"";
      const signature=request.headers.get("x-waffo-signature")||"";
      if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(contentType) ||
         !/^t=\d{10,16},v1=[A-Za-z0-9+/=]{50,700}$/.test(signature)) {
        return reply({ok:false},400,"webhook_invalid");
      }
      body=await readLimited(request);
      if(!body)return reply({ok:false,reason:"invalid_body_size"},413,"webhook_body_invalid");
      headers.set("content-type","application/json");
      headers.set("x-waffo-signature",signature);
    }
    if(url.pathname==="/__preprod/cron" && request.body!==null)
      return reply({ok:false},400,"cron_body_invalid");

    // No Host, Authorization, Cookie or client-provided Access identity is
    // relayed. There is no global fetch and no user-controlled target.
    let response;
    try {
      response=await env.WAFFO_PREPROD_TARGET.fetch(new Request(
        "https://preprod-private.invalid"+url.pathname,
        {method:request.method,headers,body,redirect:"error"},
      ));
    }catch{return reply({ok:false,reason:"private_target_unavailable"},503,"private_target_unavailable");}

    const status=classifyStatus(response.status);
    if(status!==200)return healthFail(status,
      status===403 ? "private_worker_gate_rejected" :
      status===503 ? "private_worker_not_ready" : "private_worker_non_200",
      "private_non_200");
    if(url.pathname==="/__preprod/webhook")
      return reply({ok:true,syntheticOnly:true},200,"webhook_pass");

    let data;
    try { data=await response.json(); }
    catch { return healthFail(502,"private_health_invalid_json","private_json_invalid"); }
    if(url.pathname==="/__preprod/health") {
      if(data?.ok!==true || data?.mode!=="isolated" ||
         data?.entitlements!==false || data?.automaticCron!==false)
        return healthFail(502,"private_health_payload_mismatch","private_health_mismatch");
      return reply({ok:true,mode:"isolated",entitlements:false,automaticCron:false},200,"health_pass");
    }

    // Explicitly whitelist numerical counters, never echo arbitrary JSON
    // from the target or sensitive payment identifiers.
    const fields=["due","processed","failed","unbound"];
    if(!["disabled","completed","incomplete"].includes(data?.status) ||
       fields.some(field=>!Number.isSafeInteger(data[field]) ||
         data[field]<0 || data[field]>1000000))
      return reply({ok:false},502,"cron_payload_invalid");
    return reply({status:data.status,
      due:data.due,processed:data.processed,failed:data.failed,unbound:data.unbound},200,"cron_pass");
  },
};
