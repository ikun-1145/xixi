import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
const html=readFileSync(new URL('../login.html',import.meta.url),'utf8');
const client=readFileSync(new URL('../p/js/phone-auth.js',import.meta.url),'utf8');
function harness({phoneEnabled=true,phoneModule='present',unified=false,url='https://sunland.dev/login.html'}={}){
 const dom=new JSDOM(html,{url,runScripts:'outside-only'});const w=dom.window;const calls=[];let phoneClients=0;
 if(phoneEnabled!==null)w.document.querySelector('meta[name="sunland-phone-ui-enabled"]').content=String(phoneEnabled);
 w.document.querySelector('meta[name="sunland-unified-auth-enabled"]').content=String(unified);
 w.AbortController=AbortController;w.crypto.randomUUID=crypto.randomUUID.bind(crypto);w.alert=()=>{};
 w.initGeetest4=(_opts,callback)=>callback({onReady(fn){fn();},onError(){},onSuccess(fn){w.__emailCaptchaSuccess=fn;},getValidate(){return {mock:true};},showCaptcha(){},appendTo(){}});
 w.fetch=async(url,init)=>{const body=JSON.parse(init.body);calls.push({url,body});return Response.json(url.endsWith('send-code')?{success:true,challenge_id:body.challenge_id,expires_in:300,retry_after:600}:{token:'mock-jwt',user:{id:'same-account',email:null},onboarding:{version:0,step:1},is_new_user:true});};
 w.SunlandLoginBanStatus={check:async()=>({isBanned:false})};
 if(phoneModule!=='missing'){w.eval(client);const real=w.SunlandPhoneAuth;w.SunlandPhoneAuth={...real,createClient:opts=>{
  phoneClients++;if(phoneModule==='broken')throw Error('synthetic');
  return phoneModule==='incomplete'?{}:real.createClient({...opts,captcha:async()=>'mock'});
 }};}
 for(const script of [...w.document.querySelectorAll('script:not([src])')])w.eval(script.textContent);
 return{dom,w,calls,phoneClients};
}
const flush=()=>new Promise(r=>setTimeout(r,0));
for(const phoneModule of ['missing','broken','incomplete'])test(`email login stays usable when phone module is ${phoneModule}`,async t=>{
 const h=harness({phoneEnabled:true,phoneModule}),d=h.w.document;t.after(()=>h.dom.window.close());
 assert.equal(d.querySelector('#phoneLoginTab').closest('.phone-tabs').hidden,true);
 assert.equal(typeof d.querySelector('#sendCodeBtn').onclick,'function');
 assert.equal(typeof d.querySelector('#loginBtn').onclick,'function');
 d.querySelector('#emailInput').value='user@example.test';d.querySelector('#sendCodeBtn').click();await flush();
 assert.equal(typeof h.w.__emailCaptchaSuccess,'function');
 h.w.__emailCaptchaSuccess();await flush();await flush();
 assert.equal(h.calls.length,1);assert.ok(h.calls[0].url.endsWith('/send-code'));
});
test('phone mode sends contract request, duplicate clicks suppressed, shared login persists same token/user format',async()=>{
 const h=harness(),d=h.w.document;
 assert.ok(d.querySelector('#phoneLoginTab'));d.querySelector('#phoneLoginTab').click();
 d.querySelector('#phoneInput').value='13800000000';d.querySelector('#sendPhoneCodeBtn').click();d.querySelector('#sendPhoneCodeBtn').click();await flush();
 assert.equal(h.calls.length,1);assert.equal(h.calls[0].body.purpose,'login');assert.equal(d.querySelector('#sendPhoneCodeBtn').disabled,true);
 assert.equal(d.querySelector('#loginMsg').textContent,'验证码请求已受理，请留意短信（有效期约5分钟）');
 d.querySelector('#phoneCodeInput').value='123456';d.querySelector('#agreeCheck').checked=true;d.querySelector('#agreeCheck').dispatchEvent(new h.w.Event('change'));
 d.querySelector('#loginBtn').click();await flush();await flush();assert.equal(h.w.localStorage.getItem('token'),'mock-jwt');assert.equal(JSON.parse(h.w.localStorage.getItem('user')).id,'same-account');
 assert.ok(!JSON.stringify({...h.w.localStorage}).includes('13800000000'));h.dom.window.close();
});
test('mode switch clears phone and code without persisting temporary state',async()=>{
 const h=harness(),d=h.w.document;assert.ok(d.querySelector('#phoneLoginTab'));d.querySelector('#phoneLoginTab').click();d.querySelector('#phoneInput').value='13800000000';d.querySelector('#phoneCodeInput').value='123456';d.querySelector('#emailLoginTab').click();assert.equal(d.querySelector('#phoneInput').value,'');assert.equal(d.querySelector('#phoneCodeInput').value,'');assert.equal(d.querySelector('#emailInput').hidden,false);h.dom.window.close();
});

