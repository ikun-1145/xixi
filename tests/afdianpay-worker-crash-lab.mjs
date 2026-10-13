// Run: AFDIAN_DOCKER_PG=true node tests/afdianpay-worker-crash-lab.mjs.
// Physical SIGKILL of owned Node fixtures, with synthetic provider and owned PG16/PostgREST14.14.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import worker from '../workers/afdianpay/worker.js';
import { startLocalStack, quote } from './afdianpay-local-stack.mjs';
const point=process.env.SUNLAND_CRASH_POINT;
const stack=point ? null : await startLocalStack({rest:true});
const endpoint=stack?.endpoint || process.env.SUNLAND_CRASH_ENDPOINT;
const service=stack?.service || process.env.SUNLAND_CRASH_SERVICE;
const owner=stack?.owner || process.env.SUNLAND_CRASH_OWNER;
assert.match(endpoint,/^http:\/\/127\.0\.0\.1:\d+$/);assert.ok(owner);
const env={SUPABASE_URL:endpoint,SUPABASE_KEY:service,USER_ID:'synthetic',TOKEN:'synthetic',ADMIN_TOKEN:'synthetic-admin'};
const realFetch=globalThis.fetch;
const api=async(path,method='GET',body=null)=>{
 const r=await realFetch(endpoint+'/'+path,{method,headers:{Authorization:'Bearer '+service,'Content-Type':'application/json',Prefer:'return=representation'},...(body?{body:JSON.stringify(body)}:{})});
 const d=await r.json().catch(()=>null);assert.ok(r.ok,JSON.stringify(d));return d;
};
let providerCalls=0;
function install(raw,stage=null){globalThis.fetch=async(url,init)=>{
 const value=String(url);
 const pause=committed=>{process.send({owner,stage,pid:process.pid,run:process.env.SUNLAND_CRASH_RUN,committed});return new Promise(()=>{});};
 if(value==='https://ifdian.net/api/open/query-order'){
  providerCalls++;if(stage==='before-provider-query')return pause(false);
  return Response.json({ec:200,data:{total_page:1,list:[raw]}});
 }
 if(stage==='after-provider-query'&&value.includes('rpc/sunland_finish_pro_payment_order_query'))return pause(false);
 const response=await realFetch(value.replace(endpoint+'/rest/v1/',endpoint+'/'),init);
 if(stage==='after-commit-response-lost'&&value.includes('rpc/sunland_finish_pro_payment_order_query')){
  assert.ok(response.ok);const committed=await response.clone().json();assert.equal(committed.status,'activated');return pause(true);
 }
 return response;
};}
const request=id=>new Request('https://afdianpay.sunland.dev/admin/reconcile',{method:'POST',headers:{Authorization:'Bearer synthetic-admin'},body:JSON.stringify({out_trade_no:id})});
if(point){
 process.on('message',()=>{});const raw=JSON.parse(process.env.SUNLAND_CRASH_ORDER);install(raw,point);await worker.fetch(request(raw.out_trade_no),env);
}else{
 const reports=[];const children=new Set();const output=process.env.AFDIAN_TEST_OUTPUT || '/tmp/afdianpay-p1-local/'+stack.owner;mkdirSync(output,{recursive:true});
 try{
  for(const stageName of ['before-provider-query','after-provider-query','after-commit-response-lost']){
   const run=randomUUID();const user='lab-physical-'+run.slice(0,8),ref=randomUUID(),id='lab-physical-order-'+run.slice(0,8);
   await api('user_profiles','POST',{user_id:user,pro:false});await api('pro_payment_intents','POST',{payment_reference:ref,user_id:user});
   const raw={out_trade_no:id,status:2,product_type:0,plan_id:'4c2527fc6c7411f1bbe45254001e7c00',total_amount:'10.00',custom_order_id:ref};
   const child=fork(new URL(import.meta.url),[],{env:{...process.env,SUNLAND_CRASH_POINT:stageName,SUNLAND_CRASH_ORDER:JSON.stringify(raw),SUNLAND_CRASH_RUN:run,SUNLAND_CRASH_ENDPOINT:endpoint,SUNLAND_CRASH_SERVICE:service,SUNLAND_CRASH_OWNER:owner},stdio:['ignore','pipe','pipe','ipc']});
   children.add(child);let errors='';child.stderr.on('data',c=>{errors+=c;});
   const stage=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('crash stage timeout: '+errors)),8000);
    child.once('message',m=>{clearTimeout(timer);resolve(m);});child.once('error',e=>{clearTimeout(timer);reject(e);});
    child.once('exit',()=>{clearTimeout(timer);reject(Error('child exited before breakpoint: '+errors));});
   });
   assert.equal(stage.pid,child.pid);assert.equal(stage.owner,owner);assert.equal(stage.run,run);assert.equal(stage.stage,stageName);
   const before=(await api('pro_payment_orders?order_id=eq.'+id))[0];
   const committed=stageName==='after-commit-response-lost';assert.equal(stage.committed,committed);
   assert.equal(before.status,committed?'activated':'unresolved');assert.equal(before.payment_status,committed?'paid':'unknown');
   const exit=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));assert.ok(child.kill('SIGKILL'));const terminated=await exit;children.delete(child);assert.equal(terminated.signal,'SIGKILL');
   const after=(await api('pro_payment_orders?order_id=eq.'+id))[0];assert.deepEqual(after,before);assert.equal((await api('user_profiles?user_id=eq.'+user))[0].pro,committed);
   install(raw);const callsBefore=providerCalls;const denied=await worker.fetch(request(id),env);assert.equal(denied.status,200);assert.equal(providerCalls,callsBefore,'Live lease/cooldown refuses another provider query');
   if(!committed){
    assert.ok((await api('pro_payment_order_query_leases?order_id=eq.'+id))[0].lease_token);
    await stack.sql(`update pro_payment_order_query_leases set lease_until=clock_timestamp()-interval '1 second' where order_id=${quote(id)};
     update pro_payment_orders set next_retry_at=clock_timestamp()-interval '1 second' where order_id=${quote(id)};`);
    const recovered=await worker.fetch(request(id),env);assert.equal(recovered.status,200);
   }
   assert.equal((await api('pro_payment_orders?order_id=eq.'+id))[0].status,'activated');assert.equal((await api('user_profiles?user_id=eq.'+user))[0].pro,true);
   assert.equal((await api('pro_payment_intents?user_id=eq.'+user))[0].status,'activated');
   assert.equal((await api('pro_activations?order_id=eq.'+id)).length,1);
   reports.push({point:stageName,registeredOwnedChildGuard:stage,terminated,leaseBeforeExpiryRefused:true,activatedOnce:true,commitPreserved:committed});
  }
  console.log(JSON.stringify({passed:reports.length,physicalSignal:'SIGKILL',database:stack.version,rest:'PostgREST14.14',reports},null,2));
 }finally{
  globalThis.fetch=realFetch;for(const child of children)child.kill('SIGKILL');
  writeFileSync(output+'/worker-physical-crash-results.json',JSON.stringify(reports,null,2));await stack.close();
 }
}
