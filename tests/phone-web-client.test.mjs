import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
const source=readFileSync(new URL('../p/js/phone-auth.js',import.meta.url),'utf8');
function harness(options={}){
 const dom=new JSDOM('<meta name="sunland-turnstile-sitekey" content="mock-key">',{url:'https://sunland.dev',runScripts:'outside-only'});
 dom.window.AbortController=AbortController;dom.window.crypto.randomUUID=crypto.randomUUID.bind(crypto);dom.window.eval(source);
 let token='existing-jwt',now=1000;const calls=[];
 const client=dom.window.SunlandPhoneAuth.createClient({getToken:()=>token,now:()=>now,captcha:async action=>'captcha-'+action,emailCaptcha:async()=>'mock-geetest',fetchImpl:async(url,init)=>{calls.push({url,headers:init.headers,body:JSON.parse(init.body)});return Response.json({success:true,challenge_id:JSON.parse(init.body).challenge_id,expires_in:300,retry_after:600});},...options});
 return {dom,client,calls,setToken:v=>token=v,setTime:v=>now=v,api:dom.window.SunlandPhoneAuth};
}
test('send uses contract fields, specific captcha action and no client selected user id',async()=>{
 const h=harness();await h.client.send('+8613800000000','login');assert.match(h.calls[0].url,/\/v1\/phone\/send-code$/);assert.deepEqual({...h.calls[0].body,challenge_id:'id'},{phone:'13800000000',purpose:'login',turnstile_token:'captcha-phone_login',challenge_id:'id'});assert.match(h.calls[0].body.challenge_id,/^[0-9a-f-]{36}$/);assert.ok(!h.calls[0].headers.Authorization);
 assert.ok(h.api.cooldown('13800000000')>0);h.dom.window.close();
});
test('bad phone and duplicate same-client pending sends fail before a second network request',async()=>{
 let resolve;const h=harness({captcha:()=>new Promise(r=>resolve=r)});await assert.rejects(h.client.send('123','login'),{code:'INVALID_REQUEST'});
 const first=h.client.send('13800000000','login');await assert.rejects(h.client.send('13800000000','login'),{code:'BUSY'});resolve('captcha');await first;assert.equal(h.calls.length,1);h.dom.window.close();
});
test('session change during captcha cannot send under a different account',async()=>{
 let resolve;const h=harness({captcha:()=>new Promise(r=>resolve=r)});const first=h.client.send('13800000000','bind','proof');h.setToken('new-jwt');resolve('captcha');await assert.rejects(first,{code:'SESSION_CHANGED'});assert.equal(h.calls.length,0);h.dom.window.close();
});
test('unknown remote errors never leak raw phone or code; no write retries',async()=>{
 let n=0;const h=harness({fetchImpl:async()=>{n++;return Response.json({code:'mystery',error:'13800000000 123456 SECRET'},{status:500});}});
 await assert.rejects(h.client.mutate('unbind',{reauth_token:'proof'}),e=>!e.message.includes('SECRET')&&e.code==='SERVICE_UNAVAILABLE');assert.equal(n,1);h.dom.window.close();
});
test('full fetch timeout is bounded even if transport ignores abort',async()=>{
 const h=harness({timeoutMs:10,fetchImpl:()=>new Promise(()=>{})});await assert.rejects(h.client.status(),{code:'TIMEOUT'});h.dom.window.close();
});
test('cancel and changed token discard late responses',async()=>{
 let resolve;const h=harness({fetchImpl:()=>new Promise(r=>resolve=r)});const p=h.client.status();h.client.cancel();resolve(Response.json({bound:false,phone:null,has_email:true}));await assert.rejects(p,{code:'SESSION_CHANGED'});h.dom.window.close();
});
test('no configured Turnstile sitekey fails closed without contacting SMS API',async()=>{
 const h=harness();h.dom.window.document.querySelector('meta').remove();const client=h.api.createClient({fetchImpl:async()=>{assert.fail('must not call API');}});await assert.rejects(client.send('13800000000','login'),{code:'SMS_DISABLED'});h.dom.window.close();
});
test('refresh session validates same subject and does not replay sensitive requests',async()=>{
 const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64url');const old='e30.'+encode({id:'user-a'})+'.old',next='e30.'+encode({id:'user-a'})+'.new';
 const h=harness({getToken:()=>h.dom.window.localStorage.getItem('token'),fetchImpl:async()=>Response.json({token:next,user:{id:'user-a',email:null}})});h.dom.window.localStorage.setItem('token',old);await h.client.refreshSession();assert.equal(h.dom.window.localStorage.getItem('token'),next);h.dom.window.close();
});
test('status refuses unmasked or malformed phone data before any UI can display it',async()=>{
 for(const result of [{bound:true,phone:'13800000000',has_email:true},{bound:'yes',phone:null,has_email:true},{bound:false,phone:null,has_email:'yes'}]){
  const h=harness({fetchImpl:async()=>Response.json(result)});await assert.rejects(h.client.status(),{code:'SERVICE_UNAVAILABLE'});h.dom.window.close();
 }
});
test('cancelled GeeTest initialization destroys late widgets without reopening a challenge',async t=>{
 const h=harness();t.after(()=>h.dom.window.close());let ready,shown=0,destroyed=0;
 h.dom.window.initGeetest4=(_options,callback)=>{ready=callback;};const controller=new AbortController();const p=h.api.runEmailCaptcha({signal:controller.signal});await new Promise(r=>setImmediate(r));controller.abort();await assert.rejects(p,{code:'SESSION_CHANGED'});
 ready({onReady(fn){fn();},onSuccess(){},onError(){},onClose(){},showCaptcha(){shown++;},destroy(){destroyed++;}});
 assert.equal(shown,0);assert.equal(destroyed,1);
});

