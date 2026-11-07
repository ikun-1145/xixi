import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
const html=readFileSync(new URL('../login.html',import.meta.url),'utf8');
const client=readFileSync(new URL('../p/js/phone-auth.js',import.meta.url),'utf8');
function harness({phoneEnabled=true}={}){
 const dom=new JSDOM(html,{url:'https://sunland.dev/login.html',runScripts:'outside-only'});const w=dom.window;const calls=[];w.document.querySelector('meta[name="sunland-phone-ui-enabled"]').content=String(phoneEnabled);
 w.AbortController=AbortController;w.crypto.randomUUID=crypto.randomUUID.bind(crypto);w.alert=()=>{};
 w.initGeetest4=(_opts,callback)=>callback({onReady(fn){fn();},onError(){},onSuccess(fn){w.__emailCaptchaSuccess=fn;},getValidate(){return {mock:true};},showCaptcha(){},appendTo(){}});
 w.fetch=async(url,init)=>{const body=JSON.parse(init.body);calls.push({url,body});return Response.json(url.endsWith('send-code')?{success:true,challenge_id:body.challenge_id,expires_in:300,retry_after:600}:{token:'mock-jwt',user:{id:'same-account',email:null},onboarding:{version:0,step:1},is_new_user:true});};
 w.SunlandLoginBanStatus={check:async()=>({isBanned:false})};w.eval(client);const real=w.SunlandPhoneAuth;w.SunlandPhoneAuth={...real,createClient:opts=>real.createClient({...opts,captcha:async()=>'mock'})};
 for(const script of [...w.document.querySelectorAll('script:not([src])')])w.eval(script.textContent);
 return{dom,w,calls};
}
const flush=()=>new Promise(r=>setTimeout(r,0));
test('phone mode sends contract request, duplicate clicks suppressed, shared login persists same token/user format',async()=>{
 const h=harness(),d=h.w.document;
 assert.ok(d.querySelector('#phoneLoginTab'));d.querySelector('#phoneLoginTab').click();
 d.querySelector('#phoneInput').value='13800000000';d.querySelector('#sendPhoneCodeBtn').click();d.querySelector('#sendPhoneCodeBtn').click();await flush();
 assert.equal(h.calls.length,1);assert.equal(h.calls[0].body.purpose,'login');assert.equal(d.querySelector('#sendPhoneCodeBtn').disabled,true);
 d.querySelector('#phoneCodeInput').value='123456';d.querySelector('#agreeCheck').checked=true;d.querySelector('#agreeCheck').dispatchEvent(new h.w.Event('change'));
 d.querySelector('#loginBtn').click();await flush();await flush();assert.equal(h.w.localStorage.getItem('token'),'mock-jwt');assert.equal(JSON.parse(h.w.localStorage.getItem('user')).id,'same-account');
 assert.ok(!JSON.stringify({...h.w.localStorage}).includes('13800000000'));h.dom.window.close();
});
test('mode switch clears phone and code without persisting temporary state',async()=>{
 const h=harness(),d=h.w.document;assert.ok(d.querySelector('#phoneLoginTab'));d.querySelector('#phoneLoginTab').click();d.querySelector('#phoneInput').value='13800000000';d.querySelector('#phoneCodeInput').value='123456';d.querySelector('#emailLoginTab').click();assert.equal(d.querySelector('#phoneInput').value,'');assert.equal(d.querySelector('#phoneCodeInput').value,'');assert.equal(d.querySelector('#emailInput').hidden,false);h.dom.window.close();
});

test('switching modes during pending email captcha restores send button and discards its late result',async t=>{
 const h=harness(),d=h.w.document;t.after(()=>h.dom.window.close());d.querySelector('#emailInput').value='test@example.invalid';d.querySelector('#sendCodeBtn').click();await flush();assert.equal(d.querySelector('#sendCodeBtn').disabled,true);
 const finish=h.w.__emailCaptchaSuccess;assert.equal(typeof finish,'function');d.querySelector('#phoneLoginTab').click();d.querySelector('#emailLoginTab').click();finish();await flush();
 assert.equal(d.querySelector('#sendCodeBtn').disabled,false);assert.equal(h.calls.length,0);h.dom.window.close();
});
test('BFCache return preserves uncertain SMS and blocks another send',async t=>{
 const h=harness(),d=h.w.document;t.after(()=>h.dom.window.close());let finish;
 h.w.fetch=()=>new Promise(r=>finish=r);d.querySelector('#phoneLoginTab').click();d.querySelector('#phoneInput').value='13800000000';d.querySelector('#sendPhoneCodeBtn').click();await flush();assert.equal(d.querySelector('#sendPhoneCodeBtn').disabled,true);
 h.w.dispatchEvent(new h.w.PageTransitionEvent('pagehide',{persisted:true}));h.w.dispatchEvent(new h.w.PageTransitionEvent('pageshow',{persisted:true}));
 assert.equal(d.querySelector('#sendPhoneCodeBtn').disabled,true);assert.equal(d.querySelector('#phoneCodeInput').value,'');finish(Response.json({success:true,challenge_id:'old',expires_in:300,retry_after:600}));await flush();assert.equal(d.querySelector('#loginMsg').textContent,'');
});