test('phone verification retains recovery when account status cannot be confirmed',async t=>{
 const h=harness(),d=h.w.document;t.after(()=>h.dom.window.close());
 h.w.SunlandLoginBanStatus.check=async()=>{throw new Error('synthetic failure');};
 d.querySelector('#phoneLoginTab').click();d.querySelector('#phoneInput').value='13800000000';d.querySelector('#sendPhoneCodeBtn').click();await flush();
 d.querySelector('#phoneCodeInput').value='123456';d.querySelector('#agreeCheck').checked=true;d.querySelector('#agreeCheck').dispatchEvent(new h.w.Event('change'));d.querySelector('#loginBtn').click();await flush();await flush();
 assert.equal(h.w.localStorage.getItem('token'),null);assert.ok(h.w.sessionStorage.getItem('sunland.phone.pending.v1'));assert.equal(d.querySelector('#sendPhoneCodeBtn').disabled,true);
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
 const labels=['中国大陆手机号','短信验证码','手机号注册','注册邮箱','邮箱验证码','注册需同时验证手机号和邮箱，已有账号不会合并','使用已注册手机号登录','验证码请求已受理，请留意短信和邮箱','请使用发送验证码时填写的邮箱','验证未完成，请检查登录状态后再操作','手机号登录','邮箱登录','请输入6位验证码'];
 for(const lang of ['en','ja','ko','es','zh-Hant']){
  for(const source of [...errors,...labels]){
   const translated=h.w.SiteI18n.translate(source,lang);
   if(['发送状态未知，请勿重复发送；收到验证码后可尝试验证，未必能通过','验证结果未知，请先检查登录状态，勿重复发送短信','发送仍在处理中，请稍后再验证'].includes(source)) continue;
   assert.ok(translated && (lang === 'zh-Hant' || translated !== source),`${lang}: missing ${source}`);
  }
 }
 h.w.SiteI18n.setLanguage('en',{persist:false});h.w.document.querySelector('#phoneLoginTab').click();
 assert.equal(h.w.document.querySelector('label[for="phoneInput"]').textContent,'Mainland China mobile number');
 assert.equal(h.w.document.querySelector('#loginBtn').textContent,'Sign in');
 assert.match(h.w.document.querySelector('.subtitle').textContent,/registered phone/i);
 assert.notEqual(h.w.SunlandPhoneAuth.errorText({code:'CODE_INVALID'}),'验证码错误或已过期，请重新获取');
});

test('deployed default ignores legacy phone selection and keeps the email flow and return target',async t=>{
 const url='https://sunland.dev/login?return=copilot.html&mode=phone&sunland-phone-ui-enabled=true#register';
 for(let load=0;load<2;load++){
  const {dom,w,calls,phoneClients}=harness({phoneEnabled:null,unified:true,url});t.after(()=>dom.window.close());
  const doc=w.document;
  w.history.replaceState({loginMode:'phone'},'');
  w.dispatchEvent(new w.PageTransitionEvent('pageshow',{persisted:true}));
  for(const id of ['phoneLoginTab','phoneRegisterTab','sendPhoneCodeBtn'])doc.getElementById(id).click();
  assert.equal(phoneClients,0);
  assert.equal(doc.querySelector('.phone-tabs').hidden,true);
  assert.equal(doc.querySelector('#phoneLoginFields').hidden,true);
  assert.equal(doc.querySelector('#unifiedIdentityField').hidden,true);
  assert.equal(doc.querySelector('#emailLoginField').hidden,false);
  assert.equal(doc.querySelector('#emailCodeField').hidden,false);
  assert.equal(w.getPostLoginTarget(),'copilot.html');
  assert.equal(calls.length,0);
  doc.querySelector('#emailInput').value='fixture@example.test';
  doc.querySelector('#sendCodeBtn').click();await flush();
  w.__emailCaptchaSuccess();await flush();
  doc.querySelector('#codeInput').value='123456';
  doc.querySelector('#agreeCheck').click();
  doc.querySelector('#loginBtn').click();await flush();await flush();
  assert.deepEqual(calls.map(({url})=>new URL(url).pathname),['/send-code','/verify-code']);
  assert.equal(w.localStorage.getItem('token'),'mock-jwt');
 }
});

