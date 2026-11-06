// Local workerd only, all outbound traffic intercepted, all inputs synthetic.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { buildStandalonePhoneWorker } from '../../../scripts/build-phone-auth-worker.mjs';
const require=createRequire(resolve(process.env.SUNLAND_AUTH_WORKER_ROOT,'package.json'));
const {Miniflare,Log,LogLevel,convertV4MiniflareOptions}=require('miniflare');
const {code:script}=await buildStandalonePhoneWorker();
const admin='synthetic-admin-token-with-at-least-32-characters';let calls=0;
const options={name:'phone-auth-diagnostic',script,modules:true,compatibilityDate:'2026-03-21',host:'127.0.0.1',port:0,log:new Log(LogLevel.ERROR),cf:false,
 bindings:{PHONE_AUTH_ADMIN_TOKEN:admin,TURNSTILE_SECRET:'synthetic-secret',PHONE_TURNSTILE_HOSTNAME:'sunland.dev',PHONE_IDENTITY_ENABLED:'false',PHONE_SMS_ENABLED:'false',PHONE_NEW_REGISTRATION_ENABLED:'false'},
 outboundService:async request=>{assert.equal(new URL(request.url).hostname,'challenges.cloudflare.com');calls++;const data=await request.json();assert.deepEqual(data,{secret:'synthetic-secret',response:'synthetic-token'});return Response.json(calls===1?{success:true,hostname:'sunland.dev',action:'phone_login',challenge_ts:new Date().toISOString()}:{success:false});}};
let runtime;
try{
 runtime=new Miniflare(convertV4MiniflareOptions(options));
 const post=auth=>runtime.dispatchFetch('https://api.sunland.dev/v1/phone/_admin/turnstile-probe',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+auth},body:JSON.stringify({token:'synthetic-token'})});
 assert.equal((await post('bad')).status,401);assert.equal(calls,0);
 let response=await post(admin);assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true});
 response=await post(admin);assert.equal(response.status,403);assert.deepEqual(await response.json(),{ok:false});assert.equal(calls,2);
 console.log(JSON.stringify({passed:true,runtime:'local workerd',admin:true,replay:true,no_do_binding:true,real_network_calls:0}));
}finally{await runtime?.dispose();}