test('phone entry release flag defaults closed and cannot switch away from email',t=>{
 const h=harness({phoneEnabled:false});t.after(()=>h.dom.window.close());const d=h.w.document;
 assert.equal(d.querySelector('meta[name="sunland-turnstile-sitekey"]').content,'0x4AAAAAAC_W2Wj2YdkrQiMf');assert.equal(d.querySelector('#phoneLoginTab').closest('.phone-tabs').hidden,true);d.querySelector('#phoneLoginTab').click();assert.equal(d.querySelector('#phoneLoginFields').hidden,true);assert.equal(d.querySelector('#emailLoginField').hidden,false);
});

test('lost send response recovers in the page after the number is re-entered',async t=>{
 const h=harness(),d=h.w.document;t.after(()=>h.dom.window.close());let sendId;let sends=0;
 h.w.fetch=async(url,init)=>{const body=JSON.parse(init.body);if(url.endsWith('send-code')){sends++;sendId=body.challenge_id;throw new Error('lost');}assert.equal(body.challenge_id,sendId);return Response.json({token:'mock-jwt',user:{id:'same-account'}});};
 d.querySelector('#phoneLoginTab').click();const input=d.querySelector('#phoneInput');input.value='13800000000';d.querySelector('#sendPhoneCodeBtn').click();await flush();
 assert.equal(d.querySelector('#sendPhoneCodeBtn').disabled,true);assert.match(d.querySelector('#loginMsg').textContent,/未知/);
 d.querySelector('#emailLoginTab').click();d.querySelector('#phoneLoginTab').click();input.value='13800000000';input.dispatchEvent(new h.w.Event('input'));
 d.querySelector('#phoneCodeInput').value='123456';d.querySelector('#agreeCheck').checked=true;d.querySelector('#agreeCheck').dispatchEvent(new h.w.Event('change'));d.querySelector('#loginBtn').click();await flush();await flush();
 assert.equal(sends,1);assert.equal(h.w.localStorage.getItem('token'),'mock-jwt');
});

test('real language catalog translates phone login labels and authentication errors', t=>{
 const h=harness();t.after(()=>h.dom.window.close());
 h.w.eval(readFileSync(new URL('../p/js/site-i18n-extra.js',import.meta.url),'utf8'));
 h.w.eval(readFileSync(new URL('../p/js/site-i18n.js',import.meta.url),'utf8'));
 const errors=[...client.matchAll(/\b[A-Z_]+:'([^']+)'/g)].map(m=>m[1]);
 const labels=['中国大陆手机号','短信验证码','登录或注册','首次验证手机号将自动注册，不会合并邮箱账号','手机号登录','邮箱登录','请输入6位验证码'];
 for(const lang of ['en','ja','ko','es','zh-Hant']){
  for(const source of [...errors,...labels]){
   const translated=h.w.SiteI18n.translate(source,lang);
   if(['发送状态未知，请勿重复发送；如收到验证码，请继续验证','验证结果未知，请先检查登录状态，勿重复发送短信','发送仍在处理中，请稍后再验证'].includes(source)) continue;
   assert.ok(translated && (lang === 'zh-Hant' || translated !== source),`${lang}: missing ${source}`);
  }
 }
 h.w.SiteI18n.setLanguage('en',{persist:false});h.w.document.querySelector('#phoneLoginTab').click();
 assert.equal(h.w.document.querySelector('label[for="phoneInput"]').textContent,'Mainland China mobile number');
 assert.equal(h.w.document.querySelector('#loginBtn').textContent,'Sign in or register');
 assert.match(h.w.document.querySelector('.subtitle').textContent,/account/i);
 assert.notEqual(h.w.SunlandPhoneAuth.errorText({code:'CODE_INVALID'}),'验证码错误或已过期，请重新获取');
});

test('phone client uses a recovery-specific cache key and stays disabled by default',()=>{
 assert.match(html,/p\/js\/phone-auth\.js\?v=20261106-recovery-1/);
 assert.match(html,/<meta name="sunland-phone-ui-enabled" content="false">/);
});

test('expired phone send requires waiting and explicit review before local recovery is cleared', t=>{
 const h=harness(), d=h.w.document;t.after(()=>h.dom.window.close());const key='sunland.phone.pending.v1';
 const pending={version:1,id:crypto.randomUUID(),purpose:'login',expiresAt:Date.now()-299000};
 h.w.sessionStorage.setItem(key,JSON.stringify(pending));d.querySelector('#phoneLoginTab').click();
 const button=d.querySelector('#reviewPhoneSendBtn'),send=d.querySelector('#sendPhoneCodeBtn');
 assert.equal(button.hidden,true);assert.equal(send.disabled,true);
 pending.expiresAt=Date.now()-301000;h.w.sessionStorage.setItem(key,JSON.stringify(pending));
 d.querySelector('#emailLoginTab').click();d.querySelector('#phoneLoginTab').click();assert.equal(button.hidden,false);
 h.w.confirm=()=>false;button.click();assert.ok(h.w.sessionStorage.getItem(key));assert.equal(send.disabled,true);
 h.w.confirm=()=>true;button.click();assert.equal(h.w.sessionStorage.getItem(key),null);assert.equal(send.disabled,false);assert.equal(h.calls.length,0);
});
