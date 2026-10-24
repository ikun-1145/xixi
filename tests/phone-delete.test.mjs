import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {normalizeUserId} from '../ai/user-identity.js';
import {vaultPrefix} from '../ai/history-vault.js';
const source=(await readFile(new URL('../ai/account-delete.js',import.meta.url),'utf8')).replace(/^import .*\n/gm,'').replaceAll('export ','');
const flush=async()=>{for(let i=0;i<6;i++)await new Promise(r=>setImmediate(r));};
async function fixture({email=null,bound=true,banned=false}={}) {
 const dom=new JSDOM('<button id="openAccountDeleteBtn">delete</button><dialog id="accountDeleteDialog"><button id="accountDeleteCloseBtn">close</button><div id="accountDeleteBody"></div></dialog>',{url:'https://sunland.dev/ai_settings.html',runScripts:'outside-only'});const w=dom.window;
 w.normalizeUserId=normalizeUserId;w.vaultPrefix=vaultPrefix;w.localStorage.setItem('token','session-a');w.localStorage.setItem('user',JSON.stringify({id:'stale-user',email:'wrong@example.test'}));w.localStorage.setItem('lang','ja');
 const calls=[];let epoch=0;
 const client={capture:()=>({token:w.localStorage.getItem('token'),epoch}),current:c=>c.epoch===epoch&&c.token===w.localStorage.getItem('token'),cancel(){epoch++;},
  deletionIdentity:async()=>({user_id:'user-a',email,identity_status:'active',is_banned:banned}),
  status:async()=>{if(banned)throw Object.assign(Error(),{code:'ACCOUNT_BANNED'});return {bound,phone:bound?'+86 *******1234':null,has_email:!!email};},
  emailSend:async value=>{calls.push(['emailSend',value]);return {ok:true};},
  send:async(...args)=>{calls.push(['send',...args]);return {success:true,challenge_id:'challenge-a',expires_in:300,retry_after:2};},
  phoneProof:async(...args)=>{calls.push(['phoneProof',...args]);return {reauth_token:'opaque-proof',expires_in:300};},
  authorizeDelete:async proof=>{calls.push(['authorizeDelete',proof]);return {ok:true,deletion_job_id:'job-a',deletion_token:'opaque-delete-token',expires_in:600};}};
 w.SunlandPhoneAuth={createClient:()=>client,text:s=>s,errorText:e=>e.code||'安全错误',normalizePhone(value){const p=String(value).replace(/^\+86/,'');if(!/^1[3-9]\d{9}$/.test(p))throw Object.assign(Error(),{code:'INVALID_REQUEST'});return p;},cooldown:()=>0};
 w.fetch=async(_url,init)=>{const data=JSON.parse(init.body);calls.push(['edge',data,init.headers]);return Response.json(data.action==='authorize'?{deletion_job_id:'email-job',deletion_token:'email-token',expires_in:600}:{ok:true,user_id:'user-a'});};
 w.eval(source);w.initAccountDelete();await flush();
 const click=async id=>{w.document.getElementById(id).click();await flush();};const input=(id,value)=>{const e=w.document.getElementById(id);assert.ok(e,id);e.value=value;e.dispatchEvent(new w.Event('input',{bubbles:true}));};
 const start=async()=>{await click('openAccountDeleteBtn');await click('accountDeleteContinueBtn');};
 return {dom,w,client,calls,click,input,start};
}
test('phone-only user authorizes using current phone and enters the original confirmation and execute flow',async t=>{
 const f=await fixture();t.after(()=>f.dom.window.close());await f.start();
 assert.ok(f.w.document.getElementById('accountDeletePhoneInput'));f.input('accountDeletePhoneInput','13800001234');await f.click('accountDeleteSendBtn');f.input('accountDeleteCodeInput','123456');await f.click('accountDeleteVerifyBtn');
 assert.deepEqual(f.calls.slice(0,3),[['send','13800001234','reauth'],['phoneProof','13800001234','challenge-a','123456','delete'],['authorizeDelete','opaque-proof']]);
 assert.ok(f.w.document.getElementById('accountDeleteConfirmInput'));assert.equal(f.w.document.getElementById('accountDeleteFinalBtn').disabled,true);
 f.input('accountDeleteConfirmInput','删除我的账号');await f.click('accountDeleteFinalBtn');
 const execute=f.calls.find(c=>c[0]==='edge');assert.deepEqual(execute[1],{action:'execute',deletion_job_id:'job-a',deletion_token:'opaque-delete-token',confirmation:'删除我的账号'});assert.equal(f.w.localStorage.getItem('token'),null);assert.equal(f.w.localStorage.getItem('lang'),'ja');
});
test('email-only flow uses authoritative server email and preserves existing Edge authorize shape',async t=>{
 const f=await fixture({email:'owner@example.test',bound:false});t.after(()=>f.dom.window.close());await f.start();assert.equal(f.w.document.getElementById('accountDeleteEmailInput').value,'owner@example.test');await f.click('accountDeleteSendBtn');f.input('accountDeleteCodeInput','123456');await f.click('accountDeleteVerifyBtn');
 assert.equal(f.calls[0][1],'owner@example.test');assert.deepEqual(f.calls.find(c=>c[0]==='edge')[1],{action:'authorize',email:'owner@example.test',code:'123456'});
});
test('dual-factor user can select current phone without modifying the email flow',async t=>{
 const f=await fixture({email:'owner@example.test'});t.after(()=>f.dom.window.close());await f.start();await f.click('accountDeletePhoneMode');assert.equal(f.w.document.getElementById('accountDeletePhoneInput').value,'');assert.equal(f.w.document.getElementById('accountDeleteEmailInput').value,'owner@example.test');
 f.input('accountDeletePhoneInput','13800001234');await f.click('accountDeleteSendBtn');assert.equal(f.calls[0][2],'reauth');
});
test('banned active phone-only owner can reauthenticate for deletion without protected refresh/status',async t=>{
 const f=await fixture({banned:true});t.after(()=>f.dom.window.close());await f.start();f.input('accountDeletePhoneInput','13800001234');await f.click('accountDeleteSendBtn');f.input('accountDeleteCodeInput','123456');await f.click('accountDeleteVerifyBtn');assert.ok(f.w.document.getElementById('accountDeleteConfirmInput'));
});
test('invalid code and missing current-phone challenge cannot create deletion authorization',async t=>{
 const f=await fixture();t.after(()=>f.dom.window.close());await f.start();f.input('accountDeletePhoneInput','13800001234');f.input('accountDeleteCodeInput','123456');await f.click('accountDeleteVerifyBtn');assert.equal(f.calls.length,0);assert.ok(!f.w.document.getElementById('accountDeleteConfirmInput'));
});
test('closing during a pending phone proof discards its late authorization result',async t=>{
 const f=await fixture();t.after(()=>f.dom.window.close());await f.start();f.input('accountDeletePhoneInput','13800001234');await f.click('accountDeleteSendBtn');let finish;f.client.phoneProof=()=>new Promise(r=>finish=r);f.input('accountDeleteCodeInput','123456');await f.click('accountDeleteVerifyBtn');await f.click('accountDeleteCloseBtn');finish({reauth_token:'late-proof',expires_in:300});await flush();assert.equal(f.calls.some(c=>c[0]==='authorizeDelete'),false);assert.equal(f.w.document.querySelector('dialog').open,false);
});
test('account switch while execute is pending cannot clear the new session or render old success',async t=>{
 const f=await fixture();t.after(()=>f.dom.window.close());await f.start();f.input('accountDeletePhoneInput','13800001234');await f.click('accountDeleteSendBtn');f.input('accountDeleteCodeInput','123456');await f.click('accountDeleteVerifyBtn');let finish;f.w.fetch=()=>new Promise(r=>finish=r);f.input('accountDeleteConfirmInput','删除我的账号');await f.click('accountDeleteFinalBtn');f.w.localStorage.setItem('token','session-b');f.w.localStorage.setItem('user','{"id":"user-b"}');f.w.dispatchEvent(new f.w.StorageEvent('storage',{key:'token'}));finish(Response.json({ok:true,user_id:'user-a'}));await flush();assert.equal(f.w.localStorage.getItem('token'),'session-b');assert.equal(JSON.parse(f.w.localStorage.getItem('user')).id,'user-b');assert.ok(!f.w.document.getElementById('accountDeleteResultMessage')?.textContent.includes('账号已删除'));
});
test('retiring identities cannot enter OTP authorization, cached user data is ignored',async t=>{
 const f=await fixture();t.after(()=>f.dom.window.close());f.client.deletionIdentity=async()=>{throw Object.assign(Error(),{code:'ACCOUNT_NOT_ACTIVE'});};await f.start();assert.equal(f.calls.length,0);assert.ok(!f.w.document.getElementById('accountDeletePhoneInput'));
});