test('lost send response keeps a reload-safe handle and never sends again automatically',async t=>{
 let sends=0,verifies=0,id;
 const fetchImpl=async(url,init)=>{
  const body=JSON.parse(init.body);
  if(url.endsWith('/send-code')){sends++;id=body.challenge_id;return new Promise(()=>{});}
  verifies++;assert.equal(body.challenge_id,id);return Response.json({token:'synthetic-token',user:{id:'synthetic-user'}});
 };
 const h=harness({sendTimeoutMs:5,fetchImpl});t.after(()=>h.dom.window.close());
 await assert.rejects(h.client.send('13800000000','login'),{code:'SEND_UNCERTAIN'});
 const stored=h.dom.window.sessionStorage.getItem('sunland.phone.pending.v1');
 assert.ok(stored);for(const raw of ['13800000000','123456','existing-jwt','captcha-phone_login'])assert.equal(stored.includes(raw),false);
 const reloaded=harness({fetchImpl});t.after(()=>reloaded.dom.window.close());
 reloaded.dom.window.sessionStorage.setItem('sunland.phone.pending.v1',stored);
 const recovery=reloaded.client.recovery('login');assert.equal(recovery.challenge_id,id);assert.ok(recovery.expires_in>0);
 await assert.rejects(reloaded.client.send('13900000000','login'),{code:'SEND_UNCERTAIN'});assert.equal(sends,1);
 await reloaded.client.login('13800000000',recovery.challenge_id,'123456');
 assert.equal(verifies,1);assert.ok(reloaded.dom.window.sessionStorage.getItem('sunland.phone.pending.v1'));
 reloaded.client.acknowledgeLoginSaved(recovery.challenge_id);
 assert.equal(reloaded.dom.window.sessionStorage.getItem('sunland.phone.pending.v1'),null);
});

test('pending verification, session cancellation, and expired recovery never trigger a resend',async t=>{
 let sends=0,verifies=0;
 const h=harness({sendTimeoutMs:5,fetchImpl:async(url)=>{
  if(url.endsWith('/send-code')){sends++;return new Promise(()=>{});}
  verifies++;return Response.json({code:'CHALLENGE_PENDING'},{status:409});
 }});t.after(()=>h.dom.window.close());
 await assert.rejects(h.client.send('13800000000','login'),{code:'SEND_UNCERTAIN'});
 const saved=h.client.recovery('login');assert.ok(saved);
 await assert.rejects(h.client.login('13800000000',saved.challenge_id,'123456'),{code:'CHALLENGE_PENDING'});
 assert.equal(h.client.recovery('login').challenge_id,saved.challenge_id);assert.equal(verifies,1);
 assert.throws(()=>h.client.acknowledgeReviewed('login',true),{code:'INVALID_REQUEST'});
 h.client.cancel();const stale=JSON.parse(h.dom.window.sessionStorage.getItem('sunland.phone.pending.v1'));stale.expiresAt=0;
 h.dom.window.sessionStorage.setItem('sunland.phone.pending.v1',JSON.stringify(stale));
 assert.equal(h.client.recovery('login').expired,true);
 await assert.rejects(h.client.send('13800000000','login'),{code:'SEND_UNCERTAIN'});assert.equal(sends,1);
 assert.throws(()=>h.client.acknowledgeReviewed('login',false),{code:'INVALID_REQUEST'});
 h.client.acknowledgeReviewed('login',true);assert.equal(h.client.recovery('login'),null);
});