test('unified authentication switched off falls back to the three-tab entry', t=>{
 const h=harness();t.after(()=>h.dom.window.close());const d=h.w.document;
 assert.equal(d.querySelector('meta[name="sunland-unified-auth-enabled"]').content,'false');
 assert.equal(d.querySelector('#unifiedIdentityField').hidden,true);
 assert.equal(d.querySelector('#phoneLoginTab').closest('.phone-tabs').hidden,false);
});

test('unified entry starts with only identity input and selects email without network access',async t=>{
 const h=harness({unified:true}),d=h.w.document;t.after(()=>h.dom.window.close());
 assert.equal(d.querySelector('#unifiedIdentityField').hidden,false);
 assert.equal(d.querySelector('#phoneLoginTab').closest('.phone-tabs').hidden,true);
 assert.equal(d.querySelector('#emailLoginField').hidden,true);
 assert.equal(d.querySelector('#phoneLoginFields').hidden,true);
 d.querySelector('#unifiedIdentity').value='USER@example.test';
 d.querySelector('#agreeCheck').checked=true;d.querySelector('#agreeCheck').dispatchEvent(new h.w.Event('change'));
 d.querySelector('#loginBtn').click();await flush();
 assert.equal(d.querySelector('#emailCodeField').hidden,false);
 assert.equal(d.querySelector('#emailInput').value.toLowerCase(),'user@example.test');
 assert.equal(h.calls.length,0);
});

test('unified entry selects phone and rejects malformed identity without sending SMS',async t=>{
 const h=harness({unified:true}),d=h.w.document;t.after(()=>h.dom.window.close());
 d.querySelector('#agreeCheck').checked=true;d.querySelector('#agreeCheck').dispatchEvent(new h.w.Event('change'));
 const identity=d.querySelector('#unifiedIdentity');identity.value='not-a-valid-identity';
 d.querySelector('#loginBtn').click();await flush();assert.equal(h.calls.length,0);assert.equal(d.querySelector('#phoneLoginFields').hidden,true);
 identity.value='13800000000';d.querySelector('#loginBtn').click();await flush();
 assert.equal(d.querySelector('#phoneLoginFields').hidden,false);
 assert.equal(h.w.SunlandPhoneAuth.normalizePhone(d.querySelector('#phoneInput').value),'13800000000');
 assert.equal(h.calls.length,0);
});

async function startUnifiedPhone(h, t) {
 const d=h.w.document;t.after(()=>h.dom.window.close());
 d.querySelector('#unifiedIdentity').value='13800000000';d.querySelector('#loginBtn').click();await flush();
 d.querySelector('#sendPhoneCodeBtn').click();await flush();await flush();
 d.querySelector('#agreeCheck').checked=true;d.querySelector('#agreeCheck').dispatchEvent(new h.w.Event('change'));
 d.querySelector('#phoneCodeInput').value='123456';return d;
}

test('unified existing phone verifies once and keeps its established account',async t=>{
 const h=harness({unified:true});
 h.w.fetch=async(url,init)=>{const body=JSON.parse(init.body);h.calls.push({url,body});
  if(url.endsWith('/send-code'))return Response.json({success:true,challenge_id:body.challenge_id,expires_in:300,retry_after:600});
  assert.ok(url.endsWith('/unified/verify'));return Response.json({status:'authenticated',token:'mock-jwt',user:{id:'existing-account'}});
 };
 const d=await startUnifiedPhone(h,t);d.querySelector('#loginBtn').click();d.querySelector('#loginBtn').click();await flush();await flush();
 assert.equal(h.calls.filter(c=>c.url.endsWith('/send-code')).length,1);
 assert.equal(h.calls.filter(c=>c.url.endsWith('/unified/verify')).length,1);
 assert.equal(JSON.parse(h.w.localStorage.getItem('user')).id,'existing-account');
});