test('expired phone challenge and replay responses require another verification without authorizing deletion',async t=>{
 const f=await fixture();t.after(()=>f.dom.window.close());await f.start();f.client.send=async()=>({challenge_id:'expired',expires_in:0,retry_after:0});f.input('accountDeletePhoneInput','13800001234');await f.click('accountDeleteSendBtn');f.input('accountDeleteCodeInput','123456');await f.click('accountDeleteVerifyBtn');assert.equal(f.calls.length,0);assert.match(f.w.document.getElementById('accountDeleteOtpStatus').textContent,/CHALLENGE_EXPIRED/);
 f.client.send=async()=>({challenge_id:'fresh',expires_in:300,retry_after:0});await f.click('accountDeleteSendBtn');f.client.phoneProof=async()=>{throw Object.assign(Error('SECRET 13800001234 123456'),{code:'CHALLENGE_USED'});};f.input('accountDeleteCodeInput','123456');await f.click('accountDeleteVerifyBtn');assert.match(f.w.document.getElementById('accountDeleteOtpStatus').textContent,/CHALLENGE_USED/);assert.equal(f.w.document.getElementById('accountDeleteCodeInput').value,'');assert.ok(!f.w.document.body.textContent.includes('SECRET'));
});
test('duplicate send and verify clicks issue only one pending operation and persist no phone or OTP',async t=>{
 const f=await fixture();t.after(()=>f.dom.window.close());await f.start();f.input('accountDeletePhoneInput','13800001234');let sent,proof;
 f.client.send=()=>{f.calls.push(['send-once']);return new Promise(r=>sent=r);};await f.click('accountDeleteSendBtn');await f.click('accountDeleteSendBtn');assert.equal(f.calls.length,1);sent({challenge_id:'challenge-a',expires_in:300,retry_after:0});await flush();f.client.phoneProof=()=>{f.calls.push(['proof-once']);return new Promise(r=>proof=r);};f.input('accountDeleteCodeInput','123456');await f.click('accountDeleteVerifyBtn');await f.click('accountDeleteVerifyBtn');assert.equal(f.calls.filter(c=>c[0]==='proof-once').length,1);proof({reauth_token:'opaque-proof'});await flush();assert.ok(f.w.document.getElementById('accountDeleteConfirmInput'));const persisted=JSON.stringify({...f.w.localStorage,...f.w.sessionStorage});assert.ok(!/13800001234|123456|opaque-proof|opaque-delete-token/.test(persisted));
});
test('deletion authorization expiry returns to verification rather than allowing an expired retry',async t=>{
 const f=await fixture();t.after(()=>f.dom.window.close());await f.start();f.input('accountDeletePhoneInput','13800001234');await f.click('accountDeleteSendBtn');f.input('accountDeleteCodeInput','123456');await f.click('accountDeleteVerifyBtn');const now=f.w.Date.now();f.w.Date.now=()=>now+601000;f.input('accountDeleteConfirmInput','删除我的账号');await f.click('accountDeleteFinalBtn');assert.equal(f.calls.some(c=>c[0]==='edge'),false);assert.ok(f.w.document.getElementById('accountDeleteCodeInput'));assert.ok(!f.w.document.getElementById('accountDeleteRetryBtn'));
});
test('existing delete job is reused on a failed execute and does not repeat OTP authorization',async t=>{
 const f=await fixture({email:'owner@example.test',bound:false});t.after(()=>f.dom.window.close());await f.start();f.input('accountDeleteCodeInput','123456');await f.click('accountDeleteVerifyBtn');const payloads=[];f.w.fetch=async(_url,init)=>{payloads.push(JSON.parse(init.body));return payloads.length===1?Response.json({error:'SECRET'}, {status:503}):Response.json({ok:true,user_id:'user-a'});};f.input('accountDeleteConfirmInput','删除我的账号');await f.click('accountDeleteFinalBtn');assert.ok(!f.w.document.body.textContent.includes('SECRET'));await f.click('accountDeleteRetryBtn');assert.equal(payloads.length,2);assert.deepEqual(payloads[0],payloads[1]);assert.equal(f.calls.filter(c=>c[0]==='edge').length,1);
});
test('account switch during asynchronous diagnostics cleanup preserves the new account session',async t=>{
 const f=await fixture();t.after(()=>f.dom.window.close());let finish;const cleanup=f.w.clearAccountLocalStorage('user-a',{clearDiagnostics:()=>new Promise(r=>finish=r),expectedToken:'session-a'});f.w.localStorage.setItem('token','session-b');f.w.localStorage.setItem('user','{"id":"user-b"}');finish();await assert.rejects(cleanup,e=>e.code==='SESSION_CHANGED');assert.equal(f.w.localStorage.getItem('token'),'session-b');assert.equal(JSON.parse(f.w.localStorage.getItem('user')).id,'user-b');
});
test('closing pending email authorization and switching accounts during identity fetch ignore late responses',async t=>{
 const f=await fixture({email:'owner@example.test'});t.after(()=>f.dom.window.close());await f.start();let finish;f.w.fetch=()=>new Promise(r=>finish=r);f.input('accountDeleteCodeInput','123456');await f.click('accountDeleteVerifyBtn');await f.click('accountDeleteCloseBtn');finish(Response.json({deletion_job_id:'email-job',deletion_token:'secret'}));await flush();assert.ok(!f.w.document.getElementById('accountDeleteConfirmInput'));
 let identity;f.client.deletionIdentity=()=>new Promise(r=>identity=r);await f.start();f.w.localStorage.setItem('token','session-b');identity({user_id:'user-a',email:'owner@example.test',identity_status:'active',is_banned:false});await flush();assert.ok(!f.w.document.getElementById('accountDeleteCodeInput'));assert.equal(f.w.localStorage.getItem('token'),'session-b');
});

