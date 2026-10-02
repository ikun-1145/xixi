// Supabase sources are authoritative; D1 is a recoverable audit/outbox, never a cross-DB transaction.
import { createWaffoCheckoutSession, checkoutUrlOrNull, jsonResponse, normalizeWaffoEvent,
  verifyWaffoWebhook, fetchWithTimeout } from './worker.js';
import { queryProductionOrder, validateProductionProof, validateProductionRefund, ProofError } from './payment-proof.js';
import { productionRpc } from './production-rpc.js';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENTS=new Set(['order.completed','refund.succeeded','refund.failed']);
// Signed webhook refund eventIds are only stored; the applied refund id comes from GraphQL.
const PROVIDER_ID=/^[\x21-\x7e]{1,128}$/;
function configured(env) {
  return env.WAFFO_ENVIRONMENT==='test' && env.WAFFO_PRODUCTION_ENABLED==='true'
    && ['false','true'].includes(env.WAFFO_PRODUCTION_ENTITLEMENT_ENABLED) && env.WAFFO_PRODUCTION_LEDGER
    && /^MER_[A-Za-z0-9]+$/.test(env.WAFFO_PROD_MERCHANT_ID||'')
    && /^STO_[A-Za-z0-9]+$/.test(env.WAFFO_PROD_STORE_ID||'')
    && /^PROD_[A-Za-z0-9]+$/.test(env.WAFFO_PROD_PRODUCT_ID||'')
    && env.WAFFO_WEBHOOK_PUBLIC_KEY_PROD
    && env.WAFFO_WEBHOOK_PUBLIC_KEY_PROD.replace(/\s/g,'')!==String(env.WAFFO_WEBHOOK_PUBLIC_KEY_TEST||'').replace(/\s/g,'');
}
async function digest(value) {
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,'0')).join('');
}
function canonical(value) {
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
}
export async function handleProductionCheckout(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'method not allowed' }, 405);
  if (!configured(env) || !env.WAFFO_PRIVATE_KEY_PRODUCTION || typeof env.WAFFO_IDENTITY_SERVICE?.fetch !== 'function'
    || env.WAFFO_PRIVATE_KEY_PRODUCTION.replace(/\s/g, '') === String(env.WAFFO_PRIVATE_KEY_TEST || '').replace(/\s/g, '')) {
    return jsonResponse({ error: 'production checkout unavailable' }, 503);
  }
  const identity = await productionIdentity(request, env);
  if (identity instanceof Response) return identity;
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'invalid JSON body' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonResponse({ error: 'invalid JSON body' }, 400);
  const requestKey = request.headers.get('Idempotency-Key');
  if (!UUID.test(requestKey || '')) return jsonResponse({ error: 'UUID Idempotency-Key required' }, 400);
  const db = env.WAFFO_PRODUCTION_LEDGER;
  try {
    await db.prepare(`INSERT INTO payment_intents
      (payment_reference,mode,user_id,store_id,product_id,currency,amount_minor,request_key,created_at)
      VALUES(?,'prod',?,?,?,'CNY',1500,?,?) ON CONFLICT(user_id,request_key) DO NOTHING`)
      .bind(crypto.randomUUID(), identity.user_id, env.WAFFO_PROD_STORE_ID, env.WAFFO_PROD_PRODUCT_ID, requestKey, Date.now()).run();
    const intent = await db.prepare('SELECT * FROM payment_intents WHERE user_id=? AND request_key=?')
      .bind(identity.user_id, requestKey).first();
    if (!intent || intent.mode !== 'prod' || intent.store_id !== env.WAFFO_PROD_STORE_ID || intent.product_id !== env.WAFFO_PROD_PRODUCT_ID) {
      return jsonResponse({ error: 'intent unavailable' }, 503);
    }
    const registered = await productionRpc(env, 'sunland_waffo_register_intent', {p_intent: {
      mode:'prod', merchant_id:env.WAFFO_PROD_MERCHANT_ID, payment_reference:intent.payment_reference,
      user_id:intent.user_id, request_key:requestKey, store_id:intent.store_id,product_id:intent.product_id,
      currency:'CNY',amount_minor:1500 }});
    if (registered.paymentReference !== intent.payment_reference) return jsonResponse({error:'intent binding conflict'},409);
    const language = { zh: 'zh-Hans', en: 'en', ja: 'ja-JP' }[body.language] || 'en';
    const session = await createWaffoCheckoutSession({ WAFFO_MERCHANT_ID: env.WAFFO_PROD_MERCHANT_ID },
      env.WAFFO_PRIVATE_KEY_PRODUCTION, { productId: intent.product_id, currency: 'CNY',
        orderMerchantExternalId: intent.payment_reference, metadata: { payment_reference: intent.payment_reference },
        // Merchant-defined opaque correlation, not a Waffo status parameter or order ID.
        successUrl: 'https://sunland.dev/waffo-return.html#checkout=' + encodeURIComponent(requestKey), language, darkMode: body.darkMode === true },
      intent.payment_reference);
    const checkoutUrl = checkoutUrlOrNull(session?.data?.checkoutUrl);
    if (!checkoutUrl || (session?.errors && (!Array.isArray(session.errors) || session.errors.length))) {
      return jsonResponse({ error: 'checkout unavailable' }, 502);
    }
    return jsonResponse({ checkoutUrl, paymentReference: intent.payment_reference, mode: 'prod', entitlementEnabled: env.WAFFO_PRODUCTION_ENTITLEMENT_ENABLED === 'true' });
  } catch {
    // Never log provider responses, authorization or unknown exception messages.
    console.error(JSON.stringify({ event: 'waffo_production_checkout_failed', reason: 'checkout_or_ledger_unavailable' }));
    return jsonResponse({ error: 'checkout or ledger unavailable' }, 503);
  }
}
// Reuse the checkout's server identity validation; no client-supplied user identity.
async function productionIdentity(request, env) {
  const authorization = request.headers.get('Authorization');
  if (!/^Bearer [^\s]+$/.test(authorization || '')) return jsonResponse({ error: 'authentication required' }, 401);
  let identity;
  const diagnostic = { stage: 'network' };
  const logIdentityFailure = reason => console.error(JSON.stringify({ event: 'waffo_production_identity_failed',
    reason, stage: diagnostic.stage, http_status: diagnostic.http_status || null }));
  try {
    const response = await fetchWithTimeout('https://api.sunland.dev/v1/account/identity', {
      method: 'POST', redirect: 'error', headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: '{}',
    }, diagnostic, (url, options) => env.WAFFO_IDENTITY_SERVICE.fetch(url, options));
    if (response.status === 401 || response.status === 403) return jsonResponse({ error: 'authentication rejected' }, response.status);
    if (!response.ok) {
      logIdentityFailure('identity_http');
      return jsonResponse({ error: 'identity unavailable', diagnostic: { stage: diagnostic.stage, http_status: diagnostic.http_status || null } }, 503);
    }
    diagnostic.stage = 'json_parse';
    identity = await response.json();
  } catch {
    logIdentityFailure('identity_' + diagnostic.stage);
    return jsonResponse({ error: 'identity unavailable' }, 503);
  }
  // Optional E2E restriction; public rollout still requires a server-verified active account.
  if (identity?.identity_status !== 'active' || !/^[A-Za-z0-9][A-Za-z0-9@._+-]{0,127}$/.test(identity.user_id || '') || (env.WAFFO_PRODUCTION_E2E_SUB && identity.user_id !== env.WAFFO_PRODUCTION_E2E_SUB)) {
    return jsonResponse({ error: 'account not enrolled for production E2E' }, 403);
  }
  return identity;
}


