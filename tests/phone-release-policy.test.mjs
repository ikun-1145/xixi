import test from 'node:test';
import assert from 'node:assert/strict';
import { PhoneAuthCoordinator, LEDGER_KEY } from '../workers/phone-auth/coordinator.js';
import { createPhoneIdentity } from '../workers/phone-auth/identity.js';

const START = Date.parse('2026-10-24T00:00:00Z');
const secret = 'release-test-hmac-secret-at-least-32-bytes';
const admin = 'release-test-admin-token-at-least-32-bytes';
const phones = Array.from({length:5}, (_,i) => `1380000000${i}`);
async function phoneHash(phone) {
  const key = await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return Buffer.from(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`phone\0${phone}`))).toString('hex');
}
class Storage {
  data = new Map(); tail = Promise.resolve();
  async transaction(fn) {
    const previous=this.tail; let release; this.tail=new Promise(r=>{release=r;}); await previous;
    try {
      const data=structuredClone(this.data);
      const tx={get:async k=>structuredClone(data.get(k)),put:async(k,v)=>data.set(k,structuredClone(v)),delete:async k=>data.delete(k),
        list:async({prefix='',startAfter='',limit=32}={})=>new Map([...data].filter(([k])=>k.startsWith(prefix)&&k>startAfter).sort().slice(0,limit))};
      const result=await fn(tx); this.data=data; return result;
    } finally { release(); }
  }
}
async function fixture() {
  let now=START, tokenSequence=0; const storage=new Storage(); const calls=[];
  const env={PHONE_SMS_ENABLED:'true',PHONE_RELEASE_MODE:'canary',PHONE_AUTH_HMAC_KEY:secret,PHONE_AUTH_HMAC_KEY_ID:'test-v1',PHONE_AUTH_ADMIN_TOKEN:admin,
    PHONE_SMS_CANARY_PHONE_HASHES:JSON.stringify(await Promise.all(phones.slice(0,4).map(phoneHash))),
    PHONE_AUTH_POLICY:JSON.stringify({perPhoneDaily:10,perIpDaily:20,dailyLimit:20,unitCostMicros:1,dailyBudgetMicros:20,totalBudgetMicros:100,ipRequestsPerMinute:50,globalRequestsPerMinute:100}),
    TURNSTILE_SECRET:'mock',PHONE_TURNSTILE_HOSTNAME:'sunland.dev',PHONE_ALIYUN_ACCESS_KEY_ID:'mock',PHONE_ALIYUN_ACCESS_KEY_SECRET:'mock',PHONE_SMS_SIGN_NAME:'mock',PHONE_SMS_TEMPLATE_CODE:'mock'};
  const fetchImpl=async(url,options)=>{
    const captcha=new URL(url).hostname==='challenges.cloudflare.com'; calls.push(captcha?'captcha':'supplier');
    if(captcha) return Response.json({success:true,hostname:'sunland.dev',action:`phone_${JSON.parse(options.body).response.split(':')[0]}`,challenge_ts:new Date(now).toISOString()});
    if(h.providerFailure) return Response.json({Success:false,Code:'isv.BUSINESS_LIMIT_CONTROL'});
    return Response.json({Success:true,Code:'OK'});
  };
  const h={env,storage,calls,advance(ms){now+=ms;},rebuild(){h.do=new PhoneAuthCoordinator({storage},env,{now:()=>now,fetchImpl});},
    send(phone=phones[0],purpose='login'){return h.do.send({phone,purpose,turnstile_token:`${purpose}:${++tokenSequence}`},{ip:'192.0.2.1',userId:'u',sessionId:'server-session-123456',identityStatus:'active',reauthenticatedAt:now});},
    admin(path,token=admin,body={}){return h.do.fetch(new Request(`https://phone-auth.internal/${path}`,{method:'POST',headers:{Authorization:`Bearer ${token}`},body:JSON.stringify(body)}));}};
  h.rebuild(); return h;
}
test('canary persistent reservation cap survives concurrency, next day, restart and mode switch',async()=>{
  const h=await fixture(); assert.equal((await h.admin('initialize')).status,200);
  const sends=await Promise.allSettled(phones.slice(0,4).map(p=>h.send(p)));
  assert.equal(sends.filter(r=>r.status==='fulfilled').length,3);
  assert.equal(sends.filter(r=>r.reason?.code==='CANARY_LIMITED').length,1);
  assert.equal(h.calls.filter(c=>c==='supplier').length,3);
  h.advance(86400000); h.rebuild(); await assert.rejects(h.send(phones[3]),{code:'CANARY_LIMITED'});
  h.env.PHONE_RELEASE_MODE='public'; await h.send(phones[3]);
  h.env.PHONE_RELEASE_MODE='canary'; h.advance(86400000);h.rebuild();await assert.rejects(h.send(phones[3]),{code:'CANARY_LIMITED'});
  assert.equal(h.storage.data.get(LEDGER_KEY).testReserved,3);
});
test('canary fails closed for malformed mode, allowlist, all unapproved purposes and failed sends count',async()=>{
  const h=await fixture(); await h.admin('initialize');
  for(const mode of [undefined,'CANARY','']){h.env.PHONE_RELEASE_MODE=mode;await assert.rejects(h.send(),{code:'RELEASE_CONFIG'});}
  h.env.PHONE_RELEASE_MODE='canary';
  for(const purpose of ['login','bind','change','unbind','reauth']) await assert.rejects(h.send(phones[4],purpose),{code:'CANARY_DENIED'});
  assert.equal(h.calls.length,0);
  for(const list of ['[]','bad',JSON.stringify([phones[0]]),JSON.stringify(['a'.repeat(64),'a'.repeat(64)])]){
    h.env.PHONE_SMS_CANARY_PHONE_HASHES=list;await assert.rejects(h.send(),{code:'RELEASE_CONFIG'});
  }
  h.env.PHONE_SMS_CANARY_PHONE_HASHES=JSON.stringify(await Promise.all(phones.slice(0,4).map(phoneHash)));
  h.providerFailure=true;for(const p of phones.slice(0,3))await assert.rejects(h.send(p));
  await assert.rejects(h.send(phones[3]),{code:'CANARY_LIMITED'});
  assert.equal(h.storage.data.get(LEDGER_KEY).testReserved,3);
});
test('initialization requires independent admin and preserves existing state',async()=>{
  const h=await fixture();assert.equal((await h.admin('initialize','wrong')).status,401);assert.equal(h.storage.data.size,0);
  h.env.PHONE_AUTH_ADMIN_TOKEN='short';assert.equal((await h.admin('initialize','short')).status,503);h.env.PHONE_AUTH_ADMIN_TOKEN=admin;
  h.storage.data.set('t:phone:old',{quarantined:true});assert.equal((await h.admin('initialize')).status,409);h.storage.data.clear();
  assert.equal((await h.admin('initialize')).status,200);const saved=structuredClone(h.storage.data);
  assert.equal((await h.admin('initialize')).status,200);assert.deepEqual(h.storage.data,saved);
  const status=await(await h.admin('status')).json();assert.equal(status.test_reserved,0);assert.ok(!JSON.stringify(status).includes('phone:'));
  h.storage.data.get(LEDGER_KEY).testReserved=undefined;await assert.rejects(h.send(),{code:'SERVICE_UNAVAILABLE'});
});
test('initialization uses server values only, is safe with SMS off, and is never automatic',async()=>{
  const h=await fixture();h.env.PHONE_SMS_ENABLED='false';
  await assert.rejects(h.send(),{code:'SMS_DISABLED'});assert.equal(h.storage.data.size,0);
  const response=await h.admin('initialize',admin,{testReserved:-100,keyId:'attacker',enabled:false,totalMicros:-100});
  assert.equal(response.status,200);const account=h.storage.data.get(LEDGER_KEY);
  assert.equal(account.testReserved,0);assert.equal(account.keyId,'test-v1');assert.equal(account.enabled,true);
  assert.equal(account.lastNow,START);assert.equal(h.calls.length,0);
  const serialized=JSON.stringify(await(await h.admin('status')).json());
  for(const forbidden of [secret,admin,'test-v1','13800000000','phoneHash','challengeId','lockUntil'])assert.equal(serialized.includes(forbidden),false);
  h.env.PHONE_AUTH_ADMIN_TOKEN=secret;assert.equal((await h.admin('status',secret)).status,503);
});
test('concurrent initialization is idempotent and does not repair legacy state',async()=>{
  const h=await fixture();const responses=await Promise.all([h.admin('initialize'),h.admin('initialize')]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,200]);
  const original=structuredClone(h.storage.data.get(LEDGER_KEY));delete h.storage.data.get(LEDGER_KEY).testReserved;
  const legacy=structuredClone(h.storage.data);assert.equal((await h.admin('initialize')).status,409);
  assert.equal((await (await h.admin('status')).json()).state,'abnormal');assert.deepEqual(h.storage.data,legacy);
  assert.equal(original.totalMicros,0);
});
test('status is storage-read-only and distinguishes empty, foreign, version and configuration states',async()=>{
  const h=await fixture();
  assert.equal((await (await h.admin('status')).json()).state,'uninitialized');assert.equal(h.storage.data.size,0);
  h.storage.data.set('foreign',1);assert.equal((await (await h.admin('status')).json()).state,'abnormal');
  assert.equal((await h.admin('initialize')).status,409);h.storage.data.clear();
  await h.admin('initialize');const before=structuredClone(h.storage.data);h.advance(86400000);
  assert.equal((await (await h.admin('status')).json()).state,'ready');assert.deepEqual(h.storage.data,before);
  assert.equal((await h.admin('initialize')).status,200);assert.deepEqual(h.storage.data,before);
  h.storage.data.get(LEDGER_KEY).schema=2;assert.equal((await (await h.admin('status')).json()).state,'incompatible');
  assert.equal((await h.admin('initialize')).status,409);h.storage.data=structuredClone(before);
  h.env.PHONE_AUTH_POLICY=JSON.stringify({...JSON.parse(h.env.PHONE_AUTH_POLICY),dailyLimit:19});
  assert.equal((await (await h.admin('status')).json()).state,'incompatible');assert.equal((await h.admin('initialize')).status,409);
  assert.deepEqual(h.storage.data,before);
  h.env.PHONE_AUTH_POLICY=JSON.stringify({...JSON.parse(h.env.PHONE_AUTH_POLICY),dailyLimit:20});
  delete h.storage.data.get(LEDGER_KEY).initConfig;
  assert.equal((await (await h.admin('status')).json()).state,'unverified');assert.equal((await h.admin('initialize')).status,409);
});
test('storage failures do not create or reset a ledger and can recover safely',async()=>{
  const h=await fixture();const transaction=h.storage.transaction.bind(h.storage);
  h.storage.transaction=async()=>{throw Error('synthetic failure');};
  assert.equal((await h.admin('status')).status,503);assert.equal((await h.admin('initialize')).status,503);
  assert.equal(h.storage.data.size,0);h.storage.transaction=transaction;
  assert.equal((await (await h.admin('status')).json()).state,'uninitialized');
  h.storage.transaction=fn=>transaction(tx=>fn({...tx,put:async(k,v)=>{await tx.put(k,v);throw Error('synthetic post-write failure');}}));
  assert.equal((await h.admin('initialize')).status,503);assert.equal(h.storage.data.size,0);h.storage.transaction=transaction;
  assert.equal((await h.admin('initialize')).status,200);const before=structuredClone(h.storage.data);
  h.storage.transaction=async()=>{throw Error('synthetic failure');};assert.equal((await h.admin('initialize')).status,503);
  assert.deepEqual(h.storage.data,before);h.storage.transaction=transaction;
  assert.equal((await (await h.admin('status')).json()).state,'ready');
});
test('new registration policy is a trusted strict server boolean and known denial remains classified',async()=>{
  for(const value of [undefined,false,true,'false','true']) {
    let data; const env={PHONE_IDENTITY_ENABLED:'true',PHONE_NEW_REGISTRATION_ENABLED:value,PHONE_IDENTITY_LOOKUP_KEY:secret,PHONE_IDENTITY_LOOKUP_KEY_ID:'v1',
      PHONE_IDENTITY_ENCRYPTION_KEYS:JSON.stringify({v1:Buffer.alloc(32,7).toString('base64url')}),PHONE_IDENTITY_ENCRYPTION_KEY_ID:'v1',PHONE_AUTH_HMAC_KEY:secret};
    const identity=createPhoneIdentity(env,{rpc:async(_,{p_data})=>{data=p_data;return{ok:true,payload:{code:'REGISTRATION_DISABLED'}};}});
    await assert.rejects(identity.login({phone:phones[0],operationId:crypto.randomUUID(),allow_create:true}),{code:'REGISTRATION_DISABLED'});
    assert.equal(data.allow_create,value==='true');
  }
});
