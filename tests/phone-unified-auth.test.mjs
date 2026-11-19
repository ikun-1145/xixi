import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { PhoneAuthCoordinator } from '../workers/phone-auth/coordinator.js';
import { createPhoneAuthWorker } from '../workers/phone-auth/routes.js';
import { PhoneAuthError } from '../workers/phone-auth/errors.js';

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
const HMAC='synthetic-hmac-secret-at-least-32-characters';
const NEW_PHONE='13800000000', OLD_PHONE='13900000000';
const phoneHash=p=>createHmac('sha256',HMAC).update('phone\0'+p).digest('hex');
const proof=()=>Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');

async function setup(overrides={}) {
  const storage=new Storage();let now=Date.now();const codes=[];
  const env={PHONE_SMS_ENABLED:'false',PHONE_IDENTITY_ENABLED:'false',PHONE_RELEASE_MODE:'canary',PHONE_SMS_PROVIDER:'relay',
    PHONE_NEW_REGISTRATION_ENABLED:'false',PHONE_ACCOUNT_MANAGEMENT_ENABLED:'false',PHONE_EMAIL_REAUTH_ENABLED:'false',
    PHONE_TURNSTILE_DIAGNOSTICS_ENABLED:'false',PHONE_LOGIN_EXTRA_CANARY_ENABLED:'false',
    PHONE_SMS_CANARY_PHONE_HASHES:JSON.stringify([phoneHash(NEW_PHONE),phoneHash(OLD_PHONE)]),
    PHONE_AUTH_HMAC_KEY:HMAC,PHONE_AUTH_HMAC_KEY_ID:'v1',
    PHONE_AUTH_ADMIN_TOKEN:'synthetic-admin-token-at-least-32-characters',SMS_RELAY_URL:'https://relay.invalid/send',
    SUNLAND_SMS_RELAY_KEY:'synthetic-relay-key',TURNSTILE_SECRET:'synthetic-turnstile',PHONE_TURNSTILE_HOSTNAME:'sunland.dev',
    PHONE_REAUTH_EMAIL_API_KEY:'synthetic-mail-key',
    PHONE_AUTH_POLICY:JSON.stringify({perPhoneDaily:3,perIpDaily:3,dailyLimit:3,unitCostMicros:1,dailyBudgetMicros:3,
      totalBudgetMicros:3,ipRequestsPerMinute:20,globalRequestsPerMinute:30})};
  const coordinator=new PhoneAuthCoordinator({storage},env,{now:()=>now,fetchImpl:async(url,init)=>{
    if(new URL(url).hostname==='challenges.cloudflare.com')return Response.json({success:true,hostname:'sunland.dev',action:'phone_login',challenge_ts:new Date(now).toISOString()});
    codes.push(JSON.parse(init.body).code);return Response.json({ok:1});
  }});
  const admin={method:'POST',headers:{Authorization:'Bearer '+env.PHONE_AUTH_ADMIN_TOKEN},body:'{}'};
  assert.equal((await coordinator.fetch(new Request('https://internal/initialize',admin))).status,200);
  const publicPolicy={...JSON.parse(env.PHONE_AUTH_POLICY),dailyLimit:100,perPhoneDaily:10,perIpDaily:10,dailyBudgetMicros:100,totalBudgetMicros:100};
  env.PHONE_AUTH_V2_POLICY=JSON.stringify(publicPolicy);
  assert.equal((await coordinator.fetch(new Request('https://internal/migrate-v2',admin))).status,200);
  now+=86400000;Object.assign(env,{PHONE_RELEASE_MODE:'public',PHONE_AUTH_POLICY:JSON.stringify(publicPolicy),PHONE_SMS_ENABLED:'true',
    PHONE_IDENTITY_ENABLED:'true',PHONE_NEW_REGISTRATION_ENABLED:'true',PHONE_UNIFIED_LOGIN_ENABLED:'true'},overrides);
  env.PHONE_AUTH_COORDINATOR={getByName:()=>({fetch:r=>coordinator.fetch(r)})};
  // Identity emulates the database: phone→account mapping and cached operations.
  const accounts=new Map([[OLD_PHONE,'existing-account']]),operations=new Map(),log=[];
  const identity={
    phoneHash:async p=>phoneHash(p.replace('+86','')),
    login:async({phone,operationId,email,unifiedOtp})=>{
      const local=phone.replace('+86','');log.push({phone:local,operationId,email,unifiedOtp:!!unifiedOtp});
      if(email===undefined){
        if(!accounts.has(local))throw new PhoneAuthError('REGISTRATION_DISABLED',403);
        return {user_id:accounts.get(local),email:'old@example.test',onboarding:{version:1,step:3},is_new_user:false};
      }
      assert.ok(unifiedOtp);
      const cached=operations.get(operationId);
      if(cached)return cached;
      if(accounts.has(local))throw new PhoneAuthError('PHONE_CONFLICT',409);
      const r={user_id:'new-'+operationId,email,onboarding:{version:0,step:1},is_new_user:true};
      accounts.set(local,r.user_id);operations.set(operationId,r);return r;
    },
  };
  const mails=[];
  const hooks={readJsonBodyWithLimit:async r=>({value:await r.json()}),json:(v,status)=>Response.json(v,{status}),
    applicationSigningSecret:()=> 'synthetic-signing-key',getUserStatus:async()=>({}),accountStatusRejection:()=>null,
    signJWT:async user=>'jwt:'+user.id,
    callIdentityRpc:async(_env,name)=>{assert.equal(name,'sunland_otp');return {ok:true,payload:{code:'OK',request_id:crypto.randomUUID()}};},
    createEmailOtp:input=>input,sendPhoneReauthEmail:async input=>{mails.push(input.email);return {success:true,retry_after:60};}};
  const worker=createPhoneAuthWorker({fetch:async()=>new Response(null,{status:404})},hooks,{loginOnly:true,identityFactory:()=>identity});
  const call=async(route,body)=>{
    const response=await worker.fetch(new Request('https://api.sunland.dev/v1/phone/'+route,{method:'POST',
      headers:{'Content-Type':'application/json','CF-Connecting-IP':'192.0.2.1'},body:JSON.stringify(body)}),env,{});
    return {status:response.status,data:await response.json()};
  };
  const sendSms=async phone=>{
    const challenge_id=crypto.randomUUID();
    const r=await call('send-code',{phone,purpose:'login',turnstile_token:'synthetic',challenge_id});
    assert.equal(r.status,200,JSON.stringify(r.data));return {challenge_id,code:codes.at(-1)};
  };
  return {env,call,sendSms,log,mails,accounts,codes,advance:ms=>{now+=ms;}};
}