test('unified new phone requires verified email and reuses the original SMS proof',async t=>{
 const h=harness({unified:true});h.w.fetch=async(url,init)=>{const body=JSON.parse(init.body);h.calls.push({url,body});
  if(url.endsWith('/send-code'))return Response.json({success:true,challenge_id:body.challenge_id,expires_in:300,retry_after:600});
  if(url.endsWith('/unified/verify'))return Response.json({status:'registration_required',expires_in:300});
  if(url.endsWith('/unified/email/send'))return Response.json({success:true});
  if(url.endsWith('/unified/register'))return Response.json({status:'authenticated',token:'new-jwt',user:{id:'new-account'}});
  throw Error('unexpected endpoint');
 };
 const d=await startUnifiedPhone(h,t);d.querySelector('#loginBtn').click();await flush();await flush();
 assert.equal(d.querySelector('#phoneRegisterEmailField').hidden,false);
 d.querySelector('#loginBtn').click();await flush();assert.equal(h.calls.filter(c=>c.url.endsWith('/unified/register')).length,0);
 d.querySelector('#phoneRegisterEmail').value='new@example.test';d.querySelector('#unifiedEmailSendBtn').click();await flush();await flush();
 d.querySelector('#phoneEmailCode').value='654321';d.querySelector('#loginBtn').click();await flush();await flush();
 const verify=h.calls.find(c=>c.url.endsWith('/unified/verify')).body;
 const email=h.calls.find(c=>c.url.endsWith('/unified/email/send')).body;
 const register=h.calls.find(c=>c.url.endsWith('/unified/register')).body;
 assert.equal(h.calls.filter(c=>c.url.endsWith('/send-code')).length,1);
 assert.equal(email.proof,verify.proof);assert.equal(register.proof,verify.proof);
 assert.equal(email.operation_id,verify.operation_id);assert.equal(register.operation_id,verify.operation_id);
 assert.equal(register.email_code,'654321');assert.equal(JSON.parse(h.w.localStorage.getItem('user')).id,'new-account');
});

test('unified new phone can register directly without email when the server offers it',async t=>{
 const h=harness({unified:true});h.w.fetch=async(url,init)=>{const body=JSON.parse(init.body);h.calls.push({url,body});
  if(url.endsWith('/send-code'))return Response.json({success:true,challenge_id:body.challenge_id,expires_in:300,retry_after:600});
  if(url.endsWith('/unified/verify'))return Response.json({status:'registration_required',expires_in:300,phone_only:true});
  if(url.endsWith('/unified/register-phone'))return Response.json({status:'authenticated',token:'new-jwt',user:{id:'phone-account',email:null},is_new_user:true});
  throw Error('unexpected endpoint');
 };
 const d=await startUnifiedPhone(h,t);d.querySelector('#loginBtn').click();await flush();await flush();
 assert.equal(d.querySelector('#loginBtn').textContent,'直接注册');
 assert.match(d.querySelector('#phoneRegisterEmailField label').textContent,/可选/);
 // A typed but unverified email is never silently dropped.
 d.querySelector('#phoneRegisterEmail').value='new@example.test';d.querySelector('#loginBtn').click();await flush();
 assert.equal(h.calls.filter(c=>c.url.endsWith('/unified/register-phone')).length,0);
 d.querySelector('#phoneRegisterEmail').value='';d.querySelector('#loginBtn').click();await flush();await flush();
 const verify=h.calls.find(c=>c.url.endsWith('/unified/verify')).body;
 const register=h.calls.find(c=>c.url.endsWith('/unified/register-phone')).body;
 assert.deepEqual(Object.keys(register).sort(),['challenge_id','operation_id','phone','proof']);
 assert.equal(register.proof,verify.proof);assert.equal(register.operation_id,verify.operation_id);
 assert.equal(h.calls.filter(c=>c.url.endsWith('/send-code')).length,1);
 const user=JSON.parse(h.w.localStorage.getItem('user'));
 assert.equal(user.id,'phone-account');assert.equal(user.email??null,null);
});

