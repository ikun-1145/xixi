import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
const html=readFileSync(new URL('../login.html',import.meta.url),'utf8');
const client=readFileSync(new URL('../p/js/phone-auth.js',import.meta.url),'utf8');
function harness(){
 const dom=new JSDOM(html,{url:'https://sunland.dev/login.html',runScripts:'outside-only'});const w=dom.window;const calls=[];
 w.AbortController=AbortController;w.crypto.randomUUID=crypto.randomUUID.bind(crypto);w.alert=()=>{};
 w.initGeetest4=(_opts,callback)=>callback({onReady(fn){fn();},onError(){},onSuccess(fn){w.__emailCaptchaSuccess=fn;},getValidate(){return {mock:true};},showCaptcha(){},appendTo(){}});
 w.fetch=async(url,init)=>{const body=JSON.parse(init.body);calls.push({url,body});return Response.json(url.endsWith('send-code')?{success:true,challenge_id:'b7893aa3-b9c1-4ed1-a0aa-2a56ad25ecb9',expires_in:300,retry_after:600}:{token:'mock-jwt',user:{id:'same-account',email:null},onboarding:{version:0,step:1},is_new_user:true});};
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
test('BFCache return clears pending SMS and restarts a usable login flow',async t=>{
 const h=harness(),d=h.w.document;t.after(()=>h.dom.window.close());let finish;
 h.w.fetch=()=>new Promise(r=>finish=r);d.querySelector('#phoneLoginTab').click();d.querySelector('#phoneInput').value='13800000000';d.querySelector('#sendPhoneCodeBtn').click();await flush();assert.equal(d.querySelector('#sendPhoneCodeBtn').disabled,true);
 h.w.dispatchEvent(new h.w.PageTransitionEvent('pagehide',{persisted:true}));h.w.dispatchEvent(new h.w.PageTransitionEvent('pageshow',{persisted:true}));
 assert.equal(d.querySelector('#sendPhoneCodeBtn').disabled,false);assert.equal(d.querySelector('#phoneCodeInput').value,'');finish(Response.json({success:true,challenge_id:'old',expires_in:300,retry_after:600}));await flush();assert.equal(d.querySelector('#loginMsg').textContent,'');
});
