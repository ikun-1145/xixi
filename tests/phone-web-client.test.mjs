import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
const source=readFileSync(new URL('../p/js/phone-auth.js',import.meta.url),'utf8');
function harness(options={}){
 const dom=new JSDOM('<meta name="sunland-turnstile-sitekey" content="mock-key">',{url:'https://sunland.dev',runScripts:'outside-only'});
 dom.window.AbortController=AbortController;dom.window.crypto.randomUUID=crypto.randomUUID.bind(crypto);dom.window.eval(source);
 let token='existing-jwt',now=1000;const calls=[];
 const client=dom.window.SunlandPhoneAuth.createClient({getToken:()=>token,now:()=>now,captcha:async action=>'captcha-'+action,emailCaptcha:async()=>'mock-geetest',fetchImpl:async(url,init)=>{calls.push({url,headers:init.headers,body:JSON.parse(init.body)});return Response.json({success:true,challenge_id:'76ded2a7-dc8d-4cc1-a338-c914c3292530',expires_in:300,retry_after:600});},...options});
 return {dom,client,calls,setToken:v=>token=v,setTime:v=>now=v,api:dom.window.SunlandPhoneAuth};
}
test('send uses contract fields, specific captcha action and no client selected user id',async()=>{
 const h=harness();await h.client.send('+8613800000000','login');assert.match(h.calls[0].url,/\/v1\/phone\/send-code$/);assert.deepEqual(h.calls[0].body,{phone:'13800000000',purpose:'login',turnstile_token:'captcha-phone_login'});assert.ok(!h.calls[0].headers.Authorization);
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
