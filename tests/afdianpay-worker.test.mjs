import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import worker, { reconcilePage, normalizeAndValidateProviderOrder } from '../workers/afdianpay/worker.js';
const PLAN_ID='4c2527fc6c7411f1bbe45254001e7c00';
const REF='11111111-1111-4111-8111-111111111111';
const env={AFDIAN_PLAN_ID:PLAN_ID,SUPABASE_URL:'https://db.test',SUPABASE_KEY:'synthetic',USER_ID:'synthetic',TOKEN:'synthetic',ADMIN_TOKEN:'synthetic-admin'};
const paidOrder=(x={})=>({out_trade_no:'fixture-order-1',status:2,product_type:0,plan_id:PLAN_ID,total_amount:'10.00',custom_order_id:REF,...x});
function harness({provider,db,identity}={}){
 const saved=globalThis.fetch;const calls=[];const ledger=new Map();let nextPage=1;let generation=0;
 globalThis.fetch=async(input,init={})=>{
  const url=String(input);const body=init.body?JSON.parse(init.body):null;calls.push({url,body,init});
  if(url.includes('/account/identity'))return identity?.(body,init)||Response.json({user_id:'synthetic-owner',identity_status:'active'});
  if(url.includes('query-order'))return provider?.(JSON.parse(body.params))||Response.json({ec:200,data:{list:[paidOrder()],total_page:1}});
  const result=db?.(url,body,init); if(result) return result;
  if(url.includes('get_pro_payment_backoff'))return Response.json({retry_after_seconds:0});
  if(url.includes('claim_pro_payment_order_query'))return Response.json({acquired:true,status:'unresolved'});
  if(url.includes('claim_pro_payment_scan'))return Response.json({acquired:true,lease_token:REF,generation:++generation,next_page:nextPage});
  if(url.includes('complete_pro_payment_scan')){nextPage=body.p_next_page;return Response.json({advanced:true});}
  if(url.includes('record_pro_payment_hints')){for(const id of body.p_order_ids)ledger.set(id,{});return Response.json({recorded:body.p_order_ids.length});}
  if(url.includes('process_verified_pro_order')){ledger.set(body.p_order.order_id,body.p_order);return Response.json({status:'activated'});}
  if(url.includes('/rpc/'))return Response.json({ok:true});
  if(url.includes('/user_profiles'))return Response.json([{user_id:'synthetic-owner',identity_status:'active',pro:true}]);
  if(url.includes('/pro_payment_orders'))return Response.json([]);
  throw Error('unhandled synthetic request');
 }; return {calls,ledger,restore(){globalThis.fetch=saved;}};
}
async function run(t,options,fn){const h=harness(options);try{await fn(h);}finally{h.restore();}}
const admin=body=>new Request('https://afdianpay.sunland.dev/admin/reconcile',{method:'POST',headers:{Authorization:'Bearer synthetic-admin'},body:JSON.stringify(body)});
const user=body=>new Request('https://afdianpay.sunland.dev/payment/reconcile',{method:'POST',headers:{Authorization:'Bearer app-token',Origin:'https://sunland.dev'},body:JSON.stringify(body)});
test('afdianpay prefers a verified custom UUID over buyer remark',t=>run(t,{},async h=>{
 await worker.fetch(admin({out_trade_no:'fixture-order-1'}),env);
 const args=h.calls.find(x=>x.url.includes('process_verified_pro_order')).body;
 assert.equal(args.p_order.binding_reference,REF);assert.equal(args.p_order.binding_source,'intent');
 assert.equal(args.p_order.amount_cents,1000);assert.ok(args.p_trace_id);assert.equal(args.p_processing_source,'manual_query');
 assert.equal(h.calls.some(x=>x.url.includes('activate_pro_from_payment')),false);
}));
test('only canonical legacy remark may bind when custom intent absent',()=>{
 assert.equal(normalizeAndValidateProviderOrder(paidOrder({custom_order_id:'',remark:'22222222222222222222222222222222'})).binding_source,'legacy');
 assert.equal(normalizeAndValidateProviderOrder(paidOrder({custom_order_id:'',remark:'thanks-pro'})).binding_source,'unresolved');
 assert.throws(()=>normalizeAndValidateProviderOrder(paidOrder({custom_order_id:'22222222222222222222222222222222'})));
});
test('partial page processes eight and durably queues all remaining IDs',t=>run(t,{provider:()=>Response.json({ec:200,data:{total_page:1,list:Array.from({length:20},(_,i)=>paidOrder({out_trade_no:`fixture-order-${i}`}))}})},async h=>{
 await reconcilePage(env,'recent','cron_recent');assert.equal(h.ledger.size,20);
 assert.equal(h.calls.filter(x=>x.url.includes('process_verified_pro_order')).length,8);
 assert.equal(h.calls.find(x=>x.url.includes('complete_pro_payment_scan')).body.p_order_ids.length,20);
}));
test('history cursor traverses two complete four-page cycles',t=>run(t,{provider:()=>Response.json({ec:200,data:{total_page:4,list:[]}})},async h=>{
 for(let i=0;i<8;i++)await reconcilePage(env,'history','cron_history');
 assert.deepEqual(h.calls.filter(x=>x.url.includes('query-order')).map(x=>JSON.parse(x.body.params).page),[1,2,3,4,1,2,3,4]);
}));
test('history page three failure releases lease and retries same page',t=>{
 let failed=false;return run(t,{provider:p=>p.page===3&&!failed?(failed=true,new Response('',{status:503})):Response.json({ec:200,data:{total_page:4,list:[]}})},async h=>{
 for(let i=0;i<5;i++){try{await reconcilePage(env,'history','cron_history');}catch{}}
 assert.deepEqual(h.calls.filter(x=>x.url.includes('query-order')).map(x=>JSON.parse(x.body.params).page),[1,2,3,3,4]);
 });
});
test('429 persists global backoff without immediate provider retry',t=>run(t,{provider:()=>new Response('',{status:429,headers:{'Retry-After':'120'}})},async h=>{
 await assert.rejects(reconcilePage(env,'recent','cron_recent'));
 assert.equal(h.calls.filter(x=>x.url.includes('query-order')).length,1);
 assert.equal(h.calls.find(x=>x.url.includes('set_pro_payment_backoff')).body.p_retry_after_seconds,120);
}));
test('fenced completion cannot claim success',t=>run(t,{db:url=>url.includes('complete_pro_payment_scan')?Response.json({advanced:false}):null},async()=>{
 await assert.rejects(reconcilePage(env,'history','cron_history'),/SCAN_LEASE_LOST/);
}));
test('admin hidden from unauthenticated callers and cannot accept facts',async()=>{
 assert.equal((await worker.fetch(new Request('https://afdianpay.sunland.dev/admin/reconcile'),env)).status,405);
 assert.equal((await worker.fetch(new Request('https://afdianpay.sunland.dev/admin/reconcile',{method:'POST'}),env)).status,404);
 assert.equal((await worker.fetch(admin({out_trade_no:'fixture-order-1',user_id:'victim'}),env)).status,400);
 assert.equal((await worker.fetch(new Request('https://afdianpay.sunland.dev/test'),env)).status,404);
});
function signedRequest(key,order){const sign=createSign('RSA-SHA256');sign.update([order.out_trade_no,order.user_id,order.plan_id,order.total_amount].map(x=>String(x??'')).join(''));sign.end();return new Request('https://afdianpay.sunland.dev/webhook/afdian',{method:'POST',body:JSON.stringify({data:{type:'order',order},sign:sign.sign(key,'base64')})});}
const keys=generateKeyPairSync('rsa',{modulusLength:2048});const signedEnv={...env,AFDIAN_WEBHOOK_PUBLIC_KEY:keys.publicKey.export({type:'spki',format:'pem'})};
test('signed webhook tampering in unsigned fields cannot change provider binding',t=>run(t,{},async h=>{
 const response=await worker.fetch(signedRequest(keys.privateKey,paidOrder({custom_order_id:'attacker',remark:'attacker',status:0,product_type:1})),signedEnv);
 assert.equal(response.status,200);
 assert.equal(h.calls.find(x=>x.url.includes('process_verified_pro_order')).body.p_order.binding_reference,REF);
}));
test('invalid signature creates no hint and webhook durably queued outage ACKs',t=>run(t,{provider:()=>new Response('',{status:503})},async h=>{
 const bad=new Request('https://afdianpay.sunland.dev/webhook/afdian',{method:'POST',body:JSON.stringify({data:{type:'order',order:paidOrder()},sign:'bad'})});
 assert.equal((await worker.fetch(bad,signedEnv)).status,401);assert.equal(h.ledger.size,0);
 assert.equal((await worker.fetch(signedRequest(keys.privateKey,paidOrder()),signedEnv)).status,200);assert.equal(h.ledger.size,1);
}));
test('webhook database failure cannot ACK an undurable hint',t=>run(t,{db:()=>new Response('',{status:503})},async()=>{
 assert.equal((await worker.fetch(signedRequest(keys.privateKey,paidOrder()),signedEnv)).status,503);
}));
test('user reconciliation ignores no caller identity/facts overrides',t=>run(t,{},async h=>{
 for(const body of [{user_id:'victim'},{paid:true},{amount:10},{order_id:'other'}])assert.equal((await worker.fetch(user(body),env)).status,400);
 assert.equal(h.calls.length,0);
 const response=await worker.fetch(user({}),env);const value=await response.json();assert.equal(value.user_id,'synthetic-owner');assert.equal(value.membership.pro,true);
 assert.equal(response.headers.get('Access-Control-Allow-Origin'),'https://sunland.dev');
 assert.equal(h.calls.find(x=>x.url.includes('account/identity')).init.headers.Authorization,'Bearer app-token');
 assert.equal(h.calls.find(x=>x.url.includes('account/identity')).init.method,'POST');
}));
test('membership read failure is unknown never confirmed free',t=>run(t,{db:url=>url.includes('user_profiles')?new Response('',{status:503}):null},async()=>{
 const value=await(await worker.fetch(user({}),env)).json();assert.deepEqual(value.membership,{state:'unknown',pro:null,checked_at:null});
}));
test('identity unavailable returns 503 and forbidden identity stays forbidden',t=>run(t,{identity:()=>new Response('',{status:503})},async h=>{
 assert.equal((await worker.fetch(user({}),env)).status,503);assert.equal(h.calls.some(x=>x.url.includes('user_profiles')),false);
}));

