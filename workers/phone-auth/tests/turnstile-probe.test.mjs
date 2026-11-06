import test from 'node:test';
import assert from 'node:assert/strict';
import { turnstileProbe } from '../turnstile-probe.js';
const admin='synthetic-admin-token-with-at-least-32-characters';
const env=()=>({PHONE_AUTH_ADMIN_TOKEN:admin,TURNSTILE_SECRET:'synthetic-secret',PHONE_TURNSTILE_HOSTNAME:'sunland.dev',PHONE_IDENTITY_ENABLED:'false',PHONE_SMS_ENABLED:'false',PHONE_NEW_REGISTRATION_ENABLED:'false',get PHONE_AUTH_COORDINATOR(){assert.fail('DO must not be touched');}});
const timestamp=Date.parse('2026-01-01T00:00:00Z');
const input=(body={token:'synthetic-token'},authorization='Bearer '+admin)=>new Request('https://api.sunland.dev/v1/phone/_admin/turnstile-probe',{method:'POST',headers:{'Content-Type':'application/json',Authorization:authorization},body:JSON.stringify(body)});
const readBody=async request=>({value:await request.json()});
const good={success:true,hostname:'sunland.dev',action:'phone_login',challenge_ts:new Date(timestamp).toISOString()};
const invoke=(request=input(),e=env(),options={})=>turnstileProbe(request,e,{readBody,now:()=>timestamp,fetchImpl:async()=>Response.json(good),...options});
test('admin only and all three feature gates must be explicitly off before network',async()=>{
 let calls=0;const opts={fetchImpl:async()=>{calls++;return Response.json(good);}};
 assert.equal((await invoke(input({token:'synthetic-token'},'Bearer bad'),env(),opts)).status,401);
 for(const k of ['PHONE_IDENTITY_ENABLED','PHONE_SMS_ENABLED','PHONE_NEW_REGISTRATION_ENABLED']){const e=env();e[k]='true';assert.equal((await invoke(input(),e,opts)).status,403);delete e[k];assert.equal((await invoke(input(),e,opts)).status,403);}
 assert.equal(calls,0);
});
test('strict body validation fails before upstream',async()=>{
 let calls=0;for(const value of [{},{token:''},{token:'x',phone:'13800000000'},[],{token:'x'.repeat(2049)}]){
  assert.equal((await invoke(input(value),env(),{fetchImpl:async()=>{calls++;return Response.json(good);}})).status,400);
 }assert.equal(calls,0);
});
test('only matching real siteverify response returns true; replay and mismatches fail',async()=>{
 let calls=0;const used=new Set();const fetchImpl=async(url,init)=>{calls++;assert.equal(url,'https://challenges.cloudflare.com/turnstile/v0/siteverify');assert.equal(init.redirect,'manual');const body=JSON.parse(init.body);assert.deepEqual(body,{secret:'synthetic-secret',response:'synthetic-token'});if(used.has(body.response))return Response.json({success:false});used.add(body.response);return Response.json(good);};
 let res=await invoke(input(),env(),{fetchImpl});assert.equal(res.status,200);assert.deepEqual(await res.json(),{ok:true});assert.equal(res.headers.get('cache-control'),'no-store');
 res=await invoke(input(),env(),{fetchImpl});assert.equal(res.status,403);assert.deepEqual(await res.json(),{ok:false});assert.equal(calls,2);
 for(const bad of [{hostname:'evil.example'},{action:'phone_reauth'},{challenge_ts:new Date(timestamp-300001).toISOString()},{challenge_ts:new Date(timestamp+30001).toISOString()},{success:false}]){
  res=await invoke(input(),env(),{fetchImpl:async()=>Response.json({...good,...bad})});assert.equal(res.status,403);assert.deepEqual(await res.json(),{ok:false});
 }
});
test('redirect, HTTP error, malformed JSON, timeout and exception stay sanitized without retry',async()=>{
 for(const fetchImpl of [async()=>new Response('',{status:302,headers:{location:'https://bad.invalid'}}),async()=>Response.json(good,{status:500}),async()=>new Response('secret raw token'),async()=>{throw Error('secret raw token');},()=>new Promise(()=>{})]){
  let calls=0;const res=await invoke(input(),env(),{timeoutMs:5,fetchImpl:(...args)=>{calls++;return fetchImpl(...args);}});const text=await res.text();assert.notEqual(res.status,200);assert.equal(text,'{"ok":false}');assert.equal(calls,1);
 }
});