export async function handleProductionWebhook(request,env) {
  if(!configured(env))return jsonResponse({ok:false},503);
  const raw=await request.text();
  const verified=await verifyWaffoWebhook(raw,request.headers.get('X-Waffo-Signature')||'',
    [{environment:'prod',pem:env.WAFFO_WEBHOOK_PUBLIC_KEY_PROD}],45*60*1000,Date.now());
  if(!verified.valid)return jsonResponse({ok:false},401);
  let envelope;try{envelope=JSON.parse(raw);}catch{return jsonResponse({ok:false},400);}
  const event=normalizeWaffoEvent(envelope);
  if(event.mode!=='prod'||event.storeId!==env.WAFFO_PROD_STORE_ID||!event.deliveryId||event.deliveryId.length>128
    ||!event.eventId)return jsonResponse({ok:false},400);
  if(!EVENTS.has(event.eventType))return jsonResponse({ok:true,ignored:true});
  if(!(event.eventType==='order.completed'?/^PAY_[A-Za-z0-9]+$/:PROVIDER_ID).test(event.eventId))return jsonResponse({ok:false},400);
  const db=env.WAFFO_PRODUCTION_LEDGER;
  try{
    const intent=UUID.test(event.order.reference)?await db.prepare('SELECT * FROM payment_intents WHERE payment_reference=?').bind(event.order.reference).first():null;
    const bound=intent?.mode==='prod'&&intent.store_id===event.storeId&&intent.product_id===env.WAFFO_PROD_PRODUCT_ID?intent.payment_reference:null;
    const fingerprint=await digest(JSON.stringify([event.mode,event.storeId,event.eventType,event.eventId,canonical(envelope.data)]));
    // Only normalized payment fields are persisted. No raw body, token, email or metadata.
    const durableEvent={...event,order:{...event.order,productName:'',paidAt:null,listPrice:event.order.listPrice ? {subtotal:event.order.listPrice.subtotal,total:event.order.listPrice.total,taxAmount:event.order.listPrice.taxAmount}:null}};
    const previous=await db.prepare('SELECT event_sha256 FROM event_ledger WHERE store_id=? AND event_type=? AND event_id=?')
      .bind(event.storeId,event.eventType,event.eventId).first();
    if(previous && previous.event_sha256!==fingerprint)return jsonResponse({ok:false,conflict:true},409);
    const ledger=db.prepare(`INSERT INTO event_ledger
      (mode,store_id,event_type,event_id,delivery_id,order_id,payment_id,reported_reference,bound_reference,body_sha256,event_sha256,observation,recorded_at)
      VALUES('prod',?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(store_id,event_type,event_id) DO NOTHING`)
      .bind(event.storeId,event.eventType,event.eventId,event.deliveryId,event.order.orderId||null,event.order.paymentId||null,
        event.order.reference||null,bound,await digest(raw),fingerprint,bound?'valid':'unbound',Date.now());
    const outbox=db.prepare(`INSERT INTO production_outbox(store_id,event_type,event_id,event_sha256,payload,state,updated_at)
      VALUES(?,?,?,?,?,'pending',?) ON CONFLICT(store_id,event_type,event_id) DO NOTHING`)
      .bind(event.storeId,event.eventType,event.eventId,fingerprint,JSON.stringify(durableEvent),Date.now());
    // D1's own transaction only: do not pretend this includes Supabase.
    await db.batch(bound?[ledger,outbox]:[ledger]);
    const saved=await db.prepare('SELECT event_sha256 FROM event_ledger WHERE store_id=? AND event_type=? AND event_id=?')
      .bind(event.storeId,event.eventType,event.eventId).first();
    if(saved?.event_sha256!==fingerprint)return jsonResponse({ok:false,conflict:true},409);
    if(!bound)return jsonResponse({ok:true,observation:'unbound',result:'recorded',entitlementEnabled:env.WAFFO_PRODUCTION_ENTITLEMENT_ENABLED==='true'});
    const result=await processProductionEvent(env,event,intent);
    return jsonResponse({ok:true,...result,entitlementEnabled:env.WAFFO_PRODUCTION_ENTITLEMENT_ENABLED==='true'});
  }catch(error){return productionFailure(error);}
}