test('unified registration keeps requiring email when the server does not offer phone-only',async t=>{
 const h=harness({unified:true});h.w.fetch=async(url,init)=>{const body=JSON.parse(init.body);h.calls.push({url,body});
  if(url.endsWith('/send-code'))return Response.json({success:true,challenge_id:body.challenge_id,expires_in:300,retry_after:600});
  if(url.endsWith('/unified/verify'))return Response.json({status:'registration_required',expires_in:300,phone_only:false});
  throw Error('unexpected endpoint');
 };
 const d=await startUnifiedPhone(h,t);d.querySelector('#loginBtn').click();await flush();await flush();
 assert.equal(d.querySelector('#loginBtn').textContent,'完成注册');
 d.querySelector('#loginBtn').click();await flush();
 assert.equal(h.calls.filter(c=>/unified\/register/.test(c.url)).length,0);
});

for(const email of ['existing@example.test','new@example.test'])test(`unified email flow preserves existing endpoint behavior for ${email}`,async t=>{
 const h=harness({unified:true}),d=h.w.document;t.after(()=>h.dom.window.close());
 h.w.fetch=async(url,init)=>{const body=JSON.parse(init.body);h.calls.push({url,body});
  if(url.endsWith('/send-code'))return Response.json({success:true});
  if(url.endsWith('/verify-code'))return Response.json({token:'email-jwt',user:{id:'email-account',email}});
  throw Error('unexpected endpoint');
 };
 d.querySelector('#unifiedIdentity').value=email;d.querySelector('#loginBtn').click();await flush();
 d.querySelector('#sendCodeBtn').click();await flush();assert.equal(typeof h.w.__emailCaptchaSuccess,'function');
 h.w.__emailCaptchaSuccess();await flush();await flush();
 d.querySelector('#codeInput').value='123456';d.querySelector('#agreeCheck').checked=true;d.querySelector('#agreeCheck').dispatchEvent(new h.w.Event('change'));
 d.querySelector('#loginBtn').click();await flush();await flush();
 assert.equal(h.calls.filter(c=>c.url.endsWith('/send-code')).length,1);
 assert.equal(h.calls.filter(c=>c.url.endsWith('/verify-code')).length,1);
 assert.equal(JSON.parse(h.w.localStorage.getItem('user')).id,'email-account');
});

test('unified registration conflict never creates a session or retries SMS',async t=>{
 const h=harness({unified:true});h.w.fetch=async(url,init)=>{const body=JSON.parse(init.body);h.calls.push({url,body});
  if(url.endsWith('/send-code'))return Response.json({success:true,challenge_id:body.challenge_id,expires_in:300,retry_after:600});
  if(url.endsWith('/unified/verify'))return Response.json({status:'registration_required',expires_in:300});
  if(url.endsWith('/unified/email/send'))return Response.json({success:true});
  if(url.endsWith('/unified/register'))return Response.json({code:'EMAIL_CONFLICT'},{status:409});
  throw Error('unexpected endpoint');
 };
 const d=await startUnifiedPhone(h,t);d.querySelector('#loginBtn').click();await flush();await flush();
 d.querySelector('#phoneRegisterEmail').value='existing@example.test';d.querySelector('#unifiedEmailSendBtn').click();await flush();await flush();
 d.querySelector('#phoneEmailCode').value='654321';d.querySelector('#loginBtn').click();await flush();await flush();
 assert.equal(h.w.localStorage.getItem('token'),null);assert.match(d.querySelector('#loginMsg').textContent,/邮箱已注册/);
 assert.equal(h.calls.filter(c=>c.url.endsWith('/send-code')).length,1);
});

test('unified expired SMS challenge cannot be submitted or resent automatically',async t=>{
 const h=harness({unified:true});const d=await startUnifiedPhone(h,t);
 h.w.Date.now=()=>Date.now()+301000;d.querySelector('#loginBtn').click();await flush();
 assert.equal(h.calls.filter(c=>c.url.endsWith('/unified/verify')).length,0);
 assert.equal(h.calls.filter(c=>c.url.endsWith('/send-code')).length,1);
});

