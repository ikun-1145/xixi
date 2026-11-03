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
    if(!gatewayConfigured(env))
      return noCache({ok:false,reason:"gateway_disabled"},503);
    if(!(await verifiedAccess(ctx,env.WAFFO_PREPROD_ACCESS_AUD)))
      return noCache({ok:false},403);

    const url=new URL(request.url);
    if(url.search || url.hash || !Object.hasOwn(ALLOWED,url.pathname) ||
       request.method!==ALLOWED[url.pathname])
      return noCache({ok:false},404);
    if(url.pathname==="/__preprod/cron" &&
       env.WAFFO_PREPROD_ALLOW_CRON!=="true")
      return noCache({ok:false,reason:"manual_cron_disabled"},403);

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
        return noCache({ok:false},400);
      }
      body=await readLimited(request);
      if(!body)return noCache({ok:false,reason:"invalid_body_size"},413);
      headers.set("content-type","application/json");
      headers.set("x-waffo-signature",signature);
    }
    if(url.pathname==="/__preprod/cron" && request.body!==null)
      return noCache({ok:false},400);

    // No Host, Authorization, Cookie or client-provided Access identity is
    // relayed. There is no global fetch and no user-controlled target.
    let response;
    try {
      response=await env.WAFFO_PREPROD_TARGET.fetch(new Request(
        "https://preprod-private.invalid"+url.pathname,
        {method:request.method,headers,body,redirect:"error"},
      ));
    }catch{return noCache({ok:false,reason:"private_target_unavailable"},503);}

    const status=classifyStatus(response.status);
    if(status!==200)return noCache({ok:false},status);
    if(url.pathname==="/__preprod/webhook")
      return noCache({ok:true,syntheticOnly:true});

    let data;
    try { data=await response.json(); }
    catch { return noCache({ok:false},502); }
    if(url.pathname==="/__preprod/health") {
      if(data?.ok!==true || data?.mode!=="isolated" ||
         data?.entitlements!==false || data?.automaticCron!==false)
        return noCache({ok:false},502);
      return noCache({ok:true,mode:"isolated",entitlements:false,automaticCron:false});
    }

    // Explicitly whitelist numerical counters, never echo arbitrary JSON
    // from the target or sensitive payment identifiers.
    const fields=["due","processed","failed","unbound"];
    if(!["disabled","completed","incomplete"].includes(data?.status) ||
       fields.some(field=>!Number.isSafeInteger(data[field]) ||
         data[field]<0 || data[field]>1000000))
      return noCache({ok:false},502);
    return noCache({status:data.status,
      due:data.due,processed:data.processed,failed:data.failed,unbound:data.unbound});
  },
};
