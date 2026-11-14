// Synthetic local integration: real route and identity code, real migration SQL
// in in-memory PGlite, simulated SMS and email. No production connections.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import { createPhoneAuthWorker } from '../routes.js';
import { sendPhoneReauthEmail } from '../email-reauth.js';
import { PhoneAuthError } from '../errors.js';
import { PhoneAuthCoordinator } from '../coordinator.js';

const { PHONE_PREFLIGHT_PACKAGE_ROOT: packages, PHONE_XIXI_SOURCE_ROOT: xixi, PHONE_SUNLAND_SOURCE_ROOT: app } = process.env;
if (!packages || !xixi || !app) throw Error('Set local package and source roots');
const require = createRequire(resolve(packages, 'package.json'));
const { PGlite } = require('@electric-sql/pglite');
const { JSDOM } = require('jsdom');
const otpSource = execFileSync('git', ['-C', app, 'show', '3398d8801efe93a2063536b0a5d460974a8fc65f:worker/src/email-otp.js'], { encoding: 'utf8' });
const { createEmailOtp } = await import(`data:text/javascript;base64,${Buffer.from(otpSource).toString('base64')}`);
const phoneSql = await readFile(resolve(xixi, 'supabase/migrations/20261024003756_phone_identity.sql'), 'utf8');
const otpSql = await readFile(resolve(app, 'supabase/migrations/20261021010000_atomic_email_otp.sql'), 'utf8');
const initFixture = await readFile(new URL('./initialization-full-postgres.py', import.meta.url), 'utf8');
const baseSchema = initFixture.match(/conn\.execute\('''(create table public\.user_profiles[\s\S]*?)'''\)/)?.[1];
assert.ok(baseSchema, 'missing local synthetic schema');
// PostgreSQL mode uses a brand-new network-disabled container with a tmpfs
// database. Each RPC has its own psql connection, so Promise.all races are real.
const container = `phone-identity-test-${randomUUID().slice(0,8)}`;
let db;
if (process.env.PHONE_TEST_POSTGRES_IMAGE) {
  execFileSync('docker',['run','-d','--rm','--name',container,'--network','none','--tmpfs','/var/lib/postgresql/data:rw,size=256m',
    '-e','POSTGRES_HOST_AUTH_METHOD=trust',process.env.PHONE_TEST_POSTGRES_IMAGE,'postgres','-c','fsync=off'],{stdio:'ignore'});
  const query = sql => new Promise((resolveQuery,reject) => {
    // The image's temporary bootstrap server exposes only a Unix socket;
    // TCP loopback becomes available after the final server has started.
    const child=spawn('docker',['exec','-i',container,'psql','-h','127.0.0.1','-U','postgres','-d','postgres','-Atq','-v','ON_ERROR_STOP=1']);
    let stdout='',stderr=''; child.stdout.on('data',data=>stdout+=data); child.stderr.on('data',data=>stderr+=data);
    child.on('error',reject); child.on('close',code=>code===0 ? resolveQuery(stdout.trim()) : reject(Error(stderr)));
    child.stdin.end(sql);
  });
  try {
    for(let i=0;i<80;i++) { try { await query('select 1'); break; } catch(e) { if(i===79) throw e; await new Promise(r=>setTimeout(r,250)); } }
  } catch(error) {
    execFileSync('docker',['rm','-f',container],{stdio:'ignore'});
    throw error;
  }
  db={
    exec: async sql=>{ await query(sql); },
    query: async (sql,values=[])=>{
      sql=sql.replace(/\$(\d+)/g,(_,n)=>values[n-1] == null ? 'NULL' : `convert_from(decode('${Buffer.from(String(values[n-1])).toString('base64')}','base64'),'UTF8')`);
      const isSelect=/^\s*select\b/i.test(sql);
      const out=await query(isSelect ? `select row_to_json(row_value) from (${sql}) row_value;` : sql);
      return {rows:isSelect && out ? out.split('\n').map(JSON.parse) : []};
    },
    close:async()=>{execFileSync('docker',['rm','-f',container],{stdio:'ignore'});},
  };
} else db = new PGlite();
const env = { PHONE_IDENTITY_ENABLED:'true', PHONE_ACCOUNT_MANAGEMENT_ENABLED:'true', PHONE_EMAIL_REAUTH_ENABLED:'true',
  PHONE_NEW_REGISTRATION_ENABLED:'true', PHONE_SMS_PROVIDER:'aliyun', PHONE_REAUTH_EMAIL_API_KEY:'synthetic-email-key',
  PHONE_AUTH_HMAC_KEY:'synthetic-auth-hmac-key-32-characters', PHONE_IDENTITY_LOOKUP_KEY:'synthetic-lookup-key-32-characters',
  PHONE_IDENTITY_LOOKUP_KEY_ID:'v1', PHONE_IDENTITY_ENCRYPTION_KEY_ID:'v1',
  PHONE_IDENTITY_ENCRYPTION_KEYS:JSON.stringify({v1:Buffer.alloc(32,7).toString('base64url')}) };