test('unified verification with unknown result never retries automatically and manual retry reuses the proof',async t=>{
 const h=harness({unified:true});let lost=true;h.w.fetch=async(url,init)=>{const body=JSON.parse(init.body);h.calls.push({url,body});
  if(url.endsWith('/send-code'))return Response.json({success:true,challenge_id:body.challenge_id,expires_in:300,retry_after:600});
  if(lost){lost=false;throw Error('response lost');}
  return Response.json({status:'authenticated',token:'recovered-jwt',user:{id:'existing-account'}});
 };
 const d=await startUnifiedPhone(h,t);d.querySelector('#loginBtn').click();await flush();await flush();
 assert.equal(h.calls.filter(c=>c.url.endsWith('/unified/verify')).length,1);assert.equal(h.w.localStorage.getItem('token'),null);
 d.querySelector('#sendPhoneCodeBtn').click();await flush();
 assert.equal(h.calls.filter(c=>c.url.endsWith('/send-code')).length,1);
 d.querySelector('#loginBtn').click();await flush();await flush();
 const verifications=h.calls.filter(c=>c.url.endsWith('/unified/verify'));
 assert.equal(verifications.length,2);assert.equal(verifications[0].body.proof,verifications[1].body.proof);
 assert.equal(verifications[0].body.operation_id,verifications[1].body.operation_id);
 assert.equal(h.w.localStorage.getItem('token'),'recovered-jwt');
});

test('unified lost registration response is retried with the same proof, operation and email code',async t=>{
 const h=harness({unified:true});let lost=true;h.w.fetch=async(url,init)=>{const body=JSON.parse(init.body);h.calls.push({url,body});
  if(url.endsWith('/send-code'))return Response.json({success:true,challenge_id:body.challenge_id,expires_in:300,retry_after:600});
  if(url.endsWith('/unified/verify'))return Response.json({status:'registration_required',expires_in:300});
  if(url.endsWith('/unified/email/send'))return Response.json({success:true});
  if(url.endsWith('/unified/register')){if(lost){lost=false;throw Error('response lost');}return Response.json({status:'authenticated',token:'new-jwt',user:{id:'new-account'}});}
  throw Error('unexpected endpoint');
 };
 const d=await startUnifiedPhone(h,t);d.querySelector('#loginBtn').click();await flush();await flush();
 d.querySelector('#phoneRegisterEmail').value='new@example.test';d.querySelector('#unifiedEmailSendBtn').click();await flush();await flush();
 assert.equal(d.querySelector('#unifiedEmailSendBtn').disabled,true);
 d.querySelector('#phoneEmailCode').value='654321';d.querySelector('#loginBtn').click();await flush();await flush();
 assert.equal(h.w.localStorage.getItem('token'),null);
 d.querySelector('#loginBtn').click();await flush();await flush();
 const regs=h.calls.filter(c=>c.url.endsWith('/unified/register')).map(c=>c.body);
 assert.equal(regs.length,2);assert.deepEqual(regs[0],regs[1]);
 assert.equal(h.calls.filter(c=>c.url.endsWith('/unified/email/send')).length,1);
 assert.equal(h.w.localStorage.getItem('token'),'new-jwt');
});

test('unified copy is translated through the shared catalog',async t=>{
 const h=harness({unified:true});t.after(()=>h.dom.window.close());
 const catalog=readFileSync(new URL('../p/js/site-i18n-extra.js',import.meta.url),'utf8');
 for(const key of ['欢迎使用 Sunland AI','邮箱或手机号','下一步','完成注册','发送邮箱验证码','该邮箱已注册，请使用原邮箱账号登录'])assert.ok(catalog.includes(`"${key}":`),key);
});

