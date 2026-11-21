import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

const html=readFileSync(new URL('../ai_settings.html',import.meta.url),'utf8');
const source=readFileSync(new URL('../p/js/phone-settings.js',import.meta.url),'utf8');
const tick=()=>new Promise(r=>setTimeout(r,0));
const proof='A'.repeat(43);
function harness({enabled=true,bound=false,hasEmail=true,mutate,send}={}) {
  const dom=new JSDOM(html,{url:'https://sunland.dev/ai_settings.html',runScripts:'outside-only'}),w=dom.window,calls=[];
  let currentToken='session-a';const status={bound,has_email:hasEmail,phone:bound?'+86 *******0000':null};
  const c={capture:()=>currentToken,current:s=>s===currentToken,cancel(){},recovery:()=>null,pendingRecovery:()=>null,acknowledgeReviewed(){},
    status:async()=>({...status}),emailReauthSend:async action=>{calls.push(['emailSend',action]);},
    emailProof:async(code,action)=>{calls.push(['emailProof',code,action]);return {reauth_token:proof};},
    send:send|| (async(phone,purpose)=>{calls.push(['send',phone,purpose]);return {challenge_id:'challenge'};}),
    phoneProof:async(phone,id,code,action)=>{calls.push(['phoneProof',phone,id,code,action]);return {reauth_token:proof};},
    mutate:mutate|| (async(action,data)=>{calls.push(['mutate',action,data]);status.bound=action!=='unbind';status.phone=status.bound?'+86 *******1234':null;return {ok:true};})};
  w.SunlandPhoneAuth={createClient:()=>{calls.push(['create']);return c;},normalizePhone:x=>{if(!/^1\d{10}$/.test(x))throw Object.assign(Error(),{code:'INVALID_REQUEST'});return x;},errorText:e=>String(e?.code||'unknown')};
  w.document.querySelector('meta[name="sunland-phone-settings-enabled"]').content=String(enabled);
  w.SiteI18n={getLanguage:()=> 'en'};w.confirm=()=>true;w.eval(source);
  return {w,c,calls,dom,setToken(x){currentToken=x;},el(id){return w.document.getElementById('phoneSettings'+id);}};
}
async function start(h) { await tick(); if(h.el('').hidden) { h.w.document.dispatchEvent(new h.w.Event('DOMContentLoaded')); await tick(); } }

test('settings are closed by default and perform no network or identity work',async t=>{
 const h=harness({enabled:false});t.after(()=>h.dom.window.close());await tick();assert.equal(h.el('').hidden,true);assert.deepEqual(h.calls,[]);
});
test('email reauthentication uses current session and requested action before binding',async t=>{
 const h=harness();t.after(()=>h.dom.window.close());await start(h);
 h.el('Bind').click();h.el('AuthSend').click();await tick();assert.ok(h.calls.some(x=>x[0]==='emailSend'&&x[1]==='bind'));
 h.el('AuthCode').value='123456';h.el('AuthNext').click();await tick();assert.equal(h.el('Target').hidden,false);
 h.el('NewPhone').value='13800001234';h.el('TargetSend').click();await tick();h.el('NewCode').value='654321';h.el('TargetConfirm').click();await tick();
 const mutation=h.calls.find(x=>x[0]==='mutate');assert.equal(mutation[1],'bind');assert.equal(mutation[2].reauth_token,proof);assert.equal(h.el('Value').textContent,'+86 *******1234');
});
test('email send timeout retains cooldown and cannot immediately send again',async t=>{
 const h=harness();t.after(()=>h.dom.window.close());let sends=0;
 h.c.emailReauthSend=async()=>{sends++;throw Object.assign(Error(),{code:'TIMEOUT'});};await start(h);
 h.el('Bind').click();h.el('AuthSend').click();await tick();
 assert.equal(sends,1);assert.equal(h.el('AuthSend').disabled,true);assert.match(h.el('AuthSend').textContent,/resend/);assert.match(h.el('Message').textContent,/unknown/);
 h.el('AuthSend').click();await tick();assert.equal(sends,1);
});
test('phone-only account must verify its existing number and cannot unlink its last factor',async t=>{
 const h=harness({bound:true,hasEmail:false});t.after(()=>h.dom.window.close());await start(h);assert.equal(h.el('Unbind').disabled,true);
 h.el('Change').click();h.el('OldPhone').value='13800000000';h.el('AuthSend').click();await tick();h.el('AuthCode').value='123456';h.el('AuthNext').click();await tick();
 assert.deepEqual(h.calls.find(x=>x[0]==='phoneProof'),['phoneProof','13800000000','challenge','123456','change']);assert.equal(h.el('Target').hidden,false);
});
test('uncertain mutation is not retried and requires an explicit account review',async t=>{
 let n=0;const h=harness({mutate:async()=>{n++;throw Object.assign(Error(),{code:'TIMEOUT'});}});t.after(()=>h.dom.window.close());await start(h);
 h.el('Bind').click();h.el('AuthCode').value='123456';h.el('AuthNext').click();await tick();h.el('NewPhone').value='13800001234';h.el('TargetSend').click();await tick();h.el('NewCode').value='654321';h.el('TargetConfirm').click();await tick();
 assert.equal(n,1);assert.equal(h.w.sessionStorage.getItem('sunland.phone.mutation-uncertain.v1'),'1');assert.equal(h.el('Review').hidden,false);
 h.el('TargetConfirm').click();await tick();assert.equal(n,1);h.el('Review').click();await tick();assert.equal(h.w.sessionStorage.getItem('sunland.phone.mutation-uncertain.v1'),null);
});
test('old pending bind can be reviewed after status changes and bind action disappears',async t=>{
 const h=harness({bound:true});t.after(()=>h.dom.window.close());let reviewed;
 h.c.pendingRecovery=()=>({purpose:'bind',review_after:Date.now()-1});
 h.c.acknowledgeReviewed=(purpose,confirmed)=>{reviewed=[purpose,confirmed];};await start(h);
 assert.equal(h.el('Bind').hidden,true);assert.equal(h.el('Review').hidden,false);
 h.el('Review').click();await tick();assert.deepEqual(reviewed,['bind',true]);
});
test('session switch discards an in-flight proof',async t=>{
 let done;const h=harness();t.after(()=>h.dom.window.close());h.c.emailProof=()=>new Promise(r=>{done=r;});await start(h);
 h.el('Bind').click();h.el('AuthCode').value='123456';h.el('AuthNext').click();h.setToken('session-b');h.w.dispatchEvent(new h.w.StorageEvent('storage',{key:'token'}));done({reauth_token:proof});await tick();
 assert.equal(h.el('Target').hidden,true);assert.ok(!h.calls.some(x=>x[0]==='mutate'));
});