test('recent page never advances historical cursor even with four provider pages',t=>run(t,{provider:()=>Response.json({ec:200,data:{total_page:4,list:[]}})},async h=>{
 await reconcilePage(env,'recent','cron_recent');assert.equal(h.calls.find(x=>x.url.includes('complete_pro_payment_scan')).body.p_next_page,1);
}));

test('temporarily invisible signed order remains retryable then verified paid recovers',t=>{
 let calls=0; return run(t,{provider:()=>Response.json({ec:200,data:{total_page:1,list:++calls===1?[]:[paidOrder()]}})},async h=>{
 await worker.fetch(signedRequest(keys.privateKey,paidOrder()),signedEnv);
 assert.equal(h.calls.find(x=>x.url.includes('note_pro_payment_retry')).body.p_reason_code,'PROVIDER_QUERY_FAILED');
 await worker.fetch(admin({out_trade_no:'fixture-order-1'}),env);assert.equal(h.ledger.get('fixture-order-1').binding_reference,REF);
 });
});
test('atomic per-order query claim suppresses replay provider calls',t=>run(t,{db:url=>url.includes('claim_pro_payment_order_query')?Response.json({acquired:false,status:'unresolved',retry_after_seconds:20}):null},async h=>{
 await worker.fetch(signedRequest(keys.privateKey,paidOrder()),signedEnv);assert.equal(h.calls.some(x=>x.url.includes('query-order')),false);
}));

test('a previously paid unresolved order requires a fresh provider result before grant',t=>run(t,{
 provider:()=>new Response('',{status:503}),
 db:url=>url.includes('claim_pro_payment_scan')?Response.json({acquired:false}):
   url.includes('/pro_payment_orders?')?Response.json([{order_id:'fixture-order-1',payment_status:'paid',verified_binding_reference:REF,last_verified_at:new Date().toISOString()}]):null,
},async h=>{
 await worker.scheduled(null,env);
 assert.equal(h.calls.filter(x=>x.url.includes('query-order')).length,1);
 assert.equal(h.calls.filter(x=>x.url.includes('process_verified_pro_order')).length,0);
}));

test('canonical inactive identity is propagated, with no membership/provider query',t=>run(t,{identity:()=>Response.json({error:'ACCOUNT_NOT_ACTIVE'},{status:403})},async h=>{
 const r=await worker.fetch(user({}),env);assert.equal(r.status,403);assert.equal((await r.json()).error,'ACCOUNT_NOT_ACTIVE');assert.equal(h.calls.some(x=>x.url.includes('user_profiles')),false);
}));
