import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeAndValidateProviderOrder, queryProviderOrder } from '../workers/afdianpay/worker.js';
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
 assert.equal(normalizeAndValidateProviderOrder(raw({product_type:1})).product_type,1);
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