test('old Worker rejection never causes an automatic downgrade or resend',async t=>{
 let sends=0;const h=harness({fetchImpl:async()=>{sends++;return Response.json({code:'INVALID_REQUEST'},{status:400});}});
 t.after(()=>h.dom.window.close());
 await assert.rejects(h.client.send('13800000000','login'),{code:'SEND_UNCERTAIN'});
 assert.ok(h.client.recovery('login')?.challenge_id);
 await assert.rejects(h.client.send('13800000000','login'),{code:'SEND_UNCERTAIN'});assert.equal(sends,1);
});

test('send is refused before network when recovery storage is unavailable or corrupt',async t=>{
 let calls=0;const h=harness({fetchImpl:async()=>{calls++;throw Error('must not send');}});t.after(()=>h.dom.window.close());
 h.dom.window.sessionStorage.setItem('sunland.phone.pending.v1','invalid');
 await assert.rejects(h.client.send('13800000000','login'),{code:'SERVICE_UNAVAILABLE'});assert.equal(calls,0);
 h.dom.window.sessionStorage.removeItem('sunland.phone.pending.v1');
 Object.defineProperty(h.dom.window,'sessionStorage',{configurable:true,get(){throw Error('disabled');}});
 await assert.rejects(h.client.send('13800000000','login'),{code:'SERVICE_UNAVAILABLE'});assert.equal(calls,0);
});

test('concurrent client instances cannot overwrite the tab recovery handle or issue a second send',async t=>{
 let release,calls=0;const captcha=()=>new Promise(r=>{release=r;});
 const h=harness({captcha:async()=>{await captcha();return 'captcha';},fetchImpl:async()=>{calls++;return new Promise(()=>{});},sendTimeoutMs:10});
 t.after(()=>h.dom.window.close());
 let secondRelease;
 const other=h.api.createClient({getToken:()=>null,captcha:()=>new Promise(r=>{secondRelease=r;}),fetchImpl:async()=>{calls++;return new Promise(()=>{});},sendTimeoutMs:10});
 const first=h.client.send('13800000000','login');const second=other.send('13900000000','login');
 release();await new Promise(r=>setImmediate(r));secondRelease('captcha');
 await assert.rejects(second,{code:'SEND_UNCERTAIN'});await assert.rejects(first,{code:'SEND_UNCERTAIN'});assert.equal(calls,1);
});

test('unknown sends and pending verification have clear translations without retry instructions',async t=>{
 const h=harness();t.after(()=>h.dom.window.close());
 for(const lang of ['zh-Hant','en','ja','ko','es']){
  h.dom.window.SiteI18n={getLanguage:()=>lang,translate:s=>s};
  assert.notEqual(h.api.errorText({code:'SEND_UNCERTAIN'}),'发送状态未知，请勿重复发送；收到验证码后可尝试验证，未必能通过');
  assert.notEqual(h.api.errorText({code:'CHALLENGE_PENDING'}),'发送仍在处理中，请稍后再验证');
 }
});

test('only known pre-reservation denials clear recovery; ambiguous failures remain blocked',async t=>{
 for(const code of ['IDENTITY_DISABLED','CAPTCHA_FAILED','CANARY_DENIED','RELEASE_CONFIG']){
  const h=harness({fetchImpl:async()=>Response.json({code},{status:503})});t.after(()=>h.dom.window.close());
  await assert.rejects(h.client.send('13800000000','login'),{code});assert.equal(h.client.recovery('login'),null);
 }
 for(const code of ['PROVIDER_UNAVAILABLE','UPSTREAM_TIMEOUT','SERVICE_UNAVAILABLE','INVALID_REQUEST']){
  const h=harness({fetchImpl:async()=>Response.json({code},{status:503})});t.after(()=>h.dom.window.close());
  await assert.rejects(h.client.send('13800000000','login'),{code:'SEND_UNCERTAIN'});assert.ok(h.client.recovery('login'));
 }
});

test('SMS disabled after reservation retains the handle until reviewed',async()=>{
 const h=harness();const c=h.api.createClient({captcha:async()=> 'mock',fetchImpl:async()=>Response.json({code:'SMS_DISABLED'},{status:503})});
 await assert.rejects(c.send('13800000000','login'),{code:'SEND_UNCERTAIN'});assert.ok(c.recovery('login'));h.dom.window.close();
});
test('unknown verification result retains the handle and warns against resending',async()=>{
 const h=harness();let id;const c=h.api.createClient({captcha:async()=> 'mock',fetchImpl:async(url,init)=>{if(url.endsWith('send-code')){id=JSON.parse(init.body).challenge_id;return Response.json({success:true,challenge_id:id,expires_in:300,retry_after:600});}throw Error('lost');}});
 await c.send('13800000000','login');await assert.rejects(c.login('13800000000',id,'123456'),{code:'VERIFY_UNCERTAIN'});assert.equal(c.recovery('login').challenge_id,id);h.dom.window.close();
});