const jwtSecret = 'synthetic-jwt-secret-only-for-isolated-test';
const check = createHmac('sha256', env.PHONE_IDENTITY_LOOKUP_KEY).update('sunland-phone-index-canary:v1\0').digest('hex');
const messages = [];
const challenges = new Map();
let deliveries = 0;
const rpc = async (_env, name, args) => {
  try {
    let result;
    if (name === 'sunland_phone_identity') result = await db.query('select public.sunland_phone_identity($1,$2::jsonb) as payload', [args.p_action, JSON.stringify(args.p_data)]);
    else if (name === 'sunland_otp') result = await db.query('select public.sunland_otp($1,$2,$3,$4::uuid,$5,$6) as payload',
      [args.p_action,args.p_subject,args.p_ip,args.p_request_id ?? null,args.p_code_hash ?? null,args.p_delivery ?? null]);
    else throw Error('Unexpected RPC');
    return {ok:true,payload:result.rows[0].payload};
  } catch (e) { console.error('Synthetic RPC failed:', name, e.message); return {ok:false}; }
};
const hooks = {
  getUserFromRequest: async req => ({'Bearer synthetic-session':{id:'email-user'},'Bearer synthetic-other-session':{id:'other-user'},'Bearer synthetic-ui-session':{id:'ui-user'}})[req.headers.get('Authorization')] ?? null,
  getUserStatus: async (_env,id) => (await db.query('select is_banned,identity_status from public.user_profiles where user_id=$1',[id])).rows[0] && {identityStatus:'active',isBanned:false},
  accountStatusRejection: state => state ? null : {error:'unavailable',status:503},
  applicationSigningSecret: () => jwtSecret,
  signJWT: async user => `synthetic-session-for:${user.id}`,
  callIdentityRpc: rpc,
  readJsonBodyWithLimit: async req => ({value:await req.json()}),
  json: (body,status) => Response.json(body,{status}),
  createEmailOtp,
  sendPhoneReauthEmail: args => sendPhoneReauthEmail({...args,fetchImpl:async (_url,req) => {
    deliveries++; const data=JSON.parse(req.body); const code=data.text.match(/\d{6}/)?.[0];
    assert.ok(code); messages.push(code); return Response.json({id:'synthetic-message'});
  }}),
};
const sms = {
  sendPhoneCode: async (_env,input) => {
    if (challenges.has(input.challenge_id)) throw new PhoneAuthError('RATE_LIMITED',429);
    challenges.set(input.challenge_id,{phone:input.phone,purpose:input.purpose,used:false});
    return {success:true,challenge_id:input.challenge_id,expires_in:300,retry_after:600};
  },
  checkPhoneCode: async (_env,input) => {
    const item=challenges.get(input.challenge_id);
    if (!item || item.used || item.phone!==input.phone || item.purpose!==input.purpose || input.code!=='123456') throw new PhoneAuthError('CODE_INVALID');
    item.used=true; return {success:true,verified:true};
  },
};
const worker=createPhoneAuthWorker({fetch:async()=>new Response(null,{status:404})},hooks,{sms,loginOnly:true});
async function call(route, body, token='synthetic-session') {
  const response=await worker.fetch(new Request(`https://api.invalid/v1/phone/${route}`, {method:'POST',
    headers:{'Content-Type':'application/json','CF-Connecting-IP':'192.0.2.1',...(token ? {Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)}),env,{});
  return {status:response.status,...await response.json()};
}
async function send(action) {
  assert.equal((await call('reauth/email/send',{action})).success,true);
  const code=messages.at(-1);
  assert.equal((await call('reauth/email',{action:'delete',code})).code,'CODE_INVALID');
  const concurrent=await Promise.all([call('reauth/email',{action,code}),call('reauth/email',{action,code})]);
  const verified=concurrent.find(item=>item.status===200);
  assert.ok(verified); assert.equal(concurrent.filter(item=>item.status===200).length,1);
  assert.equal(concurrent.find(item=>item.status!==200).code,'CODE_INVALID');
  assert.equal((await call('reauth/email',{action,code})).code,'CODE_INVALID');
  await db.exec("update public.sunland_otp_challenges set next_send_at=now()-interval '1 second'");
  return verified.reauth_token;
}
async function mutate(action,phone,proof) {
  const challenge_id=randomUUID();
  assert.equal((await call('send-code',{phone,purpose:action,turnstile_token:'synthetic',challenge_id,reauth_token:proof})).success,true);
  return call(action,{phone,challenge_id,code:'123456',reauth_token:proof,operation_id:randomUUID()});
}
try {
  await db.exec("create role anon;create role authenticated;create role service_role bypassrls;create schema extensions;create function extensions.gen_random_uuid() returns uuid language sql volatile as $$ select pg_catalog.gen_random_uuid() $$;"+baseSchema);
  await db.exec(phoneSql); await db.exec(otpSql);
  await db.query('update public.sunland_phone_auth_config set lookup_key_id=$1,lookup_check=$2',['v1',check]);
  await db.query("insert into public.user_profiles(user_id,email,onboarding_version,onboarding_step) values ('email-user',$1,1,3)",['synthetic@example.test']);
  await db.query("insert into public.user_profiles(user_id,email,onboarding_version,onboarding_step) values ('other-user',$1,1,3)",['other@example.test']);
  const phone='13800000001', changed='13800000002';
  const bindProof=await send('bind');
  assert.equal((await mutate('bind',phone,bindProof)).ok,true);
  const otherToken='synthetic-other-session';
  assert.equal((await call('reauth/email/send',{action:'bind'},otherToken)).success,true);
  const otherProof=await call('reauth/email',{action:'bind',code:messages.at(-1)},otherToken);
  const otherChallenge=randomUUID();
  assert.equal((await call('send-code',{phone,purpose:'bind',turnstile_token:'synthetic',challenge_id:otherChallenge,reauth_token:otherProof.reauth_token},otherToken)).success,true);
  assert.equal((await call('bind',{phone,challenge_id:otherChallenge,code:'123456',reauth_token:otherProof.reauth_token,operation_id:randomUUID()},otherToken)).code,'PHONE_CONFLICT');
  const loginId=randomUUID();
  assert.equal((await call('send-code',{phone,purpose:'login',turnstile_token:'synthetic',challenge_id:loginId},null)).success,true);
  const login=await call('verify-code',{phone,challenge_id:loginId,code:'123456',operation_id:randomUUID()},null);
  assert.equal(login.user.id,'email-user'); assert.equal(login.is_new_user,false);
  assert.equal((await call('verify-code',{phone,challenge_id:loginId,code:'123456',operation_id:randomUUID()},null)).code,'CODE_INVALID');
  const expiredProof=await send('change');
  await db.exec("update public.sunland_phone_auth_grants set issued_at=now()-interval '11 minutes',expires_at=now()-interval '6 minutes' where consumed_by is null");
  const expired=await call('send-code',{phone:changed,purpose:'change',turnstile_token:'synthetic',challenge_id:randomUUID(),reauth_token:expiredProof});
  assert.equal(expired.code,'REAUTH_INVALID');
  const changedProof=await send('change');
  assert.equal((await mutate('change',changed,changedProof)).ok,true);
  const unbindProof=await send('unbind');
  assert.equal((await call('unbind',{reauth_token:unbindProof,operation_id:randomUUID()})).ok,true);
  assert.equal((await call('status',{})).bound,false);
  const rows=await db.query('select count(*)::int as n from public.user_profiles'); assert.equal(rows.rows[0].n,2);
  assert.equal((await call('reauth/email/send',{action:'bind'})).success,true);
  const expiredCode=messages.at(-1);
  await db.exec("update public.sunland_otp_challenges set expires_at=now()-interval '1 second'");
  assert.equal((await call('reauth/email',{action:'bind',code:expiredCode})).code,'CODE_INVALID');
  await db.exec("update public.sunland_otp_challenges set next_send_at=now()-interval '1 second'");
  assert.equal((await call('reauth/email/send',{action:'bind'})).success,true);
  const correct=messages.at(-1), wrong=correct==='000000'?'000001':'000000';
  for(let i=0;i<5;i++) assert.equal((await call('reauth/email',{action:'bind',code:wrong})).code,'CODE_INVALID');
  assert.equal((await call('reauth/email',{action:'bind',code:correct})).code,'RATE_LIMITED');
  const fresh='13900000001'; env.PHONE_NEW_REGISTRATION_ENABLED='false';
  let freshId=randomUUID();
  assert.equal((await call('send-code',{phone:fresh,purpose:'login',turnstile_token:'synthetic',challenge_id:freshId},null)).success,true);
  assert.equal((await call('verify-code',{phone:fresh,challenge_id:freshId,code:'123456',operation_id:randomUUID()},null)).code,'REGISTRATION_DISABLED');
  env.PHONE_NEW_REGISTRATION_ENABLED='true'; freshId=randomUUID();
  assert.equal((await call('send-code',{phone:fresh,purpose:'login',turnstile_token:'synthetic',challenge_id:freshId},null)).success,true);
  const registrations=await Promise.all([1,2].map(()=>call('verify-code',{phone:fresh,challenge_id:freshId,code:'123456',operation_id:randomUUID()},null)));
  assert.equal(registrations.filter(item=>item.is_new_user===true).length,1);
  assert.equal(registrations.find(item=>!item.is_new_user).code,'CODE_INVALID');
  const profiles=await db.query('select count(*)::int as n from public.user_profiles'); assert.equal(profiles.rows[0].n,3);
  assert.equal(deliveries,7);
  // Use the actual settings page and browser client against the same real routes
  // and SQL. Only CAPTCHA, SMS, email and identity authentication are fake.
  await db.query("insert into public.user_profiles(user_id,email,onboarding_version,onboarding_step) values ('ui-user',$1,1,3)",['ui@example.test']);
  const page=await readFile(new URL('../../../ai_settings.html',import.meta.url),'utf8');
  const clientScript=await readFile(new URL('../../../p/js/phone-auth.js',import.meta.url),'utf8');
  const settingsScript=await readFile(new URL('../../../p/js/phone-settings.js',import.meta.url),'utf8');
  const dom=new JSDOM(page,{url:'https://sunland.dev/ai_settings.html',runScripts:'outside-only'});
  try {
    const w=dom.window, el=id=>w.document.getElementById(`phoneSettings${id}`);
    w.AbortController=AbortController; w.crypto.randomUUID=randomUUID; w.localStorage.setItem('token','synthetic-ui-session');
    w.document.querySelector('meta[name="sunland-phone-settings-enabled"]').content='true';
    w.eval(clientScript);
    const original=w.SunlandPhoneAuth;
    const fetchImpl=(url,init)=>worker.fetch(new Request(url,{...init,headers:{...init.headers,'CF-Connecting-IP':'192.0.2.1'}}),env,{});
    w.SunlandPhoneAuth={...original,createClient:opts=>original.createClient({...opts,captcha:async()=>'synthetic-turnstile',fetchImpl})};
    w.eval(settingsScript);
    const wait=async(predicate,label)=>{
      for(let i=0;i<300;i++){if(await predicate())return;await new Promise(r=>setTimeout(r,25));}
      throw Error(`Synthetic UI timed out: ${label}; ${el('Message').textContent}`);
    };
    await wait(()=>!w.document.getElementById('phoneSettings').hidden && !el('Bind').hidden && !el('Bind').disabled && typeof el('Bind').onclick==='function','initial status');
    const begin=async action=>{
      w.sessionStorage.removeItem('sunland.phone.email-reauth-cooldown.v1');
      await db.exec("update public.sunland_otp_challenges set next_send_at=now()-interval '1 second'");
      el(action).click(); const count=messages.length; el('AuthSend').click();
      await wait(()=>messages.length>count&&!el('AuthNext').disabled,`${action} email send`);
      el('AuthCode').value=messages.at(-1);el('AuthNext').click();
      await wait(()=>action==='Unbind' ? !el('UnbindConfirm').hidden : !el('Target').hidden,`${action} email proof`);
    };
    const target=async phone=>{
      el('NewPhone').value=phone;const count=challenges.size;el('TargetSend').click();
      await wait(()=>challenges.size>count&&!el('TargetConfirm').disabled,'target send');
      el('NewCode').value='123456';el('TargetConfirm').click();
      await wait(()=>el('Reauth').hidden&&el('Target').hidden&&!el('Change').disabled,'target mutation');
    };
    await begin('Bind'); await target('13800000003');
    let actual=await db.query("select last4 from public.sunland_phone_identities where user_id='ui-user'");assert.equal(actual.rows[0].last4,'0003');
    await begin('Change'); await target('13800000004');
    actual=await db.query("select last4 from public.sunland_phone_identities where user_id='ui-user'");assert.equal(actual.rows[0].last4,'0004');
    await begin('Unbind');el('UnbindSubmit').click();
    await wait(()=>!el('Bind').hidden&&!el('Bind').disabled,'unlink');
    actual=await db.query("select count(*)::int as n from public.sunland_phone_identities where user_id='ui-user'");assert.equal(actual.rows[0].n,0);
  } finally {dom.window.close();}
  console.log('PASS: actual settings DOM and browser client -> Worker routes -> real identity and email OTP SQL in synthetic aliyun mode: bind, change, unbind; authentication, CAPTCHA, SMS and email simulated');
  // Exercise the real coordinator and relay adapter with outbound HTTP mocked;
  // identity mutations still run against the isolated PostgreSQL instance.
  const ledger = new Map(); let tail = Promise.resolve(); let relayCode;
  const storage = { async transaction(fn) {
    const previous = tail; let release; tail = new Promise(r => { release = r; }); await previous;
    try {
      const copy = structuredClone(ledger);
      const tx = {get: async k => structuredClone(copy.get(k)), put: async (k,v) => copy.set(k,structuredClone(v)),
        delete: async k => copy.delete(k), list: async ({prefix='',startAfter='',limit=32}={}) =>
          new Map([...copy].filter(([k]) => k.startsWith(prefix) && k > startAfter).sort().slice(0,limit))};
      const result = await fn(tx); ledger.clear(); for (const entry of copy) ledger.set(...entry); return result;
    } finally { release(); }
  }};
  const doEnv = {...env, PHONE_SMS_PROVIDER:'relay', PHONE_SMS_ENABLED:'true', PHONE_RELEASE_MODE:'public',
    SMS_RELAY_URL:'https://relay.invalid/send', SUNLAND_SMS_RELAY_KEY:'synthetic-relay-key',
    PHONE_AUTH_HMAC_KEY_ID:'v1', PHONE_AUTH_ADMIN_TOKEN:'synthetic-admin-token-32-characters',
    TURNSTILE_SECRET:'synthetic-turnstile', PHONE_TURNSTILE_HOSTNAME:'sunland.dev',
    PHONE_AUTH_POLICY: JSON.stringify({perPhoneDaily:10,perIpDaily:20,dailyLimit:20,unitCostMicros:7,
      dailyBudgetMicros:140,totalBudgetMicros:140,ipRequestsPerMinute:100,globalRequestsPerMinute:200})};
  const coordinator = new PhoneAuthCoordinator({storage},doEnv,{fetchImpl:async (url,init) => {
    if (new URL(url).hostname === 'challenges.cloudflare.com') return Response.json({success:true,hostname:'sunland.dev',action:`phone_${JSON.parse(init.body).response.split(':')[0]}`,challenge_ts:new Date().toISOString()});
    assert.equal(new URL(url).hostname,'relay.invalid'); const payload=JSON.parse(init.body);
    assert.equal(payload.scene,'login'); relayCode=payload.code; return Response.json({ok:1});
  }});
  const initialized=await coordinator.fetch(new Request('https://internal/initialize',{method:'POST',headers:{Authorization:`Bearer ${doEnv.PHONE_AUTH_ADMIN_TOKEN}`},body:'{}'}));
  assert.equal(initialized.status,200);
  const liveSms={sendPhoneCode:(_env,input,ctx)=>coordinator.send(input,ctx),checkPhoneCode:(_env,input,ctx)=>coordinator.check(input,ctx)};
  const realWorker=createPhoneAuthWorker({fetch:async()=>new Response(null,{status:404})},hooks,{sms:liveSms,loginOnly:true});
  async function realCall(route,body) {
    const response=await realWorker.fetch(new Request(`https://api.invalid/v1/phone/${route}`,{method:'POST',
      headers:{'Content-Type':'application/json','CF-Connecting-IP':'192.0.2.1'},body:JSON.stringify(body)}),doEnv,{});
    return {status:response.status,...await response.json()};
  }
  const actualPhone='13700000005', actualChallenge=randomUUID();
  assert.equal((await realCall('send-code',{phone:actualPhone,purpose:'login',turnstile_token:'login:synthetic',challenge_id:actualChallenge})).success,true);
  const actualLogin=await realCall('verify-code',{phone:actualPhone,challenge_id:actualChallenge,code:relayCode,operation_id:randomUUID()});
  assert.equal(actualLogin.is_new_user,true); assert.ok(actualLogin.user.id);
  assert.notEqual((await realCall('verify-code',{phone:actualPhone,challenge_id:actualChallenge,code:relayCode,operation_id:randomUUID()})).status,200);
  console.log('PASS: Worker routes + real coordinator + relay adapter + isolated identity SQL; outbound Turnstile and relay, JWT and account status simulated');
  const realDom=new JSDOM(page,{url:'https://sunland.dev/ai_settings.html',runScripts:'outside-only'});
  try {
    const w=realDom.window, el=id=>w.document.getElementById(`phoneSettings${id}`);
    w.AbortController=AbortController; w.crypto.randomUUID=randomUUID; w.localStorage.setItem('token','synthetic-ui-session');
    w.document.querySelector('meta[name="sunland-phone-settings-enabled"]').content='true'; w.eval(clientScript);
    const original=w.SunlandPhoneAuth;
    const fetchImpl=(url,init)=>realWorker.fetch(new Request(url,{...init,headers:{...init.headers,'CF-Connecting-IP':'192.0.2.1'}}),doEnv,{});
    w.SunlandPhoneAuth={...original,createClient:opts=>original.createClient({...opts,captcha:async action=>`${action.slice(6)}:synthetic`,fetchImpl})};
    w.eval(settingsScript);
    const wait=async(predicate,label)=>{for(let i=0;i<300;i++){if(await predicate())return;await new Promise(r=>setTimeout(r,25));}throw Error(`Synthetic real coordinator UI timed out: ${label}; ${el('Message').textContent}`);};
    await wait(()=>!el('Bind').hidden&&!el('Bind').disabled&&typeof el('Bind').onclick==='function','initial status');
    el('Bind').click(); const previous=messages.length; relayCode=undefined; el('AuthSend').click();
    await wait(()=>el('Message').textContent.length>0,'management rejection');
    assert.equal(messages.length,previous); assert.equal(relayCode,undefined);
    const actual=await db.query("select count(*)::int as n from public.sunland_phone_identities where user_id='ui-user'");
    assert.equal(actual.rows[0].n,0);
  } finally { realDom.window.close(); }
  console.log('PASS: relay account management remains closed even if its switches are enabled; no SMS or email requested');
  console.log(`PASS: synthetic routes + ${process.env.PHONE_TEST_POSTGRES_IMAGE ? 'isolated PostgreSQL 17' : 'PGlite'}: register, same-user login, email proof, bind, cross-account conflict, change, unbind, concurrent/replay/cross-action/expiry/attempt-limit rejection; simulated SMS and email`);
} finally { await db.close(); }
