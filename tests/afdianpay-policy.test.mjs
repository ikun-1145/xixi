import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import worker, { normalizeAndValidateProviderOrder, queryProviderOrder } from '../workers/afdianpay/worker.js';
const plan='4c2527fc6c7411f1bbe45254001e7c00';
const raw=overrides=>({out_trade_no:'fixture-order-1',status:2,product_type:0,plan_id:plan,total_amount:'10.00',custom_order_id:'11111111-1111-4111-8111-111111111111',...overrides});
const env={USER_ID:'synthetic',TOKEN:'synthetic',SUPABASE_URL:'https://db.test',SUPABASE_KEY:'synthetic'};
test('policy normalizes cents and custom UUID intent without remark override',()=>{
 const value=normalizeAndValidateProviderOrder(raw({remark:'22222222222222222222222222222222'}));
 assert.equal(value.amount_cents,1000); assert.equal(value.total_amount,'10.00'); assert.equal(value.binding_source,'intent');assert.equal(value.currency,'CNY');
});
for(const amount of ['NaN','Infinity','1e1','10.001','-10.00','9007199254740992',NaN,Infinity,10])test(`policy rejects unsafe amount ${String(amount)}`,()=>assert.throws(()=>normalizeAndValidateProviderOrder(raw({total_amount:amount}))));
test('policy rejects explicit foreign currency and malformed binding',()=>{
 assert.throws(()=>normalizeAndValidateProviderOrder(raw({currency:'USD'})));
 assert.throws(()=>normalizeAndValidateProviderOrder(raw({custom_order_id:'bad',remark:'22222222222222222222222222222222'})));
});
test('policy parses product/amount mismatch without granting and separates refund',()=>{
 assert.equal(normalizeAndValidateProviderOrder(raw({product_type:1,sku_detail:[{sku_id:'16b98478c0a711f1bb735254001e7c00',count:1}]})).product_type,1);
 assert.throws(()=>normalizeAndValidateProviderOrder(raw({product_type:1})),/INVALID_PRODUCT/);
 assert.equal(normalizeAndValidateProviderOrder(raw({total_amount:'9.99'})).amount_cents,999);
 assert.equal(normalizeAndValidateProviderOrder(raw({status:'refunded'})).payment_status,'refunded');
 assert.equal(normalizeAndValidateProviderOrder(raw({status:123})).payment_status,'unknown');
});
test('query order rejects zero/duplicate exact matches and ignores caller endpoint',async()=>{
 const saved=globalThis.fetch;
 try{ for(const list of [[],[raw(),raw()],[raw({out_trade_no:'another-order'})]]){
 globalThis.fetch=async(url)=>{if(String(url).includes('/rpc/'))return Response.json({retry_after_seconds:0});assert.equal(String(url),'https://ifdian.net/api/open/query-order');return Response.json({ec:200,data:{list,total_page:1}});};
 await assert.rejects(queryProviderOrder({...env,AFDIAN_QUERY_ENDPOINT:'http://evil.test'},'fixture-order-1'));
 }}finally{globalThis.fetch=saved;}
});
test('query rejects API error and invalid schema without forwarding raw payload',async()=>{
 const saved=globalThis.fetch;try{for(const data of [{ec:400005,data:{list:[raw()]}},{ec:200,data:{list:{},total_page:1}}]){
 globalThis.fetch=async url=>String(url).includes('/rpc/')?Response.json({retry_after_seconds:0}):Response.json(data);
 await assert.rejects(queryProviderOrder(env,'fixture-order-1'));
 }}finally{globalThis.fetch=saved;}
});

test('fetch diagnostics classify failure without logging credentials or raw exception', async () => {
 const savedFetch=globalThis.fetch, savedLog=console.log;
 const logs=[];
 try {
  console.log=value=>logs.push(value);
  globalThis.fetch=async url=>{
   if(String(url).includes('/rpc/'))return Response.json({retry_after_seconds:0});
   throw new TypeError('Unsupported redirect option: synthetic-private-token');
  };
  await assert.rejects(queryProviderOrder(env,'fixture-order-1'),/PROVIDER_QUERY_FAILED/);
  const output=JSON.stringify(logs);
  assert.match(output,/REDIRECT_REJECTED/);
  assert.doesNotMatch(output,/synthetic-private-token|Unsupported redirect|Authorization|sign/);
 } finally { globalThis.fetch=savedFetch;console.log=savedLog; }
});

test('provider uses edge-compatible manual redirects and never follows credential redirects', async () => {
 const saved=globalThis.fetch;
 let providerCalls=0;
 try {
  globalThis.fetch=async (url,init)=>{
   if(String(url).includes('/rpc/'))return Response.json({retry_after_seconds:0});
   providerCalls++;
   assert.equal(init.redirect,'manual');
   return new Response(null,{status:302,headers:{Location:'https://untrusted.test'}});
  };
  await assert.rejects(queryProviderOrder(env,'fixture-order-1'),/PROVIDER_QUERY_FAILED/);
  assert.equal(providerCalls,1);
 } finally {globalThis.fetch=saved;}
});

test('identity uses manual redirects and rejects redirect without forwarding bearer', async () => {
 const saved=globalThis.fetch;
 let calls=0;
 try {
  globalThis.fetch=async (url,init)=>{
   calls++;
   assert.equal(url,'https://api.sunland.dev/v1/account/identity');
   assert.equal(init.redirect,'manual');
   return new Response(null,{status:302,headers:{Location:'https://untrusted.test'}});
  };
  const response=await worker.fetch(new Request('https://afdianpay.sunland.dev/payment/reconcile',
   {method:'POST',headers:{Authorization:'Bearer synthetic-token'},body:'{}'}),env);
  assert.equal(response.status,503);
  assert.equal(calls,1);
 }finally{globalThis.fetch=saved;}
});

test('provider signing matches standard MD5 across padding and multiblock boundaries', async () => {
 const saved=globalThis.fetch;
 try {
  for(const token of ['123','synthetic','x'.repeat(32),'x'.repeat(55),'x'.repeat(64),'测试'.repeat(50)]) {
   globalThis.fetch=async(url,init)=>{
    if(String(url).includes('/rpc/'))return Response.json({retry_after_seconds:0});
    const b=JSON.parse(init.body);
    assert.equal(b.sign,createHash('md5').update(`${token}params${b.params}ts${b.ts}user_id${env.USER_ID}`).digest('hex'));
    return Response.json({ec:200,data:{list:[raw()],total_page:1}});
   };
   await queryProviderOrder({...env,TOKEN:token},'fixture-order-1');
  }
 }finally{globalThis.fetch=saved;}
});

test('same-zone identity service binding preserves authenticated endpoint and rejects invalid token', async () => {
 const saved=globalThis.fetch;
 let calls=0;
 try {
  globalThis.fetch=()=>{throw new Error('global fetch must not receive identity credentials');};
  const response=await worker.fetch(new Request('https://afdianpay.sunland.dev/payment/reconcile',
   {method:'POST',headers:{Authorization:'Bearer synthetic-token'},body:'{}'}),{
   ...env,AFDIAN_IDENTITY_SERVICE:{async fetch(request){
    calls++;
    assert.equal(request.url,'https://api.sunland.dev/v1/account/identity');
    assert.equal(request.method,'POST');assert.equal(request.redirect,'manual');
    assert.equal(request.headers.get('Authorization'),'Bearer synthetic-token');
    return Response.json({error:'Unauthorized'},{status:401});
   }}
  });
  assert.equal(response.status,401);assert.equal(calls,1);
 }finally{globalThis.fetch=saved;}
});