test('unified existing phone logs into its account and a lost response is recovered without re-consuming SMS',async()=>{
  const s=await setup();const {challenge_id,code}=await s.sendSms(OLD_PHONE);
  const body={phone:'+86'+OLD_PHONE,challenge_id,code,operation_id:crypto.randomUUID(),proof:proof()};
  const first=await s.call('unified/verify',body);
  assert.equal(first.status,200);assert.equal(first.data.status,'authenticated');assert.equal(first.data.user.id,'existing-account');
  const retry=await s.call('unified/verify',body);
  assert.equal(retry.status,200);assert.equal(retry.data.user.id,'existing-account');
  assert.equal(s.codes.length,1);
  const other=await s.call('unified/verify',{...body,proof:proof()});
  assert.notEqual(other.status,200);
  const otherOp=await s.call('unified/verify',{...body,operation_id:crypto.randomUUID()});
  assert.notEqual(otherOp.status,200);
});

test('existing phone proof cannot drive registration email or registration',async()=>{
  const s=await setup();const {challenge_id,code}=await s.sendSms(OLD_PHONE);
  const base={phone:'+86'+OLD_PHONE,challenge_id,operation_id:crypto.randomUUID(),proof:proof()};
  assert.equal((await s.call('unified/verify',{...base,code})).data.status,'authenticated');
  const mail=await s.call('unified/email/send',{...base,email:'victim@example.test'});
  assert.equal(mail.status,403);assert.equal(mail.data.code,'CHALLENGE_INVALID');assert.equal(s.mails.length,0);
  const reg=await s.call('unified/register',{...base,email:'victim@example.test',email_code:'123456'});
  assert.equal(reg.status,403);
});

test('unified new phone verifies once, requires email, and recovers a lost registration result idempotently',async()=>{
  const s=await setup();const {challenge_id,code}=await s.sendSms(NEW_PHONE);
  const base={phone:'+86'+NEW_PHONE,challenge_id,operation_id:crypto.randomUUID(),proof:proof()};
  const verified=await s.call('unified/verify',{...base,code});
  assert.equal(verified.status,200);assert.equal(verified.data.status,'registration_required');
  assert.ok(verified.data.expires_in>300&&verified.data.expires_in<=600);
  // Retry of a lost registration_required response is recovered, not re-consumed.
  assert.equal((await s.call('unified/verify',{...base,code})).data.status,'registration_required');
  const stranger=await s.call('unified/email/send',{...base,proof:proof(),email:'new@example.test'});
  assert.equal(stranger.status,403);
  assert.equal((await s.call('unified/email/send',{...base,email:'new@example.test'})).status,200);
  assert.deepEqual(s.mails,['new@example.test']);
  const tooSoon=await s.call('unified/email/send',{...base,email:'new@example.test'});
  assert.equal(tooSoon.status,429);
  const reg={...base,email:'new@example.test',email_code:'654321'};
  const first=await s.call('unified/register',reg);
  assert.equal(first.status,200);assert.equal(first.data.status,'authenticated');assert.equal(first.data.is_new_user,true);
  const again=await s.call('unified/register',reg);
  assert.equal(again.status,200);assert.equal(again.data.user.id,first.data.user.id);
  assert.equal(s.accounts.get(NEW_PHONE),first.data.user.id);assert.equal(s.codes.length,1);
});

