(function (global) {
  'use strict';
  const API = 'https://api.sunland.dev';
  const cool = new Map();
  const messages = {
    REGISTRATION_DISABLED:'暂未开放手机号新用户注册', CANARY_LIMITED:'本次短信验收额度已用完', CANARY_DENIED:'当前号码不在短信验收范围', RELEASE_CONFIG:'手机号发布配置暂不可用',
    INVALID_REQUEST:'请检查手机号和6位验证码', BUSY:'正在处理…', SESSION_CHANGED:'登录状态已变化，请重新进行安全验证',
    UNAUTHORIZED:'登录已失效，请重新登录', ACCOUNT_NOT_ACTIVE:'账号正在注销或已注销，无法登录', ACCOUNT_BANNED:'当前账号无法登录',
    SMS_DISABLED:'手机号认证暂未启用', IDENTITY_DISABLED:'手机号认证暂未启用', CAPTCHA_FAILED:'人机验证未完成，请重试',
    REAUTH_INVALID:'安全验证已失效，请重新验证', REAUTH_REQUIRED:'请先完成安全验证', PHONE_CONFLICT:'该手机号暂时无法绑定，请使用其他号码',
    PHONE_ALREADY_BOUND:'请刷新手机号状态后重试', PHONE_NOT_BOUND:'请刷新手机号状态后重试',
    ALTERNATIVE_LOGIN_REQUIRED:'请先验证其他可用登录方式', OPERATION_CONFLICT:'操作状态已变化，请刷新后重新验证',
    CHALLENGE_INVALID:'验证码错误或已过期，请重新获取', CHALLENGE_EXPIRED:'验证码已过期，请重新获取',
    CHALLENGE_USED:'验证码已使用，请重新获取', CODE_INVALID:'验证码错误或已过期，请重新获取',
    RATE_LIMITED:'请求过于频繁，请稍后再试', PROVIDER_RATE_LIMITED:'请求过于频繁，请稍后再试',
    BUDGET_EXCEEDED:'短信服务暂时不可用，请稍后再试', TIMEOUT:'请求超时，请重新获取验证码或刷新状态',
    NETWORK:'网络连接失败，请检查网络后重试', SERVICE_UNAVAILABLE:'认证服务暂时不可用，请稍后再试',
  };
  const text = source => global.SiteI18n?.translate?.(source) || source;
  const errorText = error => text(messages[error?.code] || messages.SERVICE_UNAVAILABLE);
  function failure(code) { const error = new Error(messages[code] || messages.SERVICE_UNAVAILABLE); error.code = code; return error; }
  function normalizePhone(value) {
    const local = typeof value === 'string' ? value.trim().replace(/^\+86/, '') : '';
    if (!/^1[3-9]\d{9}$/.test(local)) throw failure('INVALID_REQUEST');
    return local;
  }
  function rememberCooldown(phone, seconds) {
    const key=normalizePhone(phone);
    if (Number.isInteger(seconds) && seconds>=0 && seconds<=600) cool.set(key, Math.max(cool.get(key)||0,Date.now()+seconds*1000));
  }
  function cooldown(phone) { try { return Math.max(0,Math.ceil(((cool.get(normalizePhone(phone))||0)-Date.now())/1000)); } catch { return 0; } }
  let turnstileLoading, geetestLoading;
  function loadScript(src, ready, kind) {
    if (ready()) return Promise.resolve();
    if (kind === 'turnstile' && turnstileLoading) return turnstileLoading;
    if (kind === 'geetest' && geetestLoading) return geetestLoading;
    const promise=new Promise((resolve,reject)=>{
      const script=global.document.createElement('script'); const timer=global.setTimeout(()=>done(false),12000);
      function done(ok) {global.clearTimeout(timer);script.onload=script.onerror=null;if(ok && ready())resolve();else{script.remove();reject(failure('CAPTCHA_FAILED'));}}
      script.src=src;script.async=true;script.onload=()=>done(true);script.onerror=()=>done(false);global.document.head.appendChild(script);
    });
    if(kind==='turnstile')turnstileLoading=promise;else geetestLoading=promise;
    promise.catch(()=>{if(kind==='turnstile')turnstileLoading=null;else geetestLoading=null;});
    return promise;
  }
  async function runTurnstile(action,{signal}={}) {
    const sitekey=global.document.querySelector('meta[name="sunland-turnstile-sitekey"]')?.content?.trim();
    if (!sitekey) throw failure('SMS_DISABLED');
    await loadScript('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',()=>typeof global.turnstile?.render==='function','turnstile');
    if(signal?.aborted)throw failure('SESSION_CHANGED');
    const host=global.document.createElement('div');host.className='phone-captcha';host.setAttribute('role','dialog');host.setAttribute('aria-label',text('安全验证'));host.setAttribute('aria-modal','true');
    const target=global.document.createElement('div'),close=global.document.createElement('button');close.type='button';close.textContent=text('取消');host.append(target,close);(global.document.querySelector('dialog[open]') || global.document.body).appendChild(host);
    const focus=global.document.activeElement;let widget;
    try{return await new Promise((resolve,reject)=>{
      const timer=global.setTimeout(()=>finish('CAPTCHA_FAILED'),120000);
      function abort(){finish('SESSION_CHANGED');}
      function finish(code,token){global.clearTimeout(timer);signal?.removeEventListener('abort',abort);if(code)reject(failure(code));else resolve(token);}
      signal?.addEventListener('abort',abort,{once:true});close.onclick=()=>finish('CAPTCHA_FAILED');close.focus();
      try{widget=global.turnstile.render(target,{sitekey,action,theme:'auto',size:'flexible','response-field':false,
        callback:token=>typeof token==='string'&&token.length>0&&token.length<=2048?finish(null,token):finish('CAPTCHA_FAILED'),
        'error-callback':()=>finish('CAPTCHA_FAILED'),'expired-callback':()=>finish('CAPTCHA_FAILED'),'timeout-callback':()=>finish('CAPTCHA_FAILED')});}
      catch{finish('CAPTCHA_FAILED');}
    });}finally{try{if(widget!==undefined)global.turnstile.remove(widget);}catch{}host.remove();focus?.focus?.();}
  }
  async function runEmailCaptcha({signal}={}) {
    await loadScript('https://static.geetest.com/v4/gt4.js',()=>typeof global.initGeetest4==='function','geetest');
    if(signal?.aborted)throw failure('SESSION_CHANGED');
    let widget, settled=false;
    try{return await new Promise((resolve,reject)=>{
      const timer=global.setTimeout(()=>finish('CAPTCHA_FAILED'),120000);
      function abort(){finish('SESSION_CHANGED');}
      function finish(code,value){if(settled)return;settled=true;global.clearTimeout(timer);signal?.removeEventListener('abort',abort);code?reject(failure(code)):resolve(value);}
      signal?.addEventListener('abort',abort,{once:true});
      try{global.initGeetest4({captchaId:'ad3a8126afe716ccd4541f35d428071e',product:'bind'},obj=>{
        if(settled||signal?.aborted){obj.destroy?.();return;}
        widget=obj;obj.onSuccess(()=>finish(null,JSON.stringify(obj.getValidate())));obj.onError(()=>finish('CAPTCHA_FAILED'));obj.onClose?.(()=>finish('CAPTCHA_FAILED'));obj.onReady(()=>{if(!settled&&!signal?.aborted)obj.showCaptcha();});
      });}catch{finish('CAPTCHA_FAILED');}
    });}finally{widget?.destroy?.();}
  }
  function decode(token) {try {let p=String(token).split('.')[1].replace(/-/g,'+').replace(/_/g,'/');return JSON.parse(global.atob(p.padEnd(Math.ceil(p.length/4)*4,'=')));}catch{return null;}}
  function createClient({getToken=()=>global.localStorage.getItem('token'),fetchImpl=(...args)=>global.fetch(...args),timeoutMs=12000,captcha=runTurnstile,emailCaptcha=runEmailCaptcha}={}) {
    let epoch=0, sending=false;const controllers=new Set();
    const capture=()=>({token:getToken(),epoch});
    const current=s=>s.epoch===epoch&&s.token===getToken();
    const assert=s=>{if(!current(s))throw failure('SESSION_CHANGED');};
    function cancel(){epoch++;for(const controller of controllers)controller.abort();controllers.clear();}
    async function request(path,input,{auth=true,snapshot=capture()}={}) {
      assert(snapshot);if(auth&&!snapshot.token)throw failure('UNAUTHORIZED');
      const controller=new global.AbortController();controllers.add(controller);let timer;
      try {
        const result=await Promise.race([(async()=>{
          const res=await fetchImpl(API+path,{method:'POST',credentials:'omit',redirect:'error',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+snapshot.token}:{})},body:JSON.stringify(input),signal:controller.signal});
          const data=await res.json();assert(snapshot);
          if(!res.ok){const code=Object.hasOwn(messages,data?.code)?data.code:res.status===401?'UNAUTHORIZED':'SERVICE_UNAVAILABLE';throw failure(code);}
          if(!data||typeof data!=='object'||Array.isArray(data))throw failure('SERVICE_UNAVAILABLE');
          return data;
        })(),new Promise((_,reject)=>{timer=global.setTimeout(()=>{controller.abort();reject(failure('TIMEOUT'));},timeoutMs);})]);
        assert(snapshot);return result;
      }catch(error){assert(snapshot);if(error?.code&&Object.hasOwn(messages,error.code))throw error;throw failure('NETWORK');}
      finally{global.clearTimeout(timer);controllers.delete(controller);}
    }
    async function send(phone,purpose,reauth_token) {
      phone=normalizePhone(phone);if(!['login','bind','change','reauth'].includes(purpose))throw failure('INVALID_REQUEST');
      if(sending)throw failure('BUSY');if(cooldown(phone)>0)throw failure('RATE_LIMITED');sending=true;
      const snapshot=capture(),controller=new global.AbortController();controllers.add(controller);
      try{
        const turnstile_token=await captcha('phone_'+purpose,{signal:controller.signal});assert(snapshot);
        if(typeof turnstile_token!=='string'||!turnstile_token.length||turnstile_token.length>2048)throw failure('CAPTCHA_FAILED');
        const r=await request('/v1/phone/send-code',{phone,purpose,turnstile_token,...(reauth_token?{reauth_token}:{})},{auth:purpose!=='login',snapshot});
        if(r.success!==true||typeof r.challenge_id!=='string'||!Number.isInteger(r.retry_after)||r.retry_after<0||r.retry_after>600||!Number.isInteger(r.expires_in)||r.expires_in<0||r.expires_in>300)throw failure('SERVICE_UNAVAILABLE');
        rememberCooldown(phone,r.retry_after);return r;
      }finally{sending=false;controllers.delete(controller);}
    }
    return {capture,current,cancel,send,
      async status(){const r=await request('/v1/phone/status',{});
        if(typeof r.bound!=='boolean'||typeof r.has_email!=='boolean'||
          (r.bound ? typeof r.phone!=='string'||!/^\+86 \*{7}\d{4}$/.test(r.phone) : r.phone!==null))throw failure('SERVICE_UNAVAILABLE');
        return r;},
      async refreshSession(){const snapshot=capture();const before=decode(snapshot.token);const r=await request('/refresh',{}, {snapshot});assert(snapshot);
        if(!r.user?.id||r.user.id!==(before?.id||before?.sub)||decode(r.token)?.id!==r.user.id)throw failure('UNAUTHORIZED');
        global.localStorage.setItem('token',r.token);
        let old={};try{old=JSON.parse(global.localStorage.getItem('user')||'{}');}catch{}
        global.localStorage.setItem('user',JSON.stringify({...((old?.id===r.user.id)?old:{}),...r.user}));
        cancel();global.SunlandDatabaseToken?.clear?.();global.dispatchEvent(new global.CustomEvent('phone-auth-session-refresh'));return r.user;},
      async deletionIdentity(){const r=await request('/v1/account-delete/identity',{});
        const userId=decode(getToken())?.id || decode(getToken())?.sub;
        if(typeof r.user_id!=='string'||r.user_id!==userId||r.identity_status!=='active'||typeof r.is_banned!=='boolean'||
          !(r.email===null||r.email===undefined||typeof r.email==='string'))throw failure('UNAUTHORIZED');
        return r;},
      async authorizeDelete(reauth_token){if(typeof reauth_token!=='string'||!/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(reauth_token))throw failure('INVALID_REQUEST');const r=await request('/v1/phone/delete-authorize',{reauth_token,operation_id:global.crypto.randomUUID()});
        if(r.ok!==true||typeof r.deletion_job_id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(r.deletion_job_id)||
          typeof r.deletion_token!=='string'||!/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(r.deletion_token)||r.expires_in!==600)throw failure('SERVICE_UNAVAILABLE');
        return r;},
      login:(phone,challenge_id,code)=>request('/v1/phone/verify-code',{phone:normalizePhone(phone),challenge_id,code,operation_id:global.crypto.randomUUID()},{auth:false}),
      async emailSend(email){if(typeof email!=='string'||!/^\S+@\S+\.\S+$/.test(email))throw failure('INVALID_REQUEST');
        const snapshot=capture(),controller=new global.AbortController();controllers.add(controller);
        try{const token=await emailCaptcha({signal:controller.signal});assert(snapshot);return await request('/send-code',{email,token},{auth:false,snapshot});}finally{controllers.delete(controller);}},
      emailProof:(code,action)=>request('/v1/phone/reauth/email',{code,action}),
      phoneProof:(phone,challenge_id,code,action)=>request('/v1/phone/reauth/phone',{phone:normalizePhone(phone),challenge_id,code,action}),
      mutate:(action,data)=>{if(!['bind','change','unbind'].includes(action))return Promise.reject(failure('INVALID_REQUEST'));return request('/v1/phone/'+action,{...data,...(data.phone?{phone:normalizePhone(data.phone)}:{}),operation_id:global.crypto.randomUUID()});},
    };
  }
  global.SunlandPhoneAuth=Object.freeze({createClient,normalizePhone,text,errorText,cooldown,rememberCooldown,runTurnstile,runEmailCaptcha});
})(window);