function productionFailure(error){
  const reason=error instanceof ProofError?error.code:'ledger_unavailable';
  console.error(JSON.stringify({event:'waffo_production_failed',reason}));
  return jsonResponse({ok:false,reason},reason==='entitlement_conflict'?409:error instanceof ProofError&&error.permanent?400:503);
}

async function applyProof(env,event,proof){
  const payload={...proof,mode:'prod',merchant_id:env.WAFFO_PROD_MERCHANT_ID,event_type:event.eventType,
    event_id:event.eventId,charged_minor:1500,payment_status:'succeeded',order_status:'completed'};
  payload.event_sha256=await digest(JSON.stringify(canonical(payload)));
  payload.proof_sha256=await digest(JSON.stringify(canonical(proof)));
  payload.entitlement_enabled=env.WAFFO_PRODUCTION_ENTITLEMENT_ENABLED==='true';
  return productionRpc(env,'sunland_waffo_apply_event',{p_event:payload});
}

async function processProductionEvent(env,event,intent){
  const db=env.WAFFO_PRODUCTION_LEDGER;
  try{
    const data=await queryProductionOrder(env,event,intent);
    // Any event converges on Waffo's own succeeded refund records (missed/reordered callbacks, crash retries).
    const paymentId=event.order.paymentId||null;
    const refunds=(data.onetimeOrder.payments||[]).filter(p=>!paymentId||p.id===paymentId)
      .flatMap(p=>(p.refunds||[]).filter(r=>r.status==='succeeded'));
    let result;
    for(const refund of refunds){
      const refundEvent={...event,eventType:'refund.succeeded',eventId:refund.id};
      result=await applyProof(env,refundEvent,validateProductionRefund(data,refundEvent,intent,env));
    }
    if(!result&&event.eventType==='order.completed')result=await applyProof(env,event,validateProductionProof(data,event,intent,env));
    // Waffo may publish the refund webhook before GraphQL shows it; stay pending and retry.
    if(!result&&event.eventType==='refund.succeeded')throw new ProofError('proof_refund_pending');
    if(!result)result={status:'recorded'};
    // If this write fails after RPC success, the durable pending row retries the same PG event.
    await db.prepare(`UPDATE production_outbox SET state='delivered',last_error=NULL,attempt_count=attempt_count+1,updated_at=?
      WHERE store_id=? AND event_type=? AND event_id=?`).bind(Date.now(),event.storeId,event.eventType,event.eventId).run();
    return result;
  }catch(error){
    const reason=error instanceof ProofError?error.code:'ledger_unavailable';
    await db.prepare(`UPDATE production_outbox SET last_error=?,attempt_count=attempt_count+1,updated_at=?
      WHERE store_id=? AND event_type=? AND event_id=?`).bind(reason,Date.now(),event.storeId,event.eventType,event.eventId).run();
    throw error;
  }
}

