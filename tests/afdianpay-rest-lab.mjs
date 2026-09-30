// Manual synthetic integration runner: requires the isolated Phase 3 PostgREST at localhost:54329.
import assert from 'node:assert/strict';
import { createHmac, randomUUID, createSign, generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import worker, { reconcilePage } from '../workers/afdianpay/worker.js';
const endpoint='http://127.0.0.1:54329';
const secret='sunland-payment-phase3-synthetic-jwt-secret-2026';
function token(role,id){const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64url');const text=encode({alg:'HS256',typ:'JWT'})+'.'+encode({role,id,exp:Math.floor(Date.now()/1000)+3600});return text+'.'+createHmac('sha256',secret).update(text).digest('base64url');}
const service=token('service_role');
const realFetch=globalThis.fetch;
const api=async(path,method='GET',body=null,auth=service)=>{
 const response=await realFetch(endpoint+'/'+path,{method,headers:{apikey:auth,Authorization:'Bearer '+auth,'Content-Type':'application/json',Prefer:'return=representation'},...(body?{body:JSON.stringify(body)}:{})});
 const data=await response.json().catch(()=>null);if(!response.ok)throw new Error(JSON.stringify({status:response.status,data}));return data;
};
const runId=randomUUID().slice(0,8);const userId='lab-rest-'+runId;const ref=randomUUID();
await api('user_profiles','POST',{user_id:userId,pro:false});
await api('pro_payment_intents','POST',{payment_reference:ref,user_id:userId});
const plan='4c2527fc6c7411f1bbe45254001e7c00';const id='lab-rest-order-'+runId;
let raw={out_trade_no:id,status:2,product_type:0,plan_id:plan,total_amount:'10.00',custom_order_id:ref};
let identityUserId=userId;const reports=[];let dropNextRPCResponse=false;let actualCommittedBeforeDrop=null;let mode='order';let pages=[];let failThree=false;let providerCalls=0;
const env={SUPABASE_URL:endpoint,SUPABASE_KEY:service,USER_ID:'synthetic',TOKEN:'synthetic',ADMIN_TOKEN:'synthetic-admin'};
globalThis.fetch=async(url,init={})=>{
 if(String(url)==='https://api.sunland.dev/v1/account/identity'){
  assert.equal(init.method,'POST');return Response.json({user_id:identityUserId,identity_status:'active'});
 }
 if(String(url)==='https://ifdian.net/api/open/query-order'){
  providerCalls++;const params=JSON.parse(JSON.parse(init.body).params);
  if(mode==='history'){
   pages.push(params.page);
   if(params.page===3&&failThree){failThree=false;return new Response('',{status:503});}
   return Response.json({ec:200,data:{total_page:4,list:[]}});
  }
  if(mode==='invisible')return Response.json({ec:200,data:{total_page:1,list:[]}});
  if(mode==='outage')return new Response('',{status:503});
  return Response.json({ec:200,data:{total_page:1,list:[raw]}});
 }
 // The local PostgREST is exposed directly, without Supabase Kong /rest/v1 prefix.
 const result=await realFetch(String(url).replace(endpoint+'/rest/v1/',endpoint+'/'),init);
 if(dropNextRPCResponse&&String(url).includes('rpc/sunland_process_verified_pro_order')){
  dropNextRPCResponse=false;assert.ok(result.ok);actualCommittedBeforeDrop=await result.clone().json();throw new TypeError('synthetic response dropped after real DB commit');
 }
 return result;
};
try{
 const keys=generateKeyPairSync('rsa',{modulusLength:2048});env.AFDIAN_WEBHOOK_PUBLIC_KEY=keys.publicKey.export({type:'spki',format:'pem'});
 const webhook=()=>{
  const tampered={...raw,status:0,product_type:1,custom_order_id:randomUUID(),remark:'attacker'};
  const sign=createSign('RSA-SHA256');sign.update([tampered.out_trade_no,tampered.user_id,tampered.plan_id,tampered.total_amount].map(v=>String(v??'')).join(''));sign.end();
  return new Request('https://afdianpay.sunland.dev/webhook/afdian',{method:'POST',body:JSON.stringify({data:{type:'order',order:tampered},sign:sign.sign(keys.privateKey,'base64')})});
 };
 let response=await worker.fetch(webhook(),env);assert.equal(response.status,200);
 let ledger=await api('pro_payment_orders?order_id=eq.'+id);let profile=await api('user_profiles?user_id=eq.'+userId);let intent=await api('pro_payment_intents?user_id=eq.'+userId);
 assert.equal(ledger[0].status,'activated');assert.equal(ledger[0].bound_user_id,userId);assert.equal(ledger[0].verified_binding_reference,ref);assert.equal(profile[0].pro,true);assert.equal(intent[0].status,'activated');
 reports.push({test:'REST-UUID-Worker-real-v2-and-tampered-webhook',ledger,profile,intent,providerCalls});
 const replayBefore=providerCalls;await Promise.all(Array.from({length:12},()=>worker.fetch(webhook(),env)));assert.equal(providerCalls,replayBefore);
 reports.push({test:'REST-12-actual-Worker-signed-replays',additionalProviderCalls:0});
 const userResponse=await worker.fetch(new Request('https://afdianpay.sunland.dev/payment/reconcile',{method:'POST',headers:{Authorization:'Bearer app-synthetic',Origin:'https://sunland.dev'},body:'{}'}),env);
 const summary=await userResponse.json();assert.equal(summary.membership.pro,true);reports.push({test:'REST-authenticated-summary',summary});
 // Temporarily invisible order: queue remains due and next trusted observation can recover.
 const secondUser=userId+'-second',secondRef=randomUUID(),secondId=id+'-second';
 await api('user_profiles','POST',{user_id:secondUser,pro:false});await api('pro_payment_intents','POST',{payment_reference:secondRef,user_id:secondUser});raw={...raw,out_trade_no:secondId,custom_order_id:secondRef};mode='invisible';
 await worker.fetch(webhook(),env);let pending=(await api('pro_payment_orders?order_id=eq.'+secondId))[0];assert.equal(pending.last_error_code,'PROVIDER_QUERY_FAILED');assert.ok(pending.next_retry_at);assert.equal(pending.payment_status,'unknown');
 // Test-clock fixture only, avoid a 2-minute wall-clock delay.
 await api('pro_payment_orders?order_id=eq.'+secondId,'PATCH',{next_retry_at:'2000-01-01T00:00:00Z'});mode='order';await worker.fetch(webhook(),env);
 const recovered=(await api('pro_payment_orders?order_id=eq.'+secondId))[0];assert.equal(recovered.status,'activated');reports.push({test:'REST-zero-match-then-paid-recovery',pending,recovered});
 // Actual Worker retries a lost RPC response after a real successful REST commit.
 const thirdUser=userId+'-third',thirdRef=randomUUID(),thirdId=id+'-third';
 await api('user_profiles','POST',{user_id:thirdUser,pro:false});await api('pro_payment_intents','POST',{payment_reference:thirdRef,user_id:thirdUser});
 raw={...raw,out_trade_no:thirdId,custom_order_id:thirdRef};mode='order';dropNextRPCResponse=true;
 const retriedResponse=await worker.fetch(new Request('https://afdianpay.sunland.dev/admin/reconcile',{method:'POST',headers:{Authorization:'Bearer synthetic-admin'},body:JSON.stringify({out_trade_no:thirdId})}),env);
 const retriedResult=await retriedResponse.json();assert.equal(retriedResponse.status,200);assert.equal(retriedResult.already_processed,true);
 const thirdLedger=(await api('pro_payment_orders?order_id=eq.'+thirdId))[0];assert.equal(thirdLedger.status,'activated');assert.equal((await api('user_profiles?user_id=eq.'+thirdUser))[0].pro,true);
 reports.push({test:'REST-Worker-commit-response-lost-authoritative-retry',actualCommittedBeforeDrop,retriedResult,thirdLedger});
 // Twelve concurrent authenticated requests share the atomic recent-scan cooldown.
 const burstUser=userId+'-burst';await api('user_profiles','POST',{user_id:burstUser,pro:false});identityUserId=burstUser;
 await api('pro_payment_reconciliation_state?state_key=eq.recent','DELETE');mode='history';const beforeBurst=providerCalls;
 const burst=await Promise.all(Array.from({length:12},()=>worker.fetch(new Request('https://afdianpay.sunland.dev/payment/reconcile',{method:'POST',headers:{Authorization:'Bearer app-synthetic'},body:'{}'}),env)));
 assert.ok(burst.every(r=>r.status===200));assert.equal(providerCalls-beforeBurst,1);identityUserId=userId;
 reports.push({test:'REST-12-user-requests-one-recent-scan',requests:12,providerQueries:1});
 // Real persistent state: two cycles, then failure on page3 without skip/reset.
 await api('pro_payment_reconciliation_state?state_key=eq.history','DELETE');mode='history';pages=[];
 for(let i=0;i<8;i++)await reconcilePage(env,'history','cron_history');assert.deepEqual(pages,[1,2,3,4,1,2,3,4]);const cycleRows=await api('pro_payment_reconciliation_state?state_key=eq.history');
 reports.push({test:'REST-PG-history-two-cycles',sequence:[...pages],state:cycleRows});
 pages=[];failThree=true;for(let i=0;i<5;i++){try{await reconcilePage(env,'history','cron_history');}catch{}}
 assert.deepEqual(pages,[1,2,3,3,4]);reports.push({test:'REST-PG-history-failed-page3',sequence:[...pages],state:await api('pro_payment_reconciliation_state?state_key=eq.history')});
 // Private ledger and v2 are denied by the actual HTTP JWT roles.
 for(const role of ['anon','authenticated']){
  const auth=token(role,userId);
  const response=await realFetch(endpoint+'/rpc/sunland_process_verified_pro_order',{method:'POST',headers:{Authorization:'Bearer '+auth,'Content-Type':'application/json'},body:JSON.stringify({p_order:{order_id:id},p_processing_source:'webhook',p_trace_id:randomUUID(),p_use_cached:true})});
  assert.ok([401,403,404].includes(response.status));reports.push({test:'REST-'+role+'-v2-denied',http:response.status});
 }
 console.log(JSON.stringify({passed:reports.length,provider:'synthetic HTTPS interception',database:'real isolated PostgreSQL/PostgREST'},null,2));
}finally{
 globalThis.fetch=realFetch;
 writeFileSync('/tmp/sunland-payment-phase3/rest-lab-results.json',JSON.stringify(reports,null,2));
}
