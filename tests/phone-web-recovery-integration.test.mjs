import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { PhoneAuthCoordinator } from '../workers/phone-auth/coordinator.js';
import { createPhoneAuthWorker } from '../workers/phone-auth/routes.js';

mock.method(globalThis, 'fetch', async () => { throw Error('Live network forbidden'); });
class Storage {
  data = new Map(); tail = Promise.resolve();
  async transaction(fn) {
    const before=this.tail; let release; this.tail=new Promise(r=>{release=r;}); await before;
    try {
      const data=structuredClone(this.data);
      const tx={get:async k=>structuredClone(data.get(k)),put:async(k,v)=>data.set(k,structuredClone(v)),
        delete:async k=>data.delete(k),list:async({prefix='',startAfter='',limit=32}={})=>new Map([...data]
          .filter(([k])=>k.startsWith(prefix)&&k>startAfter).sort().slice(0,limit))};
      const result=await fn(tx);this.data=data;return result;
    } finally {release();}
  }
}

test('lost HTTP response retains client handle for one-time verification through route and DO',async t=>{
  const storage=new Storage(), now=Date.now();let relayCalls=0,code;
  const env={PHONE_SMS_ENABLED:'true',PHONE_IDENTITY_ENABLED:'true',PHONE_RELEASE_MODE:'public',PHONE_SMS_PROVIDER:'relay',
    PHONE_AUTH_HMAC_KEY:'synthetic-hmac-secret-at-least-32-characters',PHONE_AUTH_HMAC_KEY_ID:'v1',
    PHONE_AUTH_ADMIN_TOKEN:'synthetic-admin-token-at-least-32-characters',SMS_RELAY_URL:'https://relay.invalid/send',
    SUNLAND_SMS_RELAY_KEY:'synthetic-relay-key',TURNSTILE_SECRET:'synthetic-turnstile',PHONE_TURNSTILE_HOSTNAME:'sunland.dev',
    PHONE_AUTH_POLICY:JSON.stringify({perPhoneDaily:3,perIpDaily:3,dailyLimit:3,unitCostMicros:1,dailyBudgetMicros:3,
      totalBudgetMicros:3,ipRequestsPerMinute:20,globalRequestsPerMinute:30})};
  const coordinator=new PhoneAuthCoordinator({storage},env,{now:()=>now,fetchImpl:async(url,init)=>{
    if(new URL(url).hostname==='challenges.cloudflare.com')return Response.json({success:true,hostname:'sunland.dev',action:'phone_login',challenge_ts:new Date(now).toISOString()});
    assert.equal(new URL(url).hostname,'relay.invalid');relayCalls++;code=JSON.parse(init.body).code;return Response.json({ok:1});
  }});
  const init=await coordinator.fetch(new Request('https://internal/initialize',{method:'POST',headers:{Authorization:'Bearer '+env.PHONE_AUTH_ADMIN_TOKEN},body:'{}'}));
  assert.equal(init.status,200);
  env.PHONE_AUTH_COORDINATOR={getByName:()=>({fetch:r=>coordinator.fetch(r)})};
  const hooks={readJsonBodyWithLimit:async r=>({value:await r.json()}),json:(v,status)=>Response.json(v,{status}),
    applicationSigningSecret:()=> 'synthetic-signing-key',getUserStatus:async()=>({}),accountStatusRejection:()=>null,
    signJWT:async()=> 'synthetic-jwt',callIdentityRpc:async()=>{throw Error('must use mocked identity');}};
  const worker=createPhoneAuthWorker({fetch:async()=>new Response(null,{status:404})},hooks,{
    loginOnly:true,identityFactory:()=>({login:async()=>({user_id:'synthetic-user',email:null,onboarding:{version:0,step:1},is_new_user:true})})});
  let sends=0;
  const fetchImpl=async(url,init)=>{
    const request=new Request(url,{...init,headers:{...init.headers,'CF-Connecting-IP':'192.0.2.1'}});
    const response=await worker.fetch(request,env,{});
    if(new URL(url).pathname.endsWith('/send-code')){sends++;assert.equal(response.status,200);throw Error('synthetic lost response');}
    return response;
  };
  const dom=new JSDOM('<meta name="sunland-turnstile-sitekey" content="synthetic">',{url:'https://sunland.dev',runScripts:'outside-only'});
  t.after(()=>dom.window.close());dom.window.AbortController=AbortController;dom.window.crypto.randomUUID=crypto.randomUUID.bind(crypto);
  dom.window.eval(readFileSync(new URL('../p/js/phone-auth.js',import.meta.url),'utf8'));
  const options={getToken:()=>null,captcha:async()=> 'synthetic-captcha',fetchImpl};
  const client=dom.window.SunlandPhoneAuth.createClient(options);
  await assert.rejects(client.send('13800000000','login'),{code:'SEND_UNCERTAIN'});
  const saved=dom.window.sessionStorage.getItem('sunland.phone.pending.v1');
  assert.ok(saved);assert.equal(saved.includes('13800000000'),false);assert.equal(saved.includes(code),false);
  const resumed=dom.window.SunlandPhoneAuth.createClient(options);const handle=resumed.recovery('login');
  assert.ok(handle?.challenge_id);await assert.rejects(resumed.send('13800000000','login'),{code:'SEND_UNCERTAIN'});
  const result=await resumed.login('13800000000',handle.challenge_id,code);
  assert.equal(result.user.id,'synthetic-user');assert.equal(sends,1);assert.equal(relayCalls,1);
  await assert.rejects(resumed.login('13800000000',handle.challenge_id,code),{code:'CHALLENGE_USED'});
});
