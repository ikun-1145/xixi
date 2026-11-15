// Local workerd and SQLite only. All upstream calls are synthetic.
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { createRequire } from 'node:module';
import { buildStandalonePhoneWorker } from '../../../scripts/build-phone-auth-worker.mjs';
const require=createRequire(resolve(process.env.SUNLAND_AUTH_WORKER_ROOT,'package.json'));
const {Miniflare,Log,LogLevel,convertV4MiniflareOptions}=require('miniflare');
const {code:script}=await buildStandalonePhoneWorker();
const root=await mkdtemp(join(tmpdir(),'phone-probe-workerd-'));
const admin='synthetic-admin-token-with-at-least-32-characters';let verifyCalls=0,relayCalls=0;
const bindings={PHONE_AUTH_ADMIN_TOKEN:admin,PHONE_AUTH_HMAC_KEY:'synthetic-hmac-key-at-least-32-characters',PHONE_AUTH_HMAC_KEY_ID:'v1',
 TURNSTILE_SECRET:'synthetic-secret',PHONE_TURNSTILE_HOSTNAME:'sunland.dev',PHONE_TURNSTILE_DIAGNOSTICS_ENABLED:'true',
 PHONE_IDENTITY_ENABLED:'false',PHONE_SMS_ENABLED:'false',PHONE_NEW_REGISTRATION_ENABLED:'false',PHONE_RELEASE_MODE:'public',
 PHONE_SMS_PROVIDER:'relay',SMS_RELAY_URL:'https://relay.invalid/send',SUNLAND_SMS_RELAY_KEY:'synthetic-relay-key',
 PHONE_AUTH_POLICY:JSON.stringify({perPhoneDaily:10,perIpDaily:10,dailyLimit:10,unitCostMicros:1,dailyBudgetMicros:10,totalBudgetMicros:10,ipRequestsPerMinute:30,globalRequestsPerMinute:30})};
const options={name:'phone-auth-diagnostic',script,modules:true,compatibilityDate:'2026-03-21',host:'127.0.0.1',port:0,log:new Log(LogLevel.ERROR),cf:false,
 bindings,durableObjects:{PHONE_AUTH_COORDINATOR:{className:'PhoneAuthCoordinator',useSQLite:true}},resourcePersistencePath:join(root,'state'),
 outboundService:async request=>{const host=new URL(request.url).hostname;
  if(host==='challenges.cloudflare.com'){verifyCalls++;const body=await request.json();
   return Response.json({success:body.response!=='bad-token',hostname:'sunland.dev',action:'phone_login',challenge_ts:new Date(Date.now()-(body.response==='expired-token'?301000:0)).toISOString()});}
  assert.equal(host,'relay.invalid');relayCalls++;return Response.json({ok:1});}};
let runtime,stub;
async function start(){runtime=new Miniflare(convertV4MiniflareOptions(options));stub=(await runtime.getDurableObjectNamespace('PHONE_AUTH_COORDINATOR')).getByName('sunland-phone-auth-v1');}
async function restart(){await runtime.dispose();runtime=undefined;await start();}
const probe=(value,auth=admin)=>runtime.dispatchFetch('https://api.sunland.dev/v1/phone/_admin/turnstile-probe',{
 method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+auth},body:JSON.stringify({token:value})});
const post=(path,body={})=>stub.fetch('https://internal/'+path,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+admin},body:JSON.stringify(body)});
const send=value=>post('send',{input:{phone:'13800000000',purpose:'login',turnstile_token:value,challenge_id:crypto.randomUUID()},context:{ip:'192.0.2.1'}});
try{
 await start();assert.equal((await probe('before-init')).status,503);assert.equal(verifyCalls,0);
 assert.equal((await post('initialize')).status,200);assert.equal((await probe('bad-admin','bad')).status,401);
 const first=await Promise.all([probe('probe-token'),probe('probe-token')]);assert.deepEqual(first.map(x=>x.status).sort(),[200,403]);assert.equal(verifyCalls,1);
 await restart();assert.equal((await probe('probe-token')).status,403);assert.equal(verifyCalls,1);
 bindings.PHONE_SMS_ENABLED='true';await restart();assert.equal((await send('probe-token')).status,403);assert.equal(relayCalls,0);
 assert.equal((await send('send-token')).status,200);assert.equal(relayCalls,1);
 bindings.PHONE_SMS_ENABLED='false';await restart();assert.equal((await probe('send-token')).status,403);
 assert.equal((await probe('bad-token')).status,403);assert.equal((await probe('expired-token')).status,403);
 const budget=await(await post('status')).json();assert.equal(budget.total_micros,1);
 console.log(JSON.stringify({passed:true,runtime:'local workerd + SQLite DO',concurrent:true,cross_path:true,restart:true,invalid:true,expired:true,real_network_calls:0}));
}finally{await runtime?.dispose();await rm(root,{recursive:true,force:true});}
