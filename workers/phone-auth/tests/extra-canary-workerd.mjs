// Local workerd + SQLite only; every outbound request is intercepted.
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { buildStandalonePhoneWorker } from '../../../scripts/build-phone-auth-worker.mjs';
import { SINGLETON_NAME } from '../coordinator.js';

const project=fileURLToPath(new URL('../../../',import.meta.url));
const require=createRequire(resolve(process.env.SUNLAND_AUTH_WORKER_ROOT || resolve(project,'../../sunland_ai_app/worker'),'package.json'));
const {Miniflare,Log,LogLevel,convertV4MiniflareOptions}=require('miniflare');
const previous=process.env.PHONE_PREVIOUS_WORKER_BUNDLE;
if (!previous) throw Error('PHONE_PREVIOUS_WORKER_BUNDLE is required for exact rollback verification');
const previousScript=await readFile(previous,'utf8');
assert.equal(createHash('sha256').update(previousScript).digest('hex'),'146cc497852b7b585562e2088bd591db2a7be0e9e266c2abdd26d1934694b531');
const {code:nextScript}=await buildStandalonePhoneWorker();
const clocked=script=>{
  const before='this.storage = state.storage;\n    this.env = env;\n    this.now = now;';
  assert.equal(script.split(before).length,2);
  return script.replace(before,'this.storage = state.storage;\n    this.env = env;\n    this.now = () => Number(env.TEST_CLOCK);');
};
const root=await mkdtemp(join(tmpdir(),'phone-extra-canary-'));
const secret='synthetic-runtime-hmac-key-at-least-32',admin='synthetic-runtime-admin-token-at-least-32',phone='13800000000';
const hash=createHmac('sha256',secret).update(`phone\0${phone}`).digest('hex');
const bindings={PHONE_SMS_ENABLED:'true',PHONE_IDENTITY_ENABLED:'true',PHONE_NEW_REGISTRATION_ENABLED:'false',
  PHONE_ACCOUNT_MANAGEMENT_ENABLED:'false',PHONE_EMAIL_REAUTH_ENABLED:'false',PHONE_TURNSTILE_DIAGNOSTICS_ENABLED:'false',
  PHONE_LOGIN_EXTRA_CANARY_ENABLED:'false',PHONE_SMS_PROVIDER:'relay',SMS_RELAY_URL:'https://relay.invalid/send',
  SUNLAND_SMS_RELAY_KEY:'synthetic-runtime-relay-key',PHONE_RELEASE_MODE:'canary',PHONE_AUTH_HMAC_KEY:secret,
  PHONE_AUTH_HMAC_KEY_ID:'v1',PHONE_AUTH_ADMIN_TOKEN:admin,PHONE_SMS_CANARY_PHONE_HASHES:JSON.stringify([hash]),
  TURNSTILE_SECRET:'synthetic',PHONE_TURNSTILE_HOSTNAME:'sunland.dev',TEST_CLOCK:String(Date.parse('2026-11-04T00:00:00Z')),
  PHONE_AUTH_POLICY:JSON.stringify({perPhoneDaily:3,perIpDaily:3,dailyLimit:3,unitCostMicros:200000,
    dailyBudgetMicros:600000,totalBudgetMicros:600000,ipRequestsPerMinute:10,globalRequestsPerMinute:20})};
let runtime,stub,relayCalls=0,unexpected=0,lastCode;
const options={name:'phone-auth',script:clocked(previousScript),modules:true,compatibilityDate:'2026-03-21',host:'127.0.0.1',port:0,
  log:new Log(LogLevel.ERROR),cf:false,bindings,durableObjects:{PHONE_AUTH_COORDINATOR:{className:'PhoneAuthCoordinator',useSQLite:true}},
  resourcePersistencePath:join(root,'state'),outboundService:async request=>{
    const u=new URL(request.url);
    if(u.hostname==='challenges.cloudflare.com')return Response.json({success:true,hostname:'sunland.dev',action:'phone_login',challenge_ts:new Date(Number(bindings.TEST_CLOCK)).toISOString()});
    if(u.hostname==='relay.invalid'){relayCalls++;lastCode=(await request.json()).code;return Response.json({ok:1});}
    unexpected++;throw Error('Unexpected network blocked');
  }};
async function start(){runtime=new Miniflare(convertV4MiniflareOptions(options));stub=(await runtime.getDurableObjectNamespace('PHONE_AUTH_COORDINATOR')).getByName(SINGLETON_NAME);}
async function restart(script){await runtime.dispose();runtime=undefined;if(script)options.script=clocked(script);await start();}
const post=(path,body={})=>stub.fetch('https://internal/'+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+admin},body:JSON.stringify(body)});
let seq=0;
const send=()=>post('send',{input:{phone,purpose:'login',turnstile_token:'login:synthetic-'+(++seq)},context:{ip:'192.0.2.1'}});
try {
  await start();assert.equal((await post('initialize')).status,200);
  for(let i=0;i<3;i++){
    assert.equal((await send()).status,200);bindings.TEST_CLOCK=String(Number(bindings.TEST_CLOCK)+600001);await restart();
  }
  const before=await (await post('status')).json();assert.equal(before.test_reserved,3);assert.equal(before.total_micros,600000);
  assert.equal((await send()).status,429);assert.equal(relayCalls,3);
  bindings.PHONE_LOGIN_EXTRA_CANARY_ENABLED='true';await restart(nextScript);
  const stable=await (await post('status')).json();assert.equal(stable.state,'ready');assert.equal(stable.test_reserved,3);
  const attempts=await Promise.all([send(),send()]);assert.equal(attempts.filter(r=>r.status===200).length,1);
  assert.equal(attempts.filter(r=>r.status===429).length,1);assert.equal(relayCalls,4);
  const accepted=await attempts.find(r=>r.status===200).json();await restart();
  const after=await (await post('status')).json();assert.equal(after.state,'ready');assert.equal(after.test_reserved,3);assert.equal(after.total_micros,800000);
  const checked=await post('check',{input:{phone,purpose:'login',code:lastCode,challenge_id:accepted.challenge_id},context:{ip:'192.0.2.1'}});
  assert.equal(checked.status,200);
  bindings.TEST_CLOCK=String(Number(bindings.TEST_CLOCK)+600001);await restart(previousScript);
  const rolledBack=await (await post('status')).json();assert.equal(rolledBack.state,'ready');assert.equal(rolledBack.test_reserved,3);assert.equal(rolledBack.total_micros,800000);
  assert.equal((await send()).status,429);assert.equal(relayCalls,4);assert.equal(unexpected,0);
  console.log('真实 workerd/SQLite：原账本三次、追加并发一次、重启、验证码消费和实际旧版回滚均通过；无真实外部请求。');
} finally {if(runtime)await runtime.dispose();await rm(root,{recursive:true,force:true});}