test('unified registration proof outlives the 5-minute SMS code but expires after 10 minutes',async()=>{
  const s=await setup();const {challenge_id,code}=await s.sendSms(NEW_PHONE);
  const base={phone:'+86'+NEW_PHONE,challenge_id,operation_id:crypto.randomUUID(),proof:proof()};
  const v=await s.call('unified/verify',{...base,code});
  assert.equal(v.data.status,'registration_required');assert.ok(v.data.expires_in>300&&v.data.expires_in<=600);
  s.advance(301000);
  // The SMS code itself is still bound to its original 5-minute lifetime.
  const reuse=await s.call('unified/verify',{...base,proof:proof(),operation_id:crypto.randomUUID(),code});
  assert.notEqual(reuse.status,200);
  assert.equal((await s.call('unified/email/send',{...base,email:'new@example.test'})).status,200);
  assert.equal((await s.call('unified/register',{...base,email:'new@example.test',email_code:'654321'})).status,200);
  const s2=await setup();const sms=await s2.sendSms(NEW_PHONE);
  const b2={phone:'+86'+NEW_PHONE,challenge_id:sms.challenge_id,operation_id:crypto.randomUUID(),proof:proof()};
  assert.equal((await s2.call('unified/verify',{...b2,code:sms.code})).data.status,'registration_required');
  s2.advance(601000);
  const late=await s2.call('unified/register',{...b2,email:'new@example.test',email_code:'654321'});
  assert.equal(late.status,403);assert.equal(late.data.code,'CHALLENGE_INVALID');
});

test('unified registration is bound to the email that received the code',async()=>{
  const s=await setup();const {challenge_id,code}=await s.sendSms(NEW_PHONE);
  const base={phone:'+86'+NEW_PHONE,challenge_id,operation_id:crypto.randomUUID(),proof:proof()};
  assert.equal((await s.call('unified/verify',{...base,code})).data.status,'registration_required');
  const unsent=await s.call('unified/register',{...base,email:'new@example.test',email_code:'654321'});
  assert.equal(unsent.status,403);
  assert.equal((await s.call('unified/email/send',{...base,email:'new@example.test'})).status,200);
  const swapped=await s.call('unified/register',{...base,email:'other@example.test',email_code:'654321'});
  assert.equal(swapped.status,403);assert.equal(s.log.filter(x=>x.email).length,0);
  assert.equal((await s.call('unified/register',{...base,email:'new@example.test',email_code:'654321'})).status,200);
});

test('unified routes stay closed behind the emergency switch and registration switch',async()=>{
  const off=await setup({PHONE_UNIFIED_LOGIN_ENABLED:'false'});const sms=await off.sendSms(NEW_PHONE);
  const body={phone:'+86'+NEW_PHONE,challenge_id:sms.challenge_id,code:sms.code,operation_id:crypto.randomUUID(),proof:proof()};
  const closed=await off.call('unified/verify',body);
  assert.equal(closed.status,503);assert.equal(closed.data.code,'IDENTITY_DISABLED');
  const noReg=await setup({PHONE_NEW_REGISTRATION_ENABLED:'false'});const sms2=await noReg.sendSms(NEW_PHONE);
  const r=await noReg.call('unified/verify',{...body,challenge_id:sms2.challenge_id,code:sms2.code});
  assert.equal(r.status,403);assert.equal(r.data.code,'REGISTRATION_DISABLED');
});

test('wrong SMS code never reaches identity and leaves the challenge usable',async()=>{
  const s=await setup();const {challenge_id,code}=await s.sendSms(NEW_PHONE);
  const base={phone:'+86'+NEW_PHONE,challenge_id,operation_id:crypto.randomUUID(),proof:proof()};
  const wrong=await s.call('unified/verify',{...base,code:code==='000000'?'111111':'000000'});
  assert.equal(wrong.status,400);assert.equal(s.log.length,0);
  assert.equal((await s.call('unified/verify',{...base,code})).data.status,'registration_required');
});

test('legacy verify-code login keeps working whether the unified switch is on or off',async()=>{
  for(const flag of ['false','true']){
    const s=await setup({PHONE_UNIFIED_LOGIN_ENABLED:flag});const {challenge_id,code}=await s.sendSms(OLD_PHONE);
    const r=await s.call('verify-code',{phone:'+86'+OLD_PHONE,challenge_id,code,operation_id:crypto.randomUUID()});
    assert.equal(r.status,200,flag+JSON.stringify(r.data));assert.equal(r.data.user.id,'existing-account');
  }
});

test('deploy config never declares release switches that would overwrite production',async()=>{
  const {readFile}=await import('node:fs/promises');
  const config=JSON.parse(await readFile(new URL('../workers/phone-auth/wrangler.jsonc',import.meta.url),'utf8'));
  assert.equal(config.keep_vars,true);
  assert.deepEqual(Object.keys(config.vars).filter(k=>/_ENABLED$|^PHONE_RELEASE_MODE$|_POLICY$/.test(k)),[]);
});
