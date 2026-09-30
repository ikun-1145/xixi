// Physical termination of an owned Node Worker fixture process; real isolated REST ledger.
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import worker from '../workers/afdianpay/worker.js';
const endpoint='http://127.0.0.1:54329';const database='sunland_payment_phase3_lab';
const enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url');const text=enc({alg:'HS256',typ:'JWT'})+'.'+enc({role:'service_role',exp:Math.floor(Date.now()/1000)+3600});
const service=text+'.'+createHmac('sha256','sunland-payment-phase3-synthetic-jwt-secret-2026').update(text).digest('base64url');
const env={SUPABASE_URL:endpoint,SUPABASE_KEY:service,USER_ID:'synthetic',TOKEN:'synthetic',ADMIN_TOKEN:'synthetic-admin'};
const realFetch=globalThis.fetch;
const api=async(path,method='GET',body=null)=>{const r=await realFetch(endpoint+'/'+path,{method,headers:{Authorization:'Bearer '+service,'Content-Type':'application/json',Prefer:'return=representation'},...(body?{body:JSON.stringify(body)}:{})});const d=await r.json().catch(()=>null);assert.ok(r.ok,JSON.stringify(d));return d;};
function install(raw,point=null){globalThis.fetch=async(url,init)=>{
 const value=String(url);
 const pause=()=>{process.send({database,stage:point,pid:process.pid,run:process.env.SUNLAND_CRASH_RUN});return new Promise(()=>{});};
 if(value==='https://ifdian.net/api/open/query-order'){
  if(point==='before-provider-query')return pause();
  return Response.json({ec:200,data:{total_page:1,list:[raw]}});
 }
 if(point==='after-provider-query'&&value.includes('rpc/sunland_process_verified_pro_order'))return pause();
 return realFetch(value.replace(endpoint+'/rest/v1/',endpoint+'/'),init);
};}
const request=id=>new Request('https://afdianpay.sunland.dev/admin/reconcile',{method:'POST',headers:{Authorization:'Bearer synthetic-admin'},body:JSON.stringify({out_trade_no:id})});
if(process.env.SUNLAND_CRASH_POINT){
 process.on('message',()=>{});const raw=JSON.parse(process.env.SUNLAND_CRASH_ORDER);install(raw,process.env.SUNLAND_CRASH_POINT);await worker.fetch(request(raw.out_trade_no),env);
}else{
 const report=[];
 try{for(const point of ['before-provider-query','after-provider-query']){
  const run=randomUUID();const user='lab-physical-'+run.slice(0,8),ref=randomUUID(),id='lab-physical-order-'+run.slice(0,8);
  await api('user_profiles','POST',{user_id:user,pro:false});await api('pro_payment_intents','POST',{payment_reference:ref,user_id:user});
  const raw={out_trade_no:id,status:2,product_type:0,plan_id:'4c2527fc6c7411f1bbe45254001e7c00',total_amount:'10.00',custom_order_id:ref};
  const child=fork(new URL(import.meta.url),[],{env:{...process.env,SUNLAND_CRASH_POINT:point,SUNLAND_CRASH_ORDER:JSON.stringify(raw),SUNLAND_CRASH_RUN:run},stdio:['ignore','pipe','pipe','ipc']});
  const stage=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('crash stage timeout')),5000);child.once('message',m=>{clearTimeout(timer);resolve(m);});child.once('error',reject);});
  assert.equal(stage.pid,child.pid);assert.equal(stage.database,database);assert.equal(stage.run,run);assert.equal(stage.stage,point);
  const before=await api('pro_payment_orders?order_id=eq.'+id);assert.equal(before[0].status,'unresolved');assert.equal(before[0].payment_status,'unknown');
  const exit=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));assert.ok(child.kill('SIGKILL'));const terminated=await exit;assert.equal(terminated.signal,'SIGKILL');
  const after=await api('pro_payment_orders?order_id=eq.'+id);const profile=await api('user_profiles?user_id=eq.'+user);assert.equal(profile[0].pro,false);assert.equal(after[0].status,'unresolved');
  await api('pro_payment_orders?order_id=eq.'+id,'PATCH',{next_retry_at:'2000-01-01T00:00:00Z'});install(raw);const result=await worker.fetch(request(id),env);assert.equal(result.status,200);
  const recovered=await api('pro_payment_orders?order_id=eq.'+id);assert.equal(recovered[0].status,'activated');assert.equal((await api('user_profiles?user_id=eq.'+user))[0].pro,true);assert.equal((await api('pro_payment_intents?user_id=eq.'+user))[0].status,'activated');
  report.push({point,registeredOwnedChildGuard:stage,terminated,before,after,profile,recovered,provider:'synthetic HTTPS interception',db:'real isolated PostgreSQL'});
 }
 }finally{globalThis.fetch=realFetch;writeFileSync('/tmp/sunland-payment-phase3/worker-physical-crash-results.json',JSON.stringify(report,null,2));}
 console.log('Physical Worker process crash/recovery: '+report.length+' PASS');
}
