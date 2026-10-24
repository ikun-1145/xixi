// Local Edge/Playwright acceptance. Every non-local browser request is intercepted.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
const root=resolve(fileURLToPath(new URL('../',import.meta.url)));
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.SUNLAND_PLAYWRIGHT_MODULE || resolve(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const evidence=resolve(root,process.env.PHONE_BROWSER_EVIDENCE_DIR || 'docs/full-stack-development/requirements/mainland-phone-auth/phase-3a-evidence');await mkdir(evidence,{recursive:true});
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.svg':'image/svg+xml'};
const server=createServer(async(req,res)=>{try{const pathname=decodeURIComponent(new URL(req.url,'http://local').pathname);const path=resolve(root,'.'+pathname);if(!path.startsWith(root+sep)&&path!==root)throw Error();const bytes=await readFile(path);res.writeHead(200,{'Content-Type':types[extname(path)]||'application/octet-stream','Cache-Control':'no-store'});res.end(bytes);}catch{res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
const jwt=claims=>Buffer.from(JSON.stringify({alg:'mock'})).toString('base64url')+'.'+Buffer.from(JSON.stringify({iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600,...claims})).toString('base64url')+'.mock';
const uid='00000000-0000-4000-8000-000000003001',email='browser@example.invalid';
const app=jwt({id:uid,email}),db=jwt({id:uid,sub:uid,role:'authenticated',aud:'authenticated'});
const reports=[];let checks=0,activePage=null,activeState=null;
const browser=await chromium.launch({executablePath:process.env.PHONE_TEST_BROWSER || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',headless:true,args:['--disable-background-networking','--disable-component-update','--disable-sync']});
async function scenario(name,fn){if(process.env.PHONE_BROWSER_MATCH&&!name.includes(process.env.PHONE_BROWSER_MATCH))return;try{await fn();}catch(error){if(activePage&&!activePage.isClosed()){console.error('Mock browser failure',await activePage.locator('[data-phone=feedback]').allTextContents(),activeState?.requests.map(r=>r.path));await activePage.screenshot({path:resolve(evidence,'failure.png'),fullPage:true});}throw error;}checks++;reports.push({name,passed:true});console.log(`ok ${checks} - ${name}`);}
async function fixture({language='zh',dark=false,width=390,settings=false,bound=false,hasEmail=true}={}){
 const context=await browser.newContext({viewport:{width,height:900},colorScheme:dark?'dark':'light',serviceWorkers:'block'});
 const state={bound,hasEmail,codeError:null,sendError:null,delaySend:false,sendCount:0,requests:[],isNew:false};
 await context.addInitScript(({language,dark,settings,app,uid,email})=>{
  localStorage.setItem('lang',language);localStorage.setItem('theme',dark?'dark':'light');
  if(settings){localStorage.setItem('token',app);localStorage.setItem('user',JSON.stringify({id:uid,email}));}
  window.initGeetest4=(_opts,callback)=>{let success;callback({onReady(fn){queueMicrotask(fn);},onError(){},onClose(){},onSuccess(fn){success=fn;},showCaptcha(){queueMicrotask(()=>success?.());},getValidate(){return {lot_number:'mock',captcha_output:'mock',pass_token:'mock',gen_time:'mock'};},appendTo(){},destroy(){}});};
  window.turnstile={render(_target,options){queueMicrotask(()=>options.callback('mock-turnstile'));return 'mock-widget';},remove(){}};
 },{language,dark,settings,app,uid,email});
 await context.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());if(url.origin===base){if(['/login.html','/ai_settings.html'].includes(url.pathname)){const response=await route.fetch();const body=(await response.text()).replace('name="sunland-phone-ui-enabled" content="false"','name="sunland-phone-ui-enabled" content="true"');return route.fulfill({response,body});}return route.continue();}
  const headers={'Content-Type':'application/json','Access-Control-Allow-Origin':base,'Access-Control-Allow-Headers':'Content-Type,Authorization','Access-Control-Allow-Methods':'POST,GET,OPTIONS'};
  const reply=(data,status=200)=>route.fulfill({status,headers,body:JSON.stringify(data)});
  if(req.method()==='OPTIONS')return reply({});
  if(url.hostname==='api.sunland.dev'){
   let body={};try{body=req.postDataJSON()||{};}catch{}state.requests.push({path:url.pathname,body});
   if(url.pathname==='/refresh')return reply({token:app,user:{id:uid,email:hasEmail?email:null}});
   if(url.pathname==='/v1/database-token')return reply({token:db,expiresIn:900});
   if(url.pathname==='/v1/usage')return reply({userId:uid,date:new Date(Date.now()+8*3600000).toISOString().slice(0,10),isPro:true,remain:-1,used:0});
   if(url.pathname==='/send-code')return reply({ok:true});
   if(url.pathname==='/verify-code')return reply({token:app,user:{id:uid,email},onboarding:{version:1,step:3},is_new_user:false});
   if(url.pathname==='/v1/phone/status')return reply({bound:state.bound,phone:state.bound?'+86 *******1234':null,has_email:state.hasEmail});
   if(url.pathname==='/v1/phone/send-code'){
    state.sendCount++;if(state.delaySend)await new Promise(r=>setTimeout(r,200));
    if(state.sendError==='NETWORK')return route.abort('internetdisconnected');
    if(state.sendError)return reply({success:false,code:state.sendError,error:'do not show raw diagnostics'},429);
    return reply({success:true,challenge_id:'ca1adf89-213c-4ee8-98df-8766b7735b90',expires_in:300,retry_after:2});
   }
   if(url.pathname==='/v1/phone/verify-code'){
    if(state.codeError)return reply({success:false,code:state.codeError,error:'do not show raw diagnostics'},400);
    return reply({token:app,user:{id:uid,email:hasEmail?email:null},onboarding:{version:state.isNew?0:1,step:state.isNew?1:3},is_new_user:state.isNew});
   }
   if(url.pathname.startsWith('/v1/phone/reauth/'))return reply({reauth_token:Buffer.alloc(32,1).toString('base64url'),expires_in:300});
   if(['/v1/phone/bind','/v1/phone/change','/v1/phone/unbind'].includes(url.pathname)){state.bound=!url.pathname.endsWith('/unbind');return reply({ok:true});}
   return reply({ok:true});
  }
  if(url.hostname.endsWith('supabase.co')){
   if(url.pathname.includes('/user_profiles'))return reply([{user_id:uid,email,pro:true,is_banned:false,ban_reason:null,name:'Mock Pro User',avatar_url:'',avatar_path:'',identity_status:'active'}]);
   if(url.pathname.includes('/app_config'))return reply([{maintenance_enabled:false}]);
   return reply([]);
  }
  if(req.resourceType()==='script')return route.fulfill({status:200,contentType:'text/javascript',body:''});
  return route.abort('blockedbyclient');
 });
 const page=await context.newPage();await page.clock.install();activePage=page;activeState=state;const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(base+(settings?'/ai_settings.html':'/login.html?return=ai_settings.html'));
 await page.waitForFunction(()=>window.SiteI18n&&window.SunlandPhoneAuth);
 await page.evaluate(({dark})=>{document.body.classList.toggle('night',dark);document.body.classList.toggle('dark',dark);document.querySelector('meta[name="sunland-turnstile-sitekey"]')?.setAttribute('content','mock-public-sitekey');},{dark});
 return {context,page,state,errors};
}
try{
 for(const language of ['zh','en','ja'])for(const width of [390,1280])for(const dark of [false,true])await scenario(`login ${language} ${width} ${dark?'dark':'light'}`,async()=>{
  const f=await fixture({language,width,dark});try{await f.page.locator('#phoneLoginTab').click();assert.equal(await f.page.locator('#phoneInput').isVisible(),true);assert.equal(await f.page.locator('#emailInput').isVisible(),false);
   assert.match(await f.page.locator('#phoneLoginTab').innerText(),language==='en'?/Phone/:language==='ja'?/電話/:/手机号/);
   assert.ok((await f.page.locator('#phoneLoginTab').boundingBox()).height>=44);assert.ok(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   assert.ok(await f.page.locator('#phoneInput').evaluate(el=>el.getBoundingClientRect().width>100));
   await f.page.screenshot({path:resolve(evidence,`login-${language}-${width}-${dark?'dark':'light'}.png`),fullPage:true});assert.deepEqual(f.errors,[]);
  }finally{await f.context.close();}
 });
 for(const language of ['zh','en','ja'])await scenario(`settings ${language} real page, binding, change and unlink`,async()=>{
  const f=await fixture({language,settings:true,dark:language==='ja'});const p=f.page,s=f.state;
  try{
   const root=p.locator('body');await root.locator('[data-phone="bind"]').waitFor({state:'visible'});
   assert.match(await p.locator('#heroName').innerText(),/Mock Pro User/);
   for(const action of ['bind','change','unbind']){
    if(action!=='bind')await p.clock.fastForward(61000);
    await root.locator(`[data-phone="${action}"]`).click();await root.locator('[data-phone="dialog"][open]').waitFor();if(action==='bind')await root.locator('[data-phone="dialog"]').screenshot({path:resolve(evidence,`settings-${language}-proof-390.png`)});
    await root.locator('[data-phone="send-proof"]').click();await root.locator('[data-phone="proof-code"]').fill('123456');await root.locator('[data-phone="verify-proof"]').click();
    if(action==='unbind'){assert.equal(await root.locator('[data-phone="commit"]').isDisabled(),true);await root.locator('[data-phone="confirm"]').check();}
    else{await root.locator('[data-phone="target-phone"]').fill(action==='bind'?'13800001234':'13900001234');await Promise.all([p.waitForResponse(r=>r.url().endsWith('/v1/phone/send-code')),root.locator('[data-phone="send-target"]').click()]);await root.locator('[data-phone="target-code"]').fill('123456');}
    await root.locator('[data-phone="commit"]').click();try{await root.locator('[data-phone="dialog"]').waitFor({state:'hidden',timeout:3000});}catch(error){console.error('action',action,'feedback',await root.locator('[data-phone="feedback"]').innerText(),'paths',s.requests.map(r=>r.path));await p.screenshot({path:resolve(evidence,'failure.png'),fullPage:true});throw error;}
    await p.waitForTimeout(80);assert.equal(s.bound,action!=='unbind');
   }
   await p.screenshot({path:resolve(evidence,`settings-${language}-390.png`),fullPage:true});assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   assert.deepEqual(f.errors,[]);assert.ok(s.requests.some(r=>r.path==='/v1/database-token'));
  }finally{await f.context.close();}
 });
 await scenario('phone validation, duplicate send, server cooldown, code error/expiry, network retry, retired account',async()=>{
  const f=await fixture();const p=f.page,s=f.state;
  try{await p.locator('#phoneLoginTab').click();await p.locator('#phoneInput').fill('123');await p.locator('#sendPhoneCodeBtn').click();assert.equal(s.sendCount,0);
   await p.locator('#phoneInput').fill('13800000000');s.delaySend=true;await p.locator('#sendPhoneCodeBtn').click();await p.locator('#sendPhoneCodeBtn').dispatchEvent('click');await p.waitForTimeout(300);assert.equal(s.sendCount,1);assert.equal(await p.locator('#sendPhoneCodeBtn').isDisabled(),true);
   await p.locator('#agreeCheck').check();await p.locator('#phoneCodeInput').fill('000000');s.codeError='CODE_INVALID';await p.locator('#loginBtn').click();await p.waitForTimeout(50);assert.match(await p.locator('#loginMsg').innerText(),/错误或已过期/);
   s.codeError='CHALLENGE_EXPIRED';await p.locator('#loginBtn').click();await p.waitForTimeout(50);assert.match(await p.locator('#loginMsg').innerText(),/已过期/);
   await p.waitForTimeout(2200);s.sendError='NETWORK';await p.locator('#sendPhoneCodeBtn').click();await p.waitForTimeout(300);assert.equal(await p.locator('#sendPhoneCodeBtn').isDisabled(),false);assert.match(await p.locator('#loginMsg').innerText(),/网络连接失败/);
   s.sendError=null;await p.locator('#sendPhoneCodeBtn').click();await p.waitForTimeout(300);await p.locator('#phoneCodeInput').fill('123456');s.codeError='ACCOUNT_NOT_ACTIVE';await p.locator('#loginBtn').click();await p.waitForTimeout(50);assert.match(await p.locator('#loginMsg').innerText(),/注销/);assert.equal(await p.evaluate(()=>localStorage.getItem('token')),null);
  }finally{await f.context.close();}
 });
 await scenario('rate/budget failures, live language switch and missing/failed Turnstile stay closed',async()=>{
  const f=await fixture({language:'en'}),p=f.page,s=f.state;
  try{await p.locator('#phoneLoginTab').click();await p.locator('#phoneInput').fill('13200000000');
   for(const code of ['RATE_LIMITED','BUDGET_EXCEEDED']){s.sendError=code;await p.locator('#sendPhoneCodeBtn').click();await p.waitForTimeout(80);assert.equal(await p.locator('#sendPhoneCodeBtn').isDisabled(),false);assert.match(await p.locator('#loginMsg').innerText(),code==='RATE_LIMITED'?/frequent|many|later/i:/SMS/);}
   await p.evaluate(()=>SiteI18n.setLanguage('ja'));await p.waitForTimeout(30);assert.match(await p.locator('#loginMsg').innerText(),/SMS/);assert.equal(await p.locator('#phoneInput').inputValue(),'13200000000');
   const before=s.sendCount;await p.evaluate(()=>document.querySelector('meta[name="sunland-turnstile-sitekey"]').content='');await p.locator('#sendPhoneCodeBtn').click();await p.waitForTimeout(30);assert.equal(s.sendCount,before);
   await p.evaluate(()=>{document.querySelector('meta[name="sunland-turnstile-sitekey"]').content='mock';window.turnstile.render=(_el,opts)=>{queueMicrotask(()=>opts['error-callback']());return 'failed';};});await p.locator('#sendPhoneCodeBtn').click();await p.waitForTimeout(30);assert.equal(s.sendCount,before);
  }finally{await f.context.close();}
 });
 for(const method of ['phone','email'])await scenario(`${method} login shares storage and loads existing Pro/profile via safe return`,async()=>{
  const f=await fixture();const p=f.page;
  try{if(method==='phone'){f.state.isNew=true;await p.locator('#phoneLoginTab').click();await p.locator('#phoneInput').fill('13500000000');await p.locator('#sendPhoneCodeBtn').click();await p.waitForTimeout(70);await p.locator('#phoneCodeInput').fill('123456');}
   else{await p.locator('#emailInput').fill(email);await p.locator('#sendCodeBtn').click();await p.waitForTimeout(70);await p.locator('#codeInput').fill('123456');}
   await p.locator('#agreeCheck').check();await p.locator('#loginBtn').click();await p.waitForURL('**/ai_settings.html');await p.waitForFunction(()=>document.querySelector('#heroName')?.textContent==='Mock Pro User');
   const persisted=await p.evaluate(()=>({token:localStorage.getItem('token'),user:JSON.parse(localStorage.getItem('user'))}));assert.equal(persisted.token,app);assert.equal(persisted.user.id,uid);assert.ok(f.state.requests.some(r=>r.path==='/v1/database-token'));
   await p.waitForFunction(()=>window.SunlandProPayment.getState().state==='PRO');assert.equal(await p.evaluate(()=>window.SunlandProPayment.getState().state),'PRO');
  }finally{await f.context.close();}
 });
 await scenario('phone-only account cannot unlink its only login method',async()=>{
  const f=await fixture({settings:true,bound:true,hasEmail:false});try{await f.page.locator('#phoneSettings [data-phone="unbind"]').waitFor({state:'visible'});assert.equal(await f.page.locator('#phoneSettings [data-phone="unbind"]').isDisabled(),true);assert.ok(!(await f.page.locator('#phoneSettings [data-phone="summary"]').innerText()).includes('13800001234'));}finally{await f.context.close();}
 });
 console.log(`Browser acceptance: ${checks}/${checks}; all external requests intercepted`);
 await writeFile(resolve(evidence,process.env.PHONE_BROWSER_MATCH?'browser-results-focused.json':'browser-results.json'),JSON.stringify({date:new Date().toISOString(),browser:await browser.version(),checks,passed:checks,externalRequests:'Mocked or blocked; no real SMS',results:reports},null,2)+'\n');
}finally{await browser.close();await new Promise(r=>server.close(r));}