export async function reconcileProductionOutbox(env){
  if(!configured(env))return;
  const db=env.WAFFO_PRODUCTION_LEDGER;
  const pending=await db.prepare(`SELECT payload FROM production_outbox WHERE state='pending' AND updated_at<?
    ORDER BY updated_at LIMIT 10`).bind(Date.now()-60000).all();
  for(const row of pending.results||[]){
    try{
      const event=JSON.parse(row.payload);
      const intent=await db.prepare('SELECT * FROM payment_intents WHERE payment_reference=?').bind(event.order.reference).first();
      if(!intent)continue;
      await processProductionEvent(env,event,intent);
    }catch(error){productionFailure(error);}
  }
}

export async function handleProductionReturnStatus(request,env){
  if(request.method!=='POST')return jsonResponse({error:'method not allowed'},405);
  if(!configured(env)||typeof env.WAFFO_IDENTITY_SERVICE?.fetch!=='function')return jsonResponse({error:'status unavailable'},503);
  const identity=await productionIdentity(request,env);if(identity instanceof Response)return identity;
  let body;try{body=await request.json();}catch{return jsonResponse({error:'invalid JSON body'},400);}
  if(!UUID.test(body?.checkout||''))return jsonResponse({error:'invalid checkout context'},400);
  try{
    const result=await productionRpc(env,'sunland_waffo_status',{p_user_id:identity.user_id,p_request_key:body.checkout});
    return jsonResponse({...result,entitlementEnabled:env.WAFFO_PRODUCTION_ENTITLEMENT_ENABLED==='true'});
  }catch(error){return productionFailure(error);}
}
