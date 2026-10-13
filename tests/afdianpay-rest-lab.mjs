// Run: AFDIAN_DOCKER_PG=true node tests/afdianpay-rest-lab.mjs (owned synthetic PG16/PostgREST14.14).
import assert from 'node:assert/strict';
import { randomUUID, createSign, generateKeyPairSync } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { startLocalStack } from './afdianpay-local-stack.mjs';
import { createServer } from 'node:http';
import worker, { reconcilePage, queryProviderOrder } from '../workers/afdianpay/worker.js';
const stack=await startLocalStack({rest:true});
const endpoint=stack.endpoint;const token=stack.token;const service=stack.service;
const output=process.env.AFDIAN_TEST_OUTPUT || '/tmp/afdianpay-p1-local/'+stack.owner;mkdirSync(output,{recursive:true});
const realFetch=globalThis.fetch;
const api=async(path,method='GET',body=null,auth=service)=>{
 const response=await realFetch(endpoint+'/'+path,{method,headers:{apikey:auth,Authorization:'Bearer '+auth,'Content-Type':'application/json',Prefer:'return=representation'},...(body?{body:JSON.stringify(body)}:{})});
 const data=await response.json().catch(()=>null);if(!response.ok)throw new Error(JSON.stringify({status:response.status,data}));return data;
};
const reports=[];
const runId=randomUUID().slice(0,8);const userId='lab-rest-'+runId;const ref=randomUUID();
try {
await api('user_profiles','POST',{user_id:userId,pro:false});
await api('pro_payment_intents','POST',{payment_reference:ref,user_id:userId});
const plan='4c2527fc6c7411f1bbe45254001e7c00';const id='lab-rest-order-'+runId;
let raw={out_trade_no:id,status:2,product_type:0,plan_id:plan,total_amount:'10.00',custom_order_id:ref};
let providerOrders=null;let stalledEndpoint=null;
let identityUserId=userId;let dropNextRPCResponse=false;let actualCommittedBeforeDrop=null;let mode='order';let pages=[];let failThree=false;let providerCalls=0;
const env={SUPABASE_URL:endpoint,SUPABASE_KEY:service,USER_ID:'synthetic',TOKEN:'synthetic',ADMIN_TOKEN:'synthetic-admin'};
globalThis.fetch=async(url,init={})=>{
 if(String(url)==='https://api.sunland.dev/v1/account/identity'){
  assert.equal(init.method,'POST');return Response.json({user_id:identityUserId,identity_status:'active'});
 }
 if(String(url)==='https://ifdian.net/api/open/query-order'){
  providerCalls++;if(mode==='body-stall')return realFetch(stalledEndpoint,init);const params=JSON.parse(JSON.parse(init.body).params);
  if(mode==='history'){
   pages.push(params.page);
   if(params.page===3&&failThree){failThree=false;return new Response('',{status:503});}
   return Response.json({ec:200,data:{total_page:4,list:[]}});
  }
  if(mode==='bulk'||mode==='retry-bulk')return Response.json({ec:200,data:{total_page:1,list:params.out_trade_no ? providerOrders.filter(o=>o.out_trade_no===params.out_trade_no) : mode==='retry-bulk' ? [] : providerOrders}});
  if(mode==='invisible')return Response.json({ec:200,data:{total_page:1,list:[]}});
  if(mode==='outage')return new Response('',{status:503});
  return Response.json({ec:200,data:{total_page:1,list:[raw]}});
 }
 // The local PostgREST is exposed directly, without Supabase Kong /rest/v1 prefix.
 const result=await realFetch(String(url).replace(endpoint+'/rest/v1/',endpoint+'/'),init);
 if(!result.ok)console.error('Synthetic REST failure',String(url).split('/').at(-1),result.status,await result.clone().text());
 if(dropNextRPCResponse&&String(url).includes('rpc/sunland_finish_pro_payment_order_query')){
  dropNextRPCResponse=false;assert.ok(result.ok);actualCommittedBeforeDrop=await result.clone().json();throw new TypeError('synthetic response dropped after real DB commit');
 }
 return result;
};
 const keys=generateKeyPairSync('rsa',{modulusLength:2048});env.AFDIAN_WEBHOOK_PUBLIC_KEY=keys.publicKey.export({type:'spki',format:'pem'});
 const webhook=()=>{
  const tampered={...raw,status:0,product_type:1,custom_order_id:randomUUID(),remark:'attacker'};
  const sign=createSign('RSA-SHA256');sign.update([tampered.out_trade_no,tampered.user_id,tampered.plan_id,tampered.total_amount].map(v=>String(v??'')).join(''));sign.end();
  return new Request('https://afdianpay.sunland.dev/webhook/afdian',{method:'POST',body:JSON.stringify({data:{type:'order',order:tampered},sign:sign.sign(keys.privateKey,'base64')})});
 };
 let response=await worker.fetch(webhook(),env);assert.equal(response.status,200);
 let ledger=await api('pro_payment_orders?order_id=eq.'+id);let profile=await api('user_profiles?user_id=eq.'+userId);let intent=await api('pro_payment_intents?user_id=eq.'+userId);
 assert.equal(ledger[0].status,'activated',JSON.stringify({ledger,profile,intent,providerCalls}));assert.equal(ledger[0].bound_user_id,userId);assert.equal(ledger[0].verified_binding_reference,ref);assert.equal(profile[0].pro,true);assert.equal(intent[0].status,'activated');
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
 const retriedResult=await retriedResponse.json();assert.equal(retriedResponse.status,200);assert.equal(dropNextRPCResponse,false);assert.equal(actualCommittedBeforeDrop.status,'activated');assert.equal(retriedResult.reason_code,'LEASE_FENCED');
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
 // Error-code control experiment uses nontransactional sequences to measure actual
 // executions. A control flag releases an aborted 40001 request without killing peers.
 await stack.sql(`create sequence public.admission_probe_40001;create sequence public.admission_probe_55000;
  create table public.admission_probe_control(enabled boolean);insert into public.admission_probe_control values(true);
  create function public.admission_probe_40001() returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$begin
    perform nextval('public.admission_probe_40001'::regclass);
    if (select enabled from public.admission_probe_control) then raise exception 'SYNTHETIC_SERIALIZATION_PROBE' using errcode='40001';end if;
    return '{}'::jsonb;end;$$;
  create function public.admission_probe_55000() returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$begin
    perform nextval('public.admission_probe_55000'::regclass);raise exception 'SYNTHETIC_STATE_PROBE' using errcode='55000';end;$$;
  revoke all on function public.admission_probe_40001(),public.admission_probe_55000() from public,anon,authenticated;
  grant execute on function public.admission_probe_40001(),public.admission_probe_55000() to service_role;notify pgrst,'reload schema';`);
 await new Promise(resolve=>setTimeout(resolve,300));
 const probeRequest=code=>realFetch(endpoint+'/rpc/admission_probe_'+code,{method:'POST',headers:{Authorization:'Bearer '+service,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(2000)});
 const probeStart=performance.now();let serializationOutcome;
 try{const response=await probeRequest('40001');serializationOutcome={http:response.status,body:await response.json()};}catch(error){serializationOutcome={error:error.name};}
 const probeElapsed=performance.now()-probeStart;
 await stack.sql('update public.admission_probe_control set enabled=false;');
 const serializationExecutions=Number(await stack.sql('select case when is_called then last_value else 0 end from public.admission_probe_40001;'));
 const stateResponse=await probeRequest('55000');assert.equal((await stateResponse.json()).code,'55000');
 const stateExecutions=Number(await stack.sql('select case when is_called then last_value else 0 end from public.admission_probe_55000;'));assert.equal(stateExecutions,1);
 reports.push({test:'REST-error-code-execution-counter-control',serializationOutcome,serializationExecutions,serializationElapsedMilliseconds:probeElapsed,stateExecutions});
 // Real PostgREST service contract: disabled legacy endpoint and fenced six-argument batch.
 const invoke=async(name,body,auth=service)=>realFetch(endpoint+'/rpc/'+name,{method:'POST',headers:{Authorization:'Bearer '+auth,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
 const legacy=await invoke('sunland_process_verified_pro_order',{p_order:{order_id:id},p_processing_source:'webhook',p_trace_id:randomUUID(),p_use_cached:false});
 assert.equal((await legacy.json()).code,'55000');reports.push({test:'REST-service-legacy-entry-disabled',http:legacy.status});
 const fencedId=id+'-fenced',fencedUser=userId+'-fenced',fencedRef=randomUUID();
 await api('user_profiles','POST',{user_id:fencedUser,pro:false});await api('pro_payment_intents','POST',{payment_reference:fencedRef,user_id:fencedUser});
 await api('rpc/sunland_record_pro_payment_hints','POST',{p_order_ids:[fencedId],p_processing_source:'cron_recent',p_trace_id:randomUUID()});
 await stack.sql("update pro_payment_reconciliation_state set lease_until=null,last_success_at=null where state_key='recent';");
 const oldLease=await api('rpc/sunland_claim_pro_payment_scan','POST',{p_state_key:'recent'});
 await stack.sql("update pro_payment_reconciliation_state set lease_until=clock_timestamp()-interval '1 second' where state_key='recent';");
 const newLease=await api('rpc/sunland_claim_pro_payment_scan','POST',{p_state_key:'recent'});
 const observation={provider:'afdian',order_id:fencedId,payment_status:'unknown',plan_id:'16b23966c0a711f183dc5254001e7c00',product_type:1,amount_cents:1500,total_amount:'15.00',currency:'CNY',binding_reference:fencedRef,binding_source:'intent',paid_at:null,sku_detail:[{sku_id:'16b98478c0a711f1bb735254001e7c00',count:1}]};
 const args=lease=>({p_orders:[observation],p_processing_source:'cron_recent',p_trace_id:randomUUID(),p_scan_state_key:'recent',p_scan_token:lease.lease_token,p_scan_generation:lease.generation});
 assert.equal((await api('rpc/sunland_process_pro_payment_scan_orders','POST',args(newLease))).processed,1);
 await stack.sql(`update pro_payment_orders set next_retry_at=clock_timestamp()-interval '1 second' where order_id='${fencedId}';`);
 const fencedBefore=await api('pro_payment_orders?order_id=eq.'+fencedId);
 observation.payment_status='paid';const rejected=await invoke('sunland_process_pro_payment_scan_orders',args(oldLease));
 assert.equal((await rejected.json()).code,'55000');assert.equal(Number(await stack.sql("select count(*) from pg_stat_activity where usename='authenticator' and state='active' and query like '%p_orders%';")),0);assert.deepEqual(await api('pro_payment_orders?order_id=eq.'+fencedId),fencedBefore);
 assert.equal((await api('user_profiles?user_id=eq.'+fencedUser))[0].pro,false);
 reports.push({test:'REST-six-argument-batch-P1-rejected-atomic',http:rejected.status});
 // Historical page budget preserves all twelve durable hints; due retry drains its tail.
 providerOrders=[];
 for(let i=0;i<12;i++){
  const user=userId+'-history-'+i,reference=randomUUID(),orderId=id+'-history-'+i;
  await api('user_profiles','POST',{user_id:user,pro:false});await api('pro_payment_intents','POST',{payment_reference:reference,user_id:user});
  providerOrders.push({out_trade_no:orderId,status:2,product_type:1,plan_id:'16b23966c0a711f183dc5254001e7c00',total_amount:'15.00',custom_order_id:reference,sku_detail:[{sku_id:'16b98478c0a711f1bb735254001e7c00',count:1}]});
 }
 mode='bulk';await reconcilePage(env,'history','cron_history');
 const bulkIds=providerOrders.map(o=>o.out_trade_no);let bulkRows=await api('pro_payment_orders?order_id=in.('+bulkIds.join(',')+')');
 assert.equal(bulkRows.length,12);assert.equal(bulkRows.filter(r=>r.status==='activated').length,8);assert.equal(bulkRows.filter(r=>r.next_retry_at!==null).length,4);
 mode='retry-bulk';await stack.sql("update pro_payment_reconciliation_state set lease_until=null,last_success_at=null where state_key in ('recent','retry');");
 await Promise.all(Array.from({length:3},()=>worker.scheduled({cron:'*/2 * * * *',scheduledTime:Date.now()},env)));
 bulkRows=await api('pro_payment_orders?order_id=in.('+bulkIds.join(',')+')');assert.ok(bulkRows.every(r=>r.status==='activated'));
 for(const orderId of bulkIds)assert.equal((await api('pro_activations?order_id=eq.'+orderId)).length,1);
 reports.push({test:'REST-history-budget-due-retry-duplicate-Cron',durableHints:12,pageActivated:8,retryActivated:4,duplicateCron:3,uniqueGrants:12});
 // Actual HTTP server sends headers and a partial JSON body forever; AbortSignal closes it.
 let bodyClosed=false;const sockets=new Set();const stallServer=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.flushHeaders();res.write('{"ec":');res.on('close',()=>{bodyClosed=true;});});
 stallServer.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 await new Promise(resolve=>stallServer.listen(0,'127.0.0.1',resolve));stalledEndpoint='http://127.0.0.1:'+stallServer.address().port;mode='body-stall';
 const started=performance.now();try{await assert.rejects(queryProviderOrder(env,id),error=>error.code==='PROVIDER_QUERY_FAILED');
  const duration=performance.now()-started;assert.ok(duration>=7500&&duration<12000);await new Promise(resolve=>setTimeout(resolve,50));assert.ok(bodyClosed);
  reports.push({test:'REST-real-HTTP-headers-success-body-stall-aborted',durationMilliseconds:duration,bodyClosed});
 }finally{for(const socket of sockets)socket.destroy();await new Promise(resolve=>stallServer.close(resolve));}
 // Private ledger and v2 are denied by the actual HTTP JWT roles.
 for(const role of ['anon','authenticated']){
  const auth=token(role,userId);
  const response=await realFetch(endpoint+'/rpc/sunland_process_verified_pro_order',{method:'POST',headers:{Authorization:'Bearer '+auth,'Content-Type':'application/json'},body:JSON.stringify({p_order:{order_id:id},p_processing_source:'webhook',p_trace_id:randomUUID(),p_use_cached:true})});
  assert.ok([401,403,404].includes(response.status));reports.push({test:'REST-'+role+'-v2-denied',http:response.status});
 }
 console.log(JSON.stringify({passed:reports.length,output,provider:'synthetic HTTPS interception',database:'real isolated PostgreSQL/PostgREST'},null,2));
}finally{
 globalThis.fetch=realFetch;
 writeFileSync(output+'/rest-lab-results.json',JSON.stringify(reports,null,2));
 await stack.close();
}
