(function (global) {
  'use strict';

  // The settings entry remains hidden until a separately reviewed rollout.
  const copy = {
    phone:['手机号','手機號碼','Phone','電話番号','전화번호','Teléfono'],
    bind:['绑定','綁定','Link','連携','연결','Vincular'],
    change:['换绑','更換','Change','変更','변경','Cambiar'],
    unbind:['解绑','解除綁定','Unlink','解除','연결 해제','Desvincular'],
    currentPhone:['当前手机号','目前手機號碼','Current phone','現在の電話番号','현재 전화번호','Teléfono actual'],
    newPhone:['新手机号','新手機號碼','New phone','新しい電話番号','새 전화번호','Nuevo teléfono'],
    code:['验证码','驗證碼','Verification code','認証コード','인증번호','Código de verificación'],
    send:['发送验证码','傳送驗證碼','Send code','コードを送信','인증번호 전송','Enviar código'],
    verify:['验证并继续','驗證並繼續','Verify and continue','認証して続行','확인 후 계속','Verificar y continuar'],
    confirm:['确认','確認','Confirm','確認','확인','Confirmar'],
    confirmUnbind:['确认解绑','確認解除綁定','Confirm unlink','解除を確認','연결 해제 확인','Confirmar desvinculación'],
    unlinkWarning:['解绑后将无法使用此号码登录。','解除綁定後將無法使用此號碼登入。','You will no longer be able to sign in with this number.','解除後はこの番号でログインできません。','연결 해제 후 이 번호로 로그인할 수 없습니다.','Ya no podrás iniciar sesión con este número.'],
    review:['检查后继续','檢查後繼續','Continue after checking','確認後に続行','확인 후 계속','Continuar tras comprobar'],
    cancel:['取消','取消','Cancel','キャンセル','취소','Cancelar'],
    notBound:['未绑定','未綁定','Not linked','未連携','연결되지 않음','Sin vincular'],
    loading:['正在检查…','正在檢查…','Checking…','確認中…','확인 중…','Comprobando…'],
    emailHint:['先验证当前账号的邮箱。','先驗證目前帳號的郵箱。','First verify this account’s email.','まずアカウントのメールを認証してください。','먼저 계정 이메일을 인증하세요.','Primero verifica el correo de esta cuenta.'],
    phoneHint:['先验证当前绑定的手机号。','先驗證目前綁定的手機號碼。','First verify the currently linked phone.','まず連携中の電話番号を認証してください。','먼저 연결된 전화번호를 인증하세요.','Primero verifica el teléfono vinculado.'],
    emailRequired:['解绑前需要验证已绑定的邮箱。','解除綁定前需要驗證已綁定的郵箱。','A linked email is required to unlink.','解除には連携済みメールの認証が必要です。','연결을 해제하려면 연결된 이메일 인증이 필요합니다.','Se necesita un correo vinculado para desvincular.'],
    codeSent:['验证码已请求，请查收。','驗證碼已要求，請查收。','Code requested. Check your messages.','コードを送信しました。','인증번호를 요청했습니다.','Código solicitado. Revisa tus mensajes.'],
    enterCode:['请输入六位验证码。','請輸入六位驗證碼。','Enter the six-digit code.','6桁のコードを入力してください。','6자리 인증번호를 입력하세요.','Introduce el código de seis dígitos.'],
    complete:['操作已完成。','操作已完成。','Done.','完了しました。','완료되었습니다.','Operación completada.'],
    uncertain:['结果未知，请先刷新并核对账号状态，避免重复操作。','結果未知，請先重新整理並核對帳號狀態，避免重複操作。','Result unknown. Refresh and check your account before repeating.','結果不明です。再操作する前に状態を確認してください。','결과를 알 수 없습니다. 다시 시도하기 전에 상태를 확인하세요.','Resultado desconocido. Comprueba tu cuenta antes de repetir.'],
    reviewConfirm:['请先核实账号状态和上次短信。确认已核实并继续？','請先核實帳號狀態和上次簡訊。確認已核實並繼續？','Check your account and previous message first. Continue?','アカウントと前回のSMSを確認しましたか？','계정과 이전 메시지를 확인했나요?','Comprueba tu cuenta y el mensaje anterior. ¿Continuar?'],
    unavailable:['暂时无法确认手机号状态。','暫時無法確認手機號碼狀態。','Phone status is unavailable.','電話番号の状態を確認できません。','전화번호 상태를 확인할 수 없습니다.','No se puede comprobar el teléfono.']
  };
  const langs=['zh-CN','zh-Hant','en','ja','ko','es'];
  const tr = key => copy[key]?.[Math.max(0,langs.indexOf(global.SiteI18n?.getLanguage?.() || 'zh-CN'))] || key;
  const operationKey='sunland.phone.mutation-uncertain.v1';
  const validCode = value => /^\d{6}$/.test(value);

  function mount() {
    const doc=global.document, root=doc.getElementById('phoneSettings');
    if (!root || doc.querySelector('meta[name="sunland-phone-settings-enabled"]')?.content !== 'true' || !global.SunlandPhoneAuth) return;
    const client=global.SunlandPhoneAuth.createClient(), el=id=>doc.getElementById('phoneSettings'+id);
    const value=el('Value'), message=el('Message'), buttons=['Bind','Change','Unbind','AuthSend','AuthNext','TargetSend','TargetConfirm','UnbindSubmit','Review','Cancel'].map(el);
    let status=null, action=null, proof=null, authChallenge=null, targetChallenge=null, authPhone='', targetPhone='', busy=false, generation=0, serial=0, uncertain=false;
    try { uncertain=global.sessionStorage.getItem(operationKey)==='1'; } catch { uncertain=true; }
    const translate=()=>{root.querySelectorAll('[data-phone-label]').forEach(n=>{n.textContent=tr(n.dataset.phoneLabel);});};
    function note(text) { message.textContent=text || ''; }
    function render() {
      translate();
      value.textContent=status ? (status.bound ? status.phone : tr('notBound')) : tr('unavailable');
      el('Bind').hidden=!status || status.bound; el('Change').hidden=!status || !status.bound; el('Unbind').hidden=!status || !status.bound;
      el('Unbind').disabled=busy||uncertain||!status?.has_email;
      el('Unbind').title=status?.has_email ? '' : tr('emailRequired');
      el('Bind').disabled=busy||uncertain||(!status?.has_email && !status?.bound);
      el('Change').disabled=busy||uncertain;
      el('Reauth').hidden=!action||Boolean(proof); el('Target').hidden=!action||!proof||action==='unbind';
      el('UnbindConfirm').hidden=action!=='unbind'||!proof;
      el('Cancel').hidden=!action; el('OldPhoneLabel').hidden=Boolean(status?.has_email);
      el('ReauthHint').textContent=tr(status?.has_email ? 'emailHint' : 'phoneHint');
      for(const b of buttons) if(b && !['phoneSettingsBind','phoneSettingsChange','phoneSettingsUnbind'].includes(b.id))
        b.disabled=busy || (uncertain && !['phoneSettingsReview','phoneSettingsCancel'].includes(b.id));
      el('OldPhone').disabled=busy||Boolean(authChallenge); el('NewPhone').disabled=busy||Boolean(targetChallenge);
      let pending=null;
      try { pending=action && client.recovery(status?.has_email ? action : (proof ? action : 'reauth')); }
      catch { uncertain=true; }
      el('Review').hidden=!uncertain && !(pending && Date.now()>=pending.review_after);
    }
    function reset() {
      generation++;client.cancel();action=null;proof=null;authChallenge=null;targetChallenge=null;authPhone='';targetPhone='';
      for(const id of ['OldPhone','NewPhone','AuthCode','NewCode'])el(id).value='';
    }
    async function run(fn, { mutation=false }={}) {
      if(busy)return;busy=true;const mark=generation, requestId=++serial, session=client.capture();render();
      try { await fn(()=>mark===generation && client.current(session)); }
      catch(error) {
        if(mark!==generation || !client.current(session))return;
        if(mutation && ['TIMEOUT','NETWORK','SERVICE_UNAVAILABLE'].includes(error?.code)) {
          uncertain=true;try{global.sessionStorage.setItem(operationKey,'1');}catch{};note(tr('uncertain'));
        } else note(global.SunlandPhoneAuth.errorText(error));
      } finally { if(requestId===serial){busy=false;render();} }
    }
    async function refresh() {
      await run(async current=>{const result=await client.status();if(!current())return;status=result;note('');});
    }
    function start(next) {
      if(busy||uncertain||!status)return;
      if(next==='unbind'&&!status.has_email){note(tr('emailRequired'));return;}
      reset();action=next;note('');render();
    }
    el('Bind').onclick=()=>start('bind');el('Change').onclick=()=>start('change');el('Unbind').onclick=()=>start('unbind');
    el('Cancel').onclick=()=>{reset();note('');render();};
    el('AuthSend').onclick=()=>run(async current=>{
      if(status.has_email) {
        await client.emailReauthSend(action);if(!current())return;
      } else {
        const phone=global.SunlandPhoneAuth.normalizePhone(el('OldPhone').value), recovery=client.recovery('reauth');
        authPhone=phone;
        try { authChallenge=recovery?.challenge_id || (await client.send(phone,'reauth')).challenge_id; }
        catch(error){if(error?.code==='SEND_UNCERTAIN')authChallenge=client.recovery('reauth')?.challenge_id || null;throw error;}
        if(!current())return;
      }
      note(tr('codeSent'));
    });
    el('AuthNext').onclick=()=>run(async current=>{
      const code=el('AuthCode').value.trim();if(!validCode(code)){note(tr('enterCode'));return;}
      let r;
      if(status.has_email) r=await client.emailProof(code,action);
      else {if(!authChallenge || !authPhone)throw Object.assign(new Error(),{code:'REAUTH_REQUIRED'});r=await client.phoneProof(authPhone,authChallenge,code,action);}
      if(!current())return;
      if(typeof r.reauth_token!=='string'||!/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(r.reauth_token))throw Object.assign(new Error(),{code:'SERVICE_UNAVAILABLE'});
      proof=r.reauth_token;authChallenge=null;el('AuthCode').value='';note('');
    });
    el('TargetSend').onclick=()=>run(async current=>{
      const phone=global.SunlandPhoneAuth.normalizePhone(el('NewPhone').value),recovery=client.recovery(action);targetPhone=phone;
      try { targetChallenge=recovery?.challenge_id || (await client.send(phone,action,proof)).challenge_id; }
      catch(error){if(error?.code==='SEND_UNCERTAIN')targetChallenge=client.recovery(action)?.challenge_id || null;throw error;}
      if(current())note(tr('codeSent'));
    });
    el('TargetConfirm').onclick=()=>run(async current=>{
      const code=el('NewCode').value.trim();if(!validCode(code)){note(tr('enterCode'));return;}
      if(!targetChallenge || !targetPhone || !proof)throw Object.assign(new Error(),{code:'REAUTH_REQUIRED'});
      const result=await client.mutate(action,{phone:targetPhone,challenge_id:targetChallenge,code,reauth_token:proof});if(!current())return;
      if(result?.ok!==true)throw Object.assign(new Error(),{code:'SERVICE_UNAVAILABLE'});
      const fresh=await client.status();if(!current())return;reset();status=fresh;note(tr('complete'));
    },{mutation:true});
    el('UnbindSubmit').onclick=()=>run(async current=>{
      if(!proof || !status?.has_email)throw Object.assign(new Error(),{code:'REAUTH_REQUIRED'});
      const result=await client.mutate('unbind',{reauth_token:proof});if(!current())return;
      if(result?.ok!==true)throw Object.assign(new Error(),{code:'SERVICE_UNAVAILABLE'});
      const fresh=await client.status();if(!current())return;reset();status=fresh;note(tr('complete'));
    },{mutation:true});
    el('Review').onclick=()=>run(async current=>{
      if(!global.confirm(tr('reviewConfirm')))return;
      const fresh=await client.status();if(!current())return;
      const purpose=status?.has_email ? action : (proof ? action : 'reauth');
      const pending=purpose && client.recovery(purpose);
      if(pending)client.acknowledgeReviewed(purpose,true);
      try{global.sessionStorage.removeItem(operationKey);}catch{throw Object.assign(new Error(),{code:'SERVICE_UNAVAILABLE'});}
      uncertain=false;reset();status=fresh;note('');
    });
    global.addEventListener('storage',event=>{if(event.key==='token'){reset();status=null;busy=false;serial++;render();void refresh();}});
    global.addEventListener('phone-auth-session-refresh',()=>{reset();status=null;busy=false;serial++;render();void refresh();});
    global.addEventListener('site-language-change',render);
    root.hidden=false;render();void refresh();
    global.setInterval(()=>{if(action && !busy)render();},1000);
  }
  global.SunlandPhoneSettings=Object.freeze({mount});
  if(global.document.readyState==='loading')global.document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
})(window);
