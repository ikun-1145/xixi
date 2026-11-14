import test from 'node:test';
import assert from 'node:assert/strict';
import { PhoneAuthCoordinator, LEDGER_KEY } from '../coordinator.js';
import { turnstileProbe } from '../turnstile-probe.js';

const admin='synthetic-admin-token-with-at-least-32-characters';
const timestamp=Date.parse('2026-01-01T00:00:00Z');
const token='synthetic-turnstile-token';
const good={success:true,hostname:'sunland.dev',action:'phone_login',challenge_ts:new Date(timestamp).toISOString()};
const request=(value=token,authorization='Bearer '+admin)=>new Request('https://api.sunland.dev/v1/phone/_admin/turnstile-probe',{
  method:'POST',headers:{'Content-Type':'application/json',Authorization:authorization},body:JSON.stringify({token:value}) });
const readBody=async request=>({value:await request.json()});
class Storage {
  data=new Map(); tail=Promise.resolve();
  async transaction(fn) { const before=this.tail;let release;this.tail=new Promise(r=>release=r);await before;
    try {const d=structuredClone(this.data);const tx={get:async k=>structuredClone(d.get(k)),put:async(k,v)=>d.set(k,structuredClone(v)),
      delete:async k=>d.delete(k),list:async({prefix='',startAfter='',limit=32}={})=>new Map([...d].filter(([k])=>k.startsWith(prefix)&&k>startAfter).sort().slice(0,limit))};
      const value=await fn(tx);this.data=d;return value;
    } finally {release();} }
}
async function fixture(initialized=true) {
  const storage=new Storage(), calls=[];let clock=timestamp;
  const env={PHONE_AUTH_ADMIN_TOKEN:admin,PHONE_AUTH_HMAC_KEY:'synthetic-hmac-token-at-least-32-characters', PHONE_AUTH_HMAC_KEY_ID:'v1',
    TURNSTILE_SECRET:'synthetic-secret',PHONE_TURNSTILE_HOSTNAME:'sunland.dev',PHONE_TURNSTILE_DIAGNOSTICS_ENABLED:'true',
    PHONE_IDENTITY_ENABLED:'false',PHONE_SMS_ENABLED:'false',PHONE_NEW_REGISTRATION_ENABLED:'false',PHONE_RELEASE_MODE:'public',
    PHONE_SMS_PROVIDER:'relay',SMS_RELAY_URL:'https://relay.invalid/send',SUNLAND_SMS_RELAY_KEY:'synthetic-relay-key',
    PHONE_AUTH_POLICY:JSON.stringify({perPhoneDaily:10,perIpDaily:10,dailyLimit:10,unitCostMicros:1,dailyBudgetMicros:10,totalBudgetMicros:10,ipRequestsPerMinute:20,globalRequestsPerMinute:20})};
  const fetchImpl=async(url,init)=>{const host=new URL(url).hostname;calls.push(host);if(host==='challenges.cloudflare.com'){assert.equal(init.cache,'no-store');return Response.json(good);}
    assert.equal(host,'relay.invalid');return Response.json({ok:1});};
  const coordinator=new PhoneAuthCoordinator({storage},env,{now:()=>clock,fetchImpl});
  env.PHONE_AUTH_COORDINATOR={getByName:()=>({fetch:req=>coordinator.fetch(req)})};
  if(initialized){const r=await coordinator.fetch(new Request('https://internal/initialize',{method:'POST',headers:{Authorization:'Bearer '+admin},body:'{}'}));assert.equal(r.status,200);}
  const probe=(value=token,options={})=>turnstileProbe(request(value,options.authorization),env,{readBody,now:()=>timestamp,fetchImpl:options.fetchImpl||fetchImpl,timeoutMs:options.timeoutMs||5000});
  const send=value=>coordinator.send({phone:'13800000000',purpose:'login',turnstile_token:value,challenge_id:crypto.randomUUID()},{ip:'192.0.2.1'});
  return {env,storage,calls,coordinator,probe,send,setNow:value=>{clock=value;}};
}