const phoneSource=await readFile(new URL('../p/js/phone-auth.js',import.meta.url),'utf8');
function apiHarness(response){
 const dom=new JSDOM('',{url:'https://sunland.dev',runScripts:'outside-only'}),w=dom.window;w.AbortController=AbortController;w.eval(phoneSource);const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64url');let token='e30.'+encode({id:'user-a'})+'.signature';const calls=[];
 const client=w.SunlandPhoneAuth.createClient({getToken:()=>token,fetchImpl:async(url,init)=>{calls.push({url,init,body:JSON.parse(init.body)});return Response.json(response);}});return {dom,w,client,calls,setToken:v=>token=v};
}
const validProof='A'.repeat(43),validAuthorization={ok:true,deletion_job_id:'76ded2a7-dc8d-4cc1-a338-c914c3292530',deletion_token:validProof,expires_in:600};
test('shared client preserves identity and deletion authorization request contracts',async t=>{
 const h=apiHarness({user_id:'user-a',email:null,identity_status:'active',is_banned:true});t.after(()=>h.dom.window.close());assert.equal((await h.client.deletionIdentity()).is_banned,true);assert.equal(h.calls[0].url,'https://api.sunland.dev/v1/account-delete/identity');assert.deepEqual(h.calls[0].body,{});assert.equal(h.calls[0].init.method,'POST');assert.equal(h.calls[0].init.credentials,'omit');assert.match(h.calls[0].init.headers.Authorization,/^Bearer /);
 const a=apiHarness(validAuthorization);t.after(()=>a.dom.window.close());await a.client.authorizeDelete(validProof);assert.equal(a.calls[0].url,'https://api.sunland.dev/v1/phone/delete-authorize');assert.equal(a.calls[0].body.reauth_token,validProof);assert.match(a.calls[0].body.operation_id,/^[a-f0-9-]{36}$/);assert.deepEqual(Object.keys(a.calls[0].body).sort(),['operation_id','reauth_token']);
});
test('shared client rejects cross-account, retiring and malformed identity responses',async t=>{
 for(const response of [{user_id:'other',email:null,identity_status:'active',is_banned:false},{user_id:'user-a',email:null,identity_status:'deleted',is_banned:false},{user_id:'user-a',email:{private:'secret'},identity_status:'active',is_banned:false}]){const h=apiHarness(response);t.after(()=>h.dom.window.close());await assert.rejects(h.client.deletionIdentity(),e=>e.code==='UNAUTHORIZED');}
});
test('shared client rejects invalid delete proof locally and malformed grants remotely',async t=>{
 const h=apiHarness(validAuthorization);t.after(()=>h.dom.window.close());await assert.rejects(h.client.authorizeDelete('invalid'),e=>e.code==='INVALID_REQUEST');assert.equal(h.calls.length,0);
 for(const response of [{...validAuthorization,expires_in:0},{...validAuthorization,deletion_token:'bad'},{...validAuthorization,deletion_job_id:'user-a'}]){const a=apiHarness(response);t.after(()=>a.dom.window.close());await assert.rejects(a.client.authorizeDelete(validProof),e=>e.code==='SERVICE_UNAVAILABLE');}
});
