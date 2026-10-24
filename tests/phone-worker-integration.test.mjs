// Actual authoritative Worker source + new modules + real PostgreSQL WASM SQL.
// All HTTP (including provider/captcha/database) is intercepted; no live network.
import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {JSDOM} from 'jsdom';
import {buildPhoneAuthWorker} from '../scripts/build-phone-auth-worker.mjs';
const built=await buildPhoneAuthWorker();
const bundle=await import('data:text/javascript;base64,'+Buffer.from(built.code).toString('base64'));
const migration=await readFile(new URL('../supabase/migrations/20261024003756_phone_identity.sql',import.meta.url),'utf8');
const contract=JSON.parse(await readFile(new URL('../docs/full-stack-development/requirements/mainland-phone-auth/phase-2-openapi.json',import.meta.url),'utf8'));
function assertSchema(value,schema) {
 if(schema.oneOf){const valid=schema.oneOf.filter(candidate=>{try{assertSchema(value,candidate);return true;}catch{return false;}});assert.equal(valid.length,1);return;}
 if(schema.$ref) return assertSchema(value,contract.components.schemas[schema.$ref.split('/').at(-1)]);
 if(Object.hasOwn(schema,'const'))assert.deepEqual(value,schema.const);
 if(schema.enum)assert.ok(schema.enum.includes(value));
 if(schema.type){const type=value===null?'null':Number.isInteger(value)?'integer':typeof value;assert.ok([schema.type].flat().includes(type),`${type} must satisfy ${JSON.stringify(schema.type)}`);}
 if(schema.pattern)assert.match(value,new RegExp(schema.pattern));
 if(schema.minimum!==undefined)assert.ok(value>=schema.minimum);
 if(schema.maximum!==undefined)assert.ok(value<=schema.maximum);
 if(schema.type==='object'){for(const key of schema.required||[])assert.ok(Object.hasOwn(value,key));for(const [key,v]of Object.entries(value)){assert.ok(schema.properties[key],`undocumented ${key}`);assertSchema(v,schema.properties[key]);}}
}
const secret='mock-only-application-signing-secret';
async function jwt(payload, key=secret) {
 const b=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
 const data=b({alg:'HS256',typ:'JWT'})+'.'+b({iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600,...payload});
 const k=await crypto.subtle.importKey('raw',new TextEncoder().encode(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return data+'.'+Buffer.from(await crypto.subtle.sign('HMAC',k,new TextEncoder().encode(data))).toString('base64url');
}
const decode=t=>JSON.parse(Buffer.from(t.split('.')[1],'base64url').toString());
class Storage {
 constructor(data){this.data=data;this.tail=Promise.resolve();}
 async transaction(fn){const prev=this.tail;let release;this.tail=new Promise(r=>release=r);await prev;
  try{const copy=structuredClone(this.data);const tx={get:async k=>structuredClone(copy.get(k)),put:async(k,v)=>copy.set(k,structuredClone(v)),delete:async k=>copy.delete(k),
   list:async({prefix='',startAfter='',limit=32}={})=>new Map([...copy].filter(([k])=>k.startsWith(prefix)&&k>startAfter).sort(([a],[b])=>a.localeCompare(b)).slice(0,limit))};
   const result=await fn(tx);this.data=copy;return result;}finally{release();}}
}
test('real Worker fetch integrates identity, original JWT/email/database-token and deletion state boundaries',async t=>{
 const db=new PGlite(); let smsCalls=0; let captchaAction='phone_login'; let emailConsumes=0;
 const now=Date.now();
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create table user_profiles(user_id text primary key,email text,pro boolean not null default false,is_banned boolean not null default false,
 identity_status text not null default 'active',onboarding_version smallint not null default 0,onboarding_step smallint not null default 1,
 created_at timestamptz default now(),deletion_job_id uuid,deletion_attempt_id text,deletion_fencing_version bigint not null default 0,retired_at timestamptz);
 create table account_deletion_jobs(id uuid primary key default gen_random_uuid(),user_id text not null,token_hash text not null unique,status text not null default 'pending',expires_at timestamptz not null,
 lease_expires_at timestamptz,attempt_id text,fencing_version bigint not null default 0,data_deleted_at timestamptz,recovery_expires_at timestamptz,created_at timestamptz not null default now());
 grant select,insert,update,delete on user_profiles,account_deletion_jobs to service_role;`);
 await db.exec(migration);
 const env={JWT_SECRET:secret,SUPABASE_JWT_SECRET:'mock-database-jwt-secret',SUPABASE_PROJECT_URL:'https://database.test.invalid',SUPABASE_SECRET_KEY:'sb_secret_mock_only',
 PHONE_IDENTITY_ENABLED:'true',PHONE_IDENTITY_LOOKUP_KEY:'mock-lookup-secret-more-than-32-chars',PHONE_IDENTITY_LOOKUP_KEY_ID:'v1',
 PHONE_IDENTITY_ENCRYPTION_KEYS:JSON.stringify({v1:Buffer.alloc(32,7).toString('base64url')}),PHONE_IDENTITY_ENCRYPTION_KEY_ID:'v1',
 PHONE_AUTH_HMAC_KEY:'mock-hmac-secret-more-than-32-chars',PHONE_AUTH_HMAC_KEY_ID:'v1',PHONE_SMS_ENABLED:'true',TURNSTILE_SECRET:'mock-captcha',PHONE_TURNSTILE_HOSTNAME:'sunland.dev',
 PHONE_ALIYUN_ACCESS_KEY_ID:'mock-id',PHONE_ALIYUN_ACCESS_KEY_SECRET:'mock-secret',PHONE_SMS_SIGN_NAME:'mock-sign',PHONE_SMS_TEMPLATE_CODE:'mock-template',
 PHONE_AUTH_POLICY:JSON.stringify({perPhoneDaily:20,perIpDaily:40,dailyLimit:50,unitCostMicros:1,dailyBudgetMicros:50,totalBudgetMicros:100,ipRequestsPerMinute:100,globalRequestsPerMinute:200})};
 const encoder=new TextEncoder();const lookupKey=await crypto.subtle.importKey('raw',encoder.encode(env.PHONE_IDENTITY_LOOKUP_KEY),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const canary=Buffer.from(await crypto.subtle.sign('HMAC',lookupKey,encoder.encode('sunland-phone-index-canary:v1\0'))).toString('hex');
 await db.query('update sunland_phone_auth_config set lookup_key_id=$1,lookup_check=$2',['v1',canary]);
 const store=new Storage(new Map([['account',{schema:1,enabled:true,keyId:'v1',totalMicros:0,day:Math.floor(now/86400000),dayCount:0,dayMicros:0,minute:Math.floor(now/60000),minuteCount:0,lastNow:now}]]));
 const fetchMock=mock.method(globalThis,'fetch',async(input,init={})=>{
  const url=new URL(typeof input==='string'?input:input.url);const body=init.body?JSON.parse(init.body):{};
  if(url.hostname==='challenges.cloudflare.com')return Response.json({success:true,hostname:'sunland.dev',action:captchaAction,challenge_ts:new Date().toISOString()});
  if(url.hostname==='dypnsapi.aliyuncs.com'){smsCalls++;return Response.json({Success:true,Code:'OK',Model:{VerifyResult:'PASS'}});}
  assert.equal(url.hostname,'database.test.invalid','live network forbidden');
  if(url.pathname==='/rest/v1/rpc/sunland_phone_identity') {
   const r=await db.query('select sunland_phone_identity($1,$2::jsonb) result',[body.p_action,JSON.stringify(body.p_data)]);return Response.json(r.rows[0].result);
  }
  if(url.pathname==='/rest/v1/rpc/sunland_otp') {
   if(body.p_action==='challenge')return Response.json({code:'OK',request_id:'13365418-4c84-4fc4-b827-94cf45011d49'});
   if(body.p_action==='consume'){emailConsumes++;return Response.json({code:'OK'});}
   throw Error('unexpected OTP request');
  }
  if(url.pathname==='/rest/v1/user_profiles') {
   const id=url.searchParams.get('user_id')?.slice(3),email=url.searchParams.get('email')?.slice(3);
   const r=id?await db.query('select * from user_profiles where user_id=$1',[id]):await db.query("select * from user_profiles where email=$1 and identity_status='active'",[email]);
   return Response.json(r.rows);
  }
  throw Error('unhandled mock route '+url.pathname);
 });
 const coordinator=new bundle.PhoneAuthCoordinator({storage:store},env);
 env.PHONE_AUTH_COORDINATOR={getByName(){return {fetch:r=>coordinator.fetch(r)};}};
 const request=async(path,body={},token)=>{
  const response=await bundle.default.fetch(new Request('https://api.sunland.dev'+path,{method:'POST',headers:{'Content-Type':'application/json','CF-Connecting-IP':'192.0.2.1',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)}),env,{});
  const output=await response.json(); const responseSchema=contract.paths[path]?.post.responses[String(response.status)]?.content['application/json'].schema; if(path.startsWith('/v1/phone/')){assert.ok(responseSchema,`undocumented status ${response.status}`);assertSchema(output,responseSchema);} return {status:response.status,body:output,headers:response.headers};
 };
 const send=async(phone,purpose='login',token,reauth_token)=>{captchaAction='phone_'+purpose;const r=await request('/v1/phone/send-code',{phone,purpose,turnstile_token:'mock',...(reauth_token?{reauth_token}:{})},token);assert.equal(r.status,200,JSON.stringify(r.body));return r.body.challenge_id;};
 let user,token;
 try {
  await t.test('new phone registration uses atomic SQL and original JWT, preserves null email',async()=>{
   const phone='13800000000',challenge_id=await send(phone);
   const r=await request('/v1/phone/verify-code',{phone,challenge_id,code:'123456',operation_id:crypto.randomUUID()});
   assert.equal(r.status,200,JSON.stringify(r.body));user=r.body.user.id;token=r.body.token;
   assert.equal(r.body.user.email,null);assert.equal(r.body.is_new_user,true);assert.deepEqual(r.body.onboarding,{version:0,step:1});assert.equal(decode(token).id,user);
   assert.deepEqual(Object.keys(r.body).sort(),['is_new_user','onboarding','token','user']);
  });
  await t.test('invalid/expired JWT rejected by real verifier; active profile checked',async()=>{
   for(const invalid of ['invalid',await jwt({id:user,exp:1}),await jwt({id:user},'wrong-secret')]){
    assert.equal((await request('/v1/phone/status',{},invalid)).status,401);
   }
   const r=await request('/v1/phone/status',{},token);assert.equal(r.status,200);assert.deepEqual(r.body,{bound:true,phone:'+86 *******0000',has_email:false});
  });
  await t.test('original refresh and 15-minute database JWT accept phone identity and preserve Pro',async()=>{
   await db.query('update user_profiles set pro=true where user_id=$1',[user]);
   const refresh=await request('/refresh',{},token);assert.equal(refresh.status,200);assert.equal(decode(refresh.body.token).id,user);
   const r=await request('/v1/database-token',{},token);assert.equal(r.status,200);const claims=decode(r.body.token);
   assert.equal(claims.sub,user);assert.equal(claims.role,'authenticated');assert.equal(claims.exp-claims.iat,900);
   const [header,payload,signature]=r.body.token.split('.');
   const signingKey=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.SUPABASE_JWT_SECRET),{name:'HMAC',hash:'SHA-256'},false,['verify']);
   assert.equal(await crypto.subtle.verify('HMAC',signingKey,Buffer.from(signature,'base64url'),new TextEncoder().encode(header+'.'+payload)),true);
   assert.equal((await db.query('select pro from user_profiles where user_id=$1',[user])).rows[0].pro,true);
  });
  await t.test('email reauth uses current factor, unbind and email login preserve original account',async()=>{
   await db.query('update user_profiles set email=$1 where user_id=$2',['owner@example.test',user]);
   const g=await request('/v1/phone/reauth/email',{action:'unbind',code:'123456'},token);assert.equal(g.status,200,JSON.stringify(g.body));
   assert.equal(emailConsumes,1);assert.deepEqual(Object.keys(g.body).sort(),['expires_in','reauth_token']);
   const r=await request('/v1/phone/unbind',{reauth_token:g.body.reauth_token,operation_id:crypto.randomUUID()},token);assert.equal(r.status,200,JSON.stringify(r.body));
   const replay=await request('/v1/phone/unbind',{reauth_token:g.body.reauth_token,operation_id:crypto.randomUUID()},token);assert.equal(replay.status,403);
   const email=await request('/verify-code',{email:'owner@example.test',code:'123456'});assert.equal(email.status,200,JSON.stringify(email.body));assert.equal(email.body.user.id,user);
   assert.equal((await db.query('select count(*)::int n from user_profiles')).rows[0].n,1);
  });
  await t.test('binding, existing phone login and change preserve original ID and Pro through actual routes',async()=>{
   const phone='13700000000';
   const g=await request('/v1/phone/reauth/email',{action:'bind',code:'123456'},token);assert.equal(g.status,200);
   const challenge_id=await send(phone,'bind',token,g.body.reauth_token);
   const bound=await request('/v1/phone/bind',{phone,challenge_id,code:'123456',reauth_token:g.body.reauth_token,operation_id:crypto.randomUUID()},token);assert.equal(bound.status,200,JSON.stringify(bound.body));
   for(const k of [...store.data.keys()])if(k!=='account')store.data.delete(k);
   const loginChallenge=await send(phone);const login=await request('/v1/phone/verify-code',{phone,challenge_id:loginChallenge,code:'123456',operation_id:crypto.randomUUID()});
   assert.equal(login.status,200);assert.equal(login.body.user.id,user);assert.equal(login.body.is_new_user,false);
   const cg=await request('/v1/phone/reauth/email',{action:'change',code:'123456'},token);assert.equal(cg.status,200);
   const newPhone='13600000000',newChallenge=await send(newPhone,'change',token,cg.body.reauth_token);
   const changed=await request('/v1/phone/change',{phone:newPhone,challenge_id:newChallenge,code:'123456',reauth_token:cg.body.reauth_token,operation_id:crypto.randomUUID()},token);assert.equal(changed.status,200,JSON.stringify(changed.body));
   const profile=(await db.query('select user_id,email,pro from user_profiles where user_id=$1',[user])).rows[0];assert.equal(profile.pro,true);assert.equal(profile.email,'owner@example.test');
   assert.equal((await db.query('select count(*)::int n from user_profiles')).rows[0].n,1);
  });
  await t.test('phone-only account can reauth and authorize existing deletion job without email',async()=>{
   const phone='13900000000',challenge_id=await send(phone);const registered=await request('/v1/phone/verify-code',{phone,challenge_id,code:'123456',operation_id:crypto.randomUUID()});assert.equal(registered.status,200);
   const id=registered.body.user.id,auth=registered.body.token;
   // A separate SMS fixture for the next flow: clear only synthetic test state.
   // Real persistent budget/phone quarantine is never reset by application code.
   for(const k of [...store.data.keys()])if(k!=='account')store.data.delete(k);
   const challenge=await send(phone,'reauth',auth);const g=await request('/v1/phone/reauth/phone',{phone,challenge_id:challenge,code:'123456',action:'delete'},auth);
   assert.equal(g.status,200,JSON.stringify(g.body));
   const d=await request('/v1/phone/delete-authorize',{reauth_token:g.body.reauth_token,operation_id:crypto.randomUUID()},auth);assert.equal(d.status,200,JSON.stringify(d.body));
   assert.equal(d.body.ok,true);assert.equal((await db.query('select user_id from account_deletion_jobs where id=$1',[d.body.deletion_job_id])).rows[0].user_id,id);
   await db.query("update user_profiles set identity_status='deleting' where user_id=$1",[id]);
   assert.equal((await request('/refresh',{},auth)).status,403);assert.equal((await request('/v1/phone/status',{},auth)).status,403);
   assert.equal((await db.query('select count(*)::int n from sunland_phone_identities where user_id=$1',[id])).rows[0].n,1);
  });
  await t.test('unrelated route/preflight delegates existing Worker and CORS, no identity disclosure',async()=>{
   const r=await bundle.default.fetch(new Request('https://api.sunland.dev/v1/phone/bind',{method:'OPTIONS'}),env,{});assert.equal(r.status,200);
   assert.equal(r.headers.get('Access-Control-Allow-Origin'),'https://sunland.dev');
   assert.ok(smsCalls>=4);
  });
  await t.test('website API client executes unchanged Phase2 Worker routes and SQL identity transactions',async()=>{
   const dom=new JSDOM('',{url:'https://sunland.dev',runScripts:'outside-only'});dom.window.AbortController=AbortController;dom.window.crypto.randomUUID=crypto.randomUUID.bind(crypto);
   dom.window.eval(await readFile(new URL('../p/js/phone-auth.js',import.meta.url),'utf8'));
   const client=dom.window.SunlandPhoneAuth.createClient({captcha:async action=>{captchaAction=action;return 'mock-turnstile';},fetchImpl:(url,init)=>bundle.default.fetch(new Request(url,{...init,headers:{...init.headers,'CF-Connecting-IP':'192.0.2.1'}}),env,{})});
   try {
    const sent=await client.send('13400001234','login');const registered=await client.login('13400001234',sent.challenge_id,'123456');assert.equal(registered.is_new_user,true);
    dom.window.localStorage.setItem('token',registered.token);dom.window.localStorage.setItem('user',JSON.stringify(registered.user));
    const identity=await client.refreshSession();assert.equal(identity.id,registered.user.id);assert.equal((await client.status()).phone,'+86 *******1234');
    await db.query('update user_profiles set email=$1 where user_id=$2',['web-owner@example.test',identity.id]);
    const grant=await client.emailProof('123456','change');const target=await client.send('13300005678','change',grant.reauth_token);
    await client.mutate('change',{phone:'13300005678',challenge_id:target.challenge_id,code:'123456',reauth_token:grant.reauth_token});assert.equal((await client.status()).phone,'+86 *******5678');
    const unbind=await client.emailProof('123456','unbind');await client.mutate('unbind',{reauth_token:unbind.reauth_token});assert.equal((await client.status()).bound,false);
    assert.ok(!dom.window.localStorage.getItem('user').includes('13400001234'));
   }finally{client.cancel();dom.window.close();}
  });
 }finally{fetchMock.mock.restore();await db.close();}
});