test('diagnostic defaults off without touching the DO or network',async()=>{
  const h=await fixture(false);delete h.env.PHONE_TURNSTILE_DIAGNOSTICS_ENABLED;
  Object.defineProperty(h.env,'PHONE_AUTH_COORDINATOR',{get(){assert.fail('DO touched')}});
  assert.equal((await h.probe()).status,503);assert.equal(h.storage.data.size,0);assert.equal(h.calls.length,0);
});
test('uninitialized ledger rejects diagnostic without markers or blocking initialization',async()=>{
  const h=await fixture(false);assert.equal((await h.probe()).status,503);assert.equal(h.storage.data.size,0);assert.equal(h.calls.length,0);
  const r=await h.coordinator.fetch(new Request('https://internal/initialize',{method:'POST',headers:{Authorization:'Bearer '+admin},body:'{}'}));assert.equal(r.status,200);
});
test('first probe succeeds but duplicate and concurrent probes cannot reach Siteverify',async()=>{
  const h=await fixture();const before=structuredClone(h.storage.data.get(LEDGER_KEY));
  const results=await Promise.all([h.probe(),h.probe()]);assert.deepEqual(results.map(r=>r.status).sort(),[200,403]);
  assert.equal((await h.probe()).status,403);assert.equal(h.calls.length,1);assert.deepEqual(h.storage.data.get(LEDGER_KEY),before);
  assert.equal(JSON.stringify([...h.storage.data]).includes(token),false);
});
test('invalid and expired tokens fail closed and cannot be replayed',async()=>{
  for(const response of [{success:false},{challenge_ts:new Date(timestamp-300001).toISOString()}]){
    const h=await fixture();assert.equal((await h.probe(token,{fetchImpl:async()=>Response.json({...good,...response})})).status,403);
    assert.equal((await h.probe()).status,403);assert.equal(h.calls.length,0);
  }
});
test('diagnostic advances the monotonic clock without spending and rejects clock rollback',async()=>{
  const h=await fixture();h.setNow(timestamp+1000);assert.equal((await h.probe()).status,200);
  const account=structuredClone(h.storage.data.get(LEDGER_KEY));assert.equal(account.lastNow,timestamp+1000);assert.equal(account.totalMicros,0);
  h.setNow(timestamp);assert.equal((await h.probe('another-token')).status,503);
  assert.deepEqual(h.storage.data.get(LEDGER_KEY),account);assert.equal(h.calls.length,1);
});
test('send and diagnostic share a single token claim without changing budget on replay',async()=>{
  const a=await fixture();assert.equal((await a.probe()).status,200);a.env.PHONE_SMS_ENABLED='true';
  await assert.rejects(a.send(token),{code:'CAPTCHA_FAILED'});assert.equal(a.storage.data.get(LEDGER_KEY).totalMicros,0);
  const b=await fixture();b.env.PHONE_SMS_ENABLED='true';await b.send(token);const cost=b.storage.data.get(LEDGER_KEY).totalMicros;
  b.env.PHONE_SMS_ENABLED='false';assert.equal((await b.probe()).status,403);assert.equal(b.storage.data.get(LEDGER_KEY).totalMicros,cost);
});
test('bad admin, gates, and upstream error never expose response data or retry',async()=>{
  const h=await fixture();assert.equal((await h.probe(token,{authorization:'Bearer bad'})).status,401);
  h.env.PHONE_SMS_ENABLED='true';assert.equal((await h.probe()).status,403);h.env.PHONE_SMS_ENABLED='false';
  let count=0;const res=await h.probe(token,{fetchImpl:async()=>{count++;throw Error('sensitive');}});
  assert.equal(res.status,503);assert.equal(await res.text(),'{"ok":false}');assert.equal(count,1);assert.equal((await h.probe()).status,403);
});
