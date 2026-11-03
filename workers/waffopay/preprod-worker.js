// Dedicated internal-only preproduction entrypoint. Do not export the public
// Waffo routes/checkout/identity functions and never configure cron/routes.
import { handleProductionWebhook, reconcileProductionOutbox } from './production.js';

export function preprodReady(env) {
  return env?.WAFFO_PREPROD_ISOLATED === 'true'
    && env.WAFFO_ENVIRONMENT === 'test'
    && env.WAFFO_PRODUCTION_ENABLED === 'true'
    && env.WAFFO_PRODUCTION_ENTITLEMENT_ENABLED === 'false'
    && typeof env.WAFFO_PREPROD_GATE_TOKEN === 'string'
    && env.WAFFO_PREPROD_GATE_TOKEN.length >= 32
    && typeof env.WAFFO_PREPROD_SIGNING_KEY === 'string'
    && typeof env.WAFFO_PREPROD_RPC_TEST_KEY === 'string'
    && typeof env.WAFFO_PREPROD_PROVIDER?.fetch === 'function'
    && typeof env.WAFFO_PREPROD_RPC?.fetch === 'function'
    && env.WAFFO_PRODUCTION_LEDGER
    // Never accept production credentials, identity bindings, or old secret
    // names in the isolated preproduction Worker.
    && !env.WAFFO_PRIVATE_KEY_PRODUCTION
    && !env.WAFFO_PRIVATE_KEY_TEST
    && !env.WAFFO_PRODUCTION_SERVICE_ROLE_KEY
    && !env.SUPABASE_ANON_KEY
    && !env.WAFFO_IDENTITY_SERVICE
    && /^MER_PREPROD[A-Za-z0-9]*$/.test(env.WAFFO_PROD_MERCHANT_ID || '')
    && /^STO_PREPROD[A-Za-z0-9]*$/.test(env.WAFFO_PROD_STORE_ID || '')
    && /^PROD_PREPROD[A-Za-z0-9]*$/.test(env.WAFFO_PROD_PRODUCT_ID || '');
}

async function authorized(request, env) {
  // A missing token must fail closed, even if the Worker is service-bound.
  const supplied = request.headers.get('X-Preprod-Test-Token') || '';
  if (!supplied || supplied.length !== env.WAFFO_PREPROD_GATE_TOKEN.length) return false;
  const encode = value => new TextEncoder().encode(value);
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encode(supplied)),
    crypto.subtle.digest('SHA-256', encode(env.WAFFO_PREPROD_GATE_TOKEN)),
  ]);
  const left = new Uint8Array(a), right = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status, headers: {'content-type':'application/json','cache-control':'no-store'},
  });
}

export default {
  async fetch(request, env) {
    if (!preprodReady(env)) return json({ok:false,reason:'preprod_isolation_incomplete'},503);
    if (!(await authorized(request, env))) return json({ok:false},403);
    const url = new URL(request.url);
    if (url.pathname === '/__preprod/health' && request.method === 'GET') {
      return json({ok:true,mode:'isolated',entitlements:false,automaticCron:false});
    }
    if (url.pathname === '/__preprod/webhook' && request.method === 'POST') {
      return handleProductionWebhook(request,env);
    }
    if (url.pathname === '/__preprod/cron' && request.method === 'POST') {
      const summary = await reconcileProductionOutbox(env);
      return json({status:summary.status,due:summary.due,processed:summary.processed,
        failed:summary.failed,unbound:summary.unbound});
    }
    return json({ok:false},404);
  },
  // No scheduled handler: never enable automatic payment retries accidentally.
};