test('unified invalid code can be corrected without sending another SMS',async t=>{
 const h=harness({unified:true});let attempts=0;
 h.w.fetch=async(url,init)=>{const body=JSON.parse(init.body);h.calls.push({url,body});
  if(url.endsWith('/send-code'))return Response.json({success:true,challenge_id:body.challenge_id,expires_in:300,retry_after:600});
  if(url.endsWith('/unified/verify'))return ++attempts===1?Response.json({code:'CODE_INVALID'},{status:400}):Response.json({status:'authenticated',token:'retry-jwt',user:{id:'same-account'}});
  throw Error('unexpected endpoint');
 };
 const d=await startUnifiedPhone(h,t);d.querySelector('#loginBtn').click();await flush();await flush();
 d.querySelector('#phoneCodeInput').value='654321';d.querySelector('#loginBtn').click();await flush();await flush();
 const verifications=h.calls.filter(c=>c.url.endsWith('/unified/verify'));
 assert.equal(verifications.length,2);assert.equal(verifications[0].body.proof,verifications[1].body.proof);
 assert.equal(verifications[0].body.operation_id,verifications[1].body.operation_id);
 assert.equal(h.calls.filter(c=>c.url.endsWith('/send-code')).length,1);
 assert.equal(h.w.localStorage.getItem('token'),'retry-jwt');
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

test('registration requires both codes and uses one operation id for both requests',async t=>{
 const h=harness(),d=h.w.document;t.after(()=>h.dom.window.close());
 d.querySelector('#phoneRegisterTab').click();d.querySelector('#phoneInput').value='13800000000';d.querySelector('#phoneRegisterEmail').value='NEW@example.test';
 d.querySelector('#sendPhoneCodeBtn').click();await flush();assert.equal(h.calls.length,1);
 const sent=h.calls[0].body;assert.equal(sent.purpose,'login');assert.equal(sent.email,'new@example.test');assert.match(sent.operation_id,/^[0-9a-f-]{36}$/);
 d.querySelector('#phoneCodeInput').value='123456';d.querySelector('#agreeCheck').checked=true;d.querySelector('#agreeCheck').dispatchEvent(new h.w.Event('change'));d.querySelector('#loginBtn').click();await flush();assert.equal(h.calls.length,1);
 d.querySelector('#phoneEmailCode').value='654321';d.querySelector('#loginBtn').click();await flush();await flush();
 assert.equal(h.calls.length,2);assert.equal(h.calls[1].body.operation_id,sent.operation_id);assert.equal(h.calls[1].body.challenge_id,sent.challenge_id);assert.equal(h.calls[1].body.email,sent.email);assert.equal(h.calls[1].body.email_code,'654321');
 assert.equal(h.w.localStorage.getItem('token'),'mock-jwt');
});
test('registration failure consumes the attempt and reload recovery never submits twice',async t=>{
 const h=harness(),d=h.w.document;t.after(()=>h.dom.window.close());let attempts=0;
 h.w.fetch=async(url,init)=>{const body=JSON.parse(init.body);h.calls.push({url,body});if(url.endsWith('/send-code'))return Response.json({success:true,challenge_id:body.challenge_id,expires_in:300,retry_after:60});attempts++;return Response.json({code:'CODE_INVALID'},{status:400});};
 d.querySelector('#phoneRegisterTab').click();d.querySelector('#phoneInput').value='13800000000';d.querySelector('#phoneRegisterEmail').value='new@example.test';d.querySelector('#sendPhoneCodeBtn').click();await flush();
 d.querySelector('#phoneCodeInput').value='123456';d.querySelector('#phoneEmailCode').value='654321';d.querySelector('#agreeCheck').checked=true;d.querySelector('#agreeCheck').dispatchEvent(new h.w.Event('change'));d.querySelector('#loginBtn').click();await flush();
 const saved=JSON.parse(h.w.sessionStorage.getItem('sunland.phone.pending.v1'));assert.equal(saved.verificationStarted,true);assert.equal(attempts,1);
 d.querySelector('#phoneInput').dispatchEvent(new h.w.Event('input'));d.querySelector('#phoneCodeInput').value='123456';d.querySelector('#phoneEmailCode').value='654321';d.querySelector('#loginBtn').click();await flush();assert.equal(attempts,1);
});
test('registration send failure keeps recovery and never sends again automatically',async t=>{
 const h=harness(),d=h.w.document;t.after(()=>h.dom.window.close());let calls=0;h.w.fetch=async()=>{calls++;throw Error('lost');};
 d.querySelector('#phoneRegisterTab').click();d.querySelector('#phoneInput').value='13800000000';d.querySelector('#phoneRegisterEmail').value='new@example.test';d.querySelector('#sendPhoneCodeBtn').click();await flush();
 assert.equal(calls,1);assert.equal(d.querySelector('#sendPhoneCodeBtn').disabled,true);assert.ok(JSON.parse(h.w.sessionStorage.getItem('sunland.phone.pending.v1')).operationId);assert.match(d.querySelector('#loginMsg').textContent,/未知/);
});

test('unified phone identity accepts common pasted separators',async t=>{
 const h=harness({unified:true}),d=h.w.document;t.after(()=>h.dom.window.close());
 for(const value of [' 138 0000 0000 ','138-0000-0000','+86 138 0000 0000']){
  d.querySelector('#unifiedIdentity').value=value;d.querySelector('#loginBtn').click();await flush();
  assert.equal(d.querySelector('#phoneLoginFields').hidden,false,value);
  assert.equal(d.querySelector('#phoneInput').value,'13800000000');
  d.querySelector('#unifiedBack').click();
 }
 assert.equal(h.calls.length,0);
});

test('unified return to the same phone recovers the sent SMS challenge instead of locking the step',async t=>{
 const h=harness({unified:true});
 h.w.fetch=async(url,init)=>{const body=JSON.parse(init.body);h.calls.push({url,body});
  if(url.endsWith('/send-code'))return Response.json({success:true,challenge_id:body.challenge_id,expires_in:300,retry_after:60});
  return Response.json({status:'authenticated',token:'mock-jwt',user:{id:'existing-account'}});
 };
 const d=await startUnifiedPhone(h,t);const sent=h.calls[0].body.challenge_id;
 d.querySelector('#unifiedBack').click();
 d.querySelector('#unifiedIdentity').value='13800000000';d.querySelector('#loginBtn').click();await flush();
 assert.equal(d.querySelector('#sendPhoneCodeBtn').disabled,true);
 d.querySelector('#agreeCheck').checked=true;d.querySelector('#agreeCheck').dispatchEvent(new h.w.Event('change'));
 d.querySelector('#phoneCodeInput').value='123456';d.querySelector('#loginBtn').click();await flush();await flush();
 const verify=h.calls.filter(c=>c.url.endsWith('/unified/verify'));
 assert.equal(verify.length,1);assert.equal(verify[0].body.challenge_id,sent);
 assert.equal(h.calls.filter(c=>c.url.endsWith('/send-code')).length,1);
});

test('unified copy follows later site language changes',async t=>{
 const h=harness({unified:true}),d=h.w.document;t.after(()=>h.dom.window.close());
 const en={'邮箱或手机号':'Email or phone number','请输入验证码继续':'Enter the code to continue','返回修改':'Back','登录':'Sign in'};
 d.querySelector('#unifiedIdentity').value='13800000000';d.querySelector('#loginBtn').click();await flush();
 h.w.SiteI18n={translate:s=>en[s]||s};h.w.dispatchEvent(new h.w.CustomEvent('site-language-change'));
 assert.equal(d.querySelector('#unifiedIdentityField label').textContent,'Email or phone number');
 assert.equal(d.querySelector('.subtitle').textContent,'Enter the code to continue');
 assert.equal(d.querySelector('#unifiedBack').title,'Back');
 h.w.SiteI18n={translate:s=>s};h.w.dispatchEvent(new h.w.CustomEvent('site-language-change'));
 assert.equal(d.querySelector('.subtitle').textContent,'请输入验证码继续');
 assert.equal(d.querySelector('#unifiedBack').textContent,'‹ 13800000000');
});

test('pasted verification codes keep only six digits',t=>{
 const h=harness({unified:true}),d=h.w.document;t.after(()=>h.dom.window.close());
 for(const id of ['#codeInput','#phoneCodeInput','#phoneEmailCode']){
  const input=d.querySelector(id);input.value='验证码：123 456，5分钟内有效';input.dispatchEvent(new h.w.Event('input'));
  assert.equal(input.value,'123456',id);
 }
});
