(function (global) {
  'use strict';
  const mounted = new WeakMap();
  function mount(root, options = {}) {
    if (!root || !global.SunlandPhoneAuth) return null;
    if (mounted.has(root)) return mounted.get(root);
    const shared = global.SunlandPhoneAuth;
    root.setAttribute('data-site-i18n-ignore', '');
    const client = options.client || shared.createClient();
    const getIdentity = options.getIdentity || (() => global.ensureSettingsIdentity?.());
    const t = source => shared.text(source);
    let generation = 0, snapshot = null, user = null, status = null, action = null;
    let busy = false, proof = null, challenge = null, proofChallenge = null, grantUntil = 0;
    let emailCooldown = 0, focusReturn = null;
    // This template contains no API or user content. All dynamic content uses textContent.
    root.innerHTML = '<div class="phone-row"><div><h3 data-label="手机号管理"></h3><p class="phone-note" data-label="绑定后可使用短信验证码登录"></p><p data-phone="summary"></p></div><div class="phone-actions"><button type="button" data-phone="bind" data-label="绑定手机号"></button><button type="button" data-phone="change" data-label="更换手机号"></button><button type="button" data-phone="unbind" data-label="解绑手机号"></button><button type="button" data-phone="reload" data-label="刷新状态"></button></div></div><p class="phone-status" data-phone="card-status" role="status" aria-live="polite"></p><dialog class="phone-auth phone-dialog" data-phone="dialog" aria-labelledby="phoneSettingsTitle"><form method="dialog" data-phone="form"><div class="phone-row"><h2 id="phoneSettingsTitle" data-phone="title"></h2><button type="button" data-phone="close" data-label="关闭"></button></div><section data-phone="proof-step"><p class="phone-note" data-label="为保护账号，请先验证现有登录方式"></p><div class="phone-tabs" role="group" aria-label="安全验证"><button type="button" data-phone="email-method" data-label="使用邮箱验证"></button><button type="button" data-phone="phone-method" data-label="使用当前手机号验证"></button></div><label data-phone="current-phone-label"><span data-label="输入当前绑定的手机号"></span><div class="phone-input-row"><span>+86</span><input data-phone="current-phone" type="tel" inputmode="tel" autocomplete="off" maxlength="14"></div></label><div class="phone-input-row"><label><span data-phone="proof-code-label"></span><input data-phone="proof-code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}"></label><button type="button" data-phone="send-proof" data-label="发送验证码"></button></div><button type="button" class="phone-primary" data-phone="verify-proof" data-label="验证并继续"></button></section><section data-phone="target-step" hidden><label><span data-phone="target-label"></span><div class="phone-input-row"><span>+86</span><input data-phone="target-phone" type="tel" inputmode="tel" autocomplete="off" maxlength="14"></div></label><div class="phone-input-row"><label><span data-label="短信验证码"></span><input data-phone="target-code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}"></label><button type="button" data-phone="send-target" data-label="发送验证码"></button></div></section><section data-phone="unbind-step" hidden><p class="phone-note" data-label="解绑后请使用邮箱登录"></p><label class="phone-confirm"><input data-phone="confirm" type="checkbox"><span data-label="我确认解绑此手机号"></span></label></section><button type="button" class="phone-primary" data-phone="commit" hidden></button><p class="phone-status" data-phone="feedback" role="status" aria-live="polite"></p><button type="button" data-phone="cancel" data-label="取消"></button></form></dialog>';
    // Cards use backdrop-filter/overflow. Keep fixed overlays in a body portal.
    const portal = global.document.createElement('div');
    portal.className = 'phone-auth'; portal.setAttribute('data-site-i18n-ignore', '');
    portal.appendChild(root.querySelector('[data-phone="dialog"]'));
    global.document.body.appendChild(portal);
    const el = name => root.querySelector(`[data-phone="${name}"]`) || portal.querySelector(`[data-phone="${name}"]`);
    const all = selector => [...root.querySelectorAll(selector), ...portal.querySelectorAll(selector)];
    function message(name, source, error) {
      const node = el(name);
      node.dataset.phoneMessage = source || '';
      if (error) node.dataset.phoneError = error.code || 'SERVICE_UNAVAILABLE';
      else delete node.dataset.phoneError;
      node.textContent = error ? shared.errorText(error) : t(source || '');
    }
    const dialog = el('dialog');
    dialog.setAttribute('aria-modal', 'true');
    const backdrop = global.document.createElement('div');
    backdrop.className = 'phone-settings-backdrop'; backdrop.hidden = true;
    backdrop.setAttribute('aria-hidden', 'true'); portal.insertBefore(backdrop, dialog);
    let method = 'email';
    function translate() {
      root.setAttribute('aria-label', t('手机号管理'));
      all('[data-label]').forEach(node => { node.textContent = t(node.dataset.label); });
      el('current-phone').setAttribute('aria-label', t('输入当前绑定的手机号'));
      el('target-phone').setAttribute('aria-label', t('中国大陆手机号'));
      el('proof-code').setAttribute('aria-label', t(method === 'email' ? '邮箱验证码' : '短信验证码'));
      el('target-code').setAttribute('aria-label', t('短信验证码'));
      portal.querySelector('[role="group"]').setAttribute('aria-label', t('安全验证'));
      el('proof-code-label').textContent = t(method === 'email' ? '邮箱验证码' : '短信验证码');
      if (action) {
        el('title').textContent = t({ bind: '绑定手机号', change: '更换手机号', unbind: '解绑手机号' }[action]);
        el('target-label').textContent = t(action === 'change' ? '请输入新的手机号' : '请输入要绑定的手机号');
        el('commit').textContent = t({ bind: '确认绑定', change: '确认更换', unbind: '确认解绑' }[action]);
      }
      all('[data-phone-message]').forEach(node => {
        node.textContent = node.dataset.phoneError ? shared.errorText({ code: node.dataset.phoneError }) : t(node.dataset.phoneMessage);
      });
      renderCard(); tick();
    }
    function renderCard() {
      el('summary').textContent = status ? (status.bound ? status.phone : t('未绑定手机号')) : '--';
      el('bind').hidden = !status || status.bound;
      el('change').hidden = !status?.bound;
      el('unbind').hidden = !status?.bound;
      el('unbind').disabled = !status?.has_email;
      el('unbind').title = status?.bound && !status.has_email ? t('当前账号没有其他登录方式，暂时无法解绑手机号') : '';
      if (status?.bound && !status.has_email) message('card-status', '当前账号没有其他登录方式，暂时无法解绑手机号');
    }
    function valid(epoch, captured) { return generation === epoch && client.current(captured); }
    async function resolveIdentity() {
      const captured = client.capture();
      // Existing page owners can finish the same verified identity concurrently.
      // Retry this read once, never a proof consumption or identity mutation.
      for (let attempt = 0; attempt < 2; attempt++) {
        const identity = await getIdentity();
        if (!client.current(captured)) throw Object.assign(new Error(), { code: 'SESSION_CHANGED' });
        if (identity?.id) return identity;
      }
      throw Object.assign(new Error(), { code: 'SERVICE_UNAVAILABLE' });
    }
    function cleanSecrets() {
      proof = null; challenge = null; proofChallenge = null; grantUntil = 0;
      for (const name of ['current-phone', 'proof-code', 'target-phone', 'target-code']) el(name).value = '';
      el('confirm').checked = false;
    }
    function close() {
      generation++; client.cancel(); cleanSecrets(); action = null; busy = false;
      if (typeof dialog.close === 'function' && dialog.open) dialog.close();
      else dialog.removeAttribute('open');
      backdrop.hidden = true;
      focusReturn?.focus(); tick();
    }
    function resetProof() {
      cleanSecrets(); el('proof-step').hidden = false; el('target-step').hidden = true;
      el('unbind-step').hidden = true; el('commit').hidden = true;
    }
    function selectMethod(value) {
      if (busy || proof) return;
      method = value; proofChallenge = null; el('proof-code').value = ''; el('current-phone').value = '';
      el('current-phone-label').hidden = method !== 'phone';
      el('email-method').setAttribute('aria-pressed', String(method === 'email'));
      el('phone-method').setAttribute('aria-pressed', String(method === 'phone'));
      translate();
    }
    function tick() {
      if (proof && Date.now() >= grantUntil) { resetProof(); message('feedback', '重新进行安全验证'); }
      const remaining = name => { try { return shared.cooldown(shared.normalizePhone(el(name).value)); } catch { return 0; } };
      const proofWait = method === 'email' ? Math.max(0, Math.ceil((emailCooldown - Date.now()) / 1000)) : remaining('current-phone');
      const targetWait = remaining('target-phone');
      for (const [name, wait] of [['send-proof', proofWait], ['send-target', targetWait]]) {
        el(name).disabled = busy || wait > 0;
        el(name).textContent = busy ? t('正在处理…') : wait > 0 ? `${wait} ${t('秒后重新发送')}` : t('发送验证码');
      }
      for (const name of ['verify-proof', 'commit', 'email-method', 'phone-method', 'current-phone', 'proof-code', 'target-phone', 'target-code']) el(name).disabled = busy;
      el('commit').disabled = busy || (action === 'unbind' && !el('confirm').checked);
      el('reload').disabled = busy;
    }
    async function load() {
      const epoch = ++generation; client.cancel(); cleanSecrets();
      status = null; renderCard();
      message('card-status', '正在读取…');
      try {
        const identity = await resolveIdentity(); if (generation !== epoch) return;
        const captured = client.capture(); const result = await client.status();
        if (!valid(epoch, captured)) return;
        user = identity; status = result; message('card-status', ''); renderCard();
      } catch (error) { if (generation === epoch) message('card-status', '', error); }
    }
    async function begin(nextAction) {
      if (busy || !status || (nextAction === 'unbind' && !status.has_email)) return;
      close(); const epoch = generation; focusReturn = el(nextAction); busy = true; tick();
      try {
        const identity = await resolveIdentity(); if (generation !== epoch) return;
        const fresh = await client.refreshSession();
        if (generation !== epoch || fresh.id !== identity.id) return;
        // Existing settings identity owner must observe the refreshed application token.
        const refreshedIdentity = await resolveIdentity(); if (generation !== epoch) return;
        if (refreshedIdentity.id !== fresh.id) throw Object.assign(new Error(), { code: 'SESSION_CHANGED' });
        snapshot = client.capture(); const currentStatus = await client.status();
        if (!valid(epoch, snapshot)) return;
        user = fresh; status = currentStatus;
        if ((nextAction === 'bind' && status.bound) || (nextAction !== 'bind' && !status.bound) || (nextAction === 'unbind' && !status.has_email)) { renderCard(); return; }
        action = nextAction; resetProof(); message('feedback', '');
        el('email-method').hidden = !status.has_email;
        el('phone-method').hidden = !status.bound || action === 'unbind';
        method = status.has_email ? 'email' : 'phone'; el('current-phone-label').hidden = method !== 'phone';
        el('email-method').setAttribute('aria-pressed', String(method === 'email'));
        el('phone-method').setAttribute('aria-pressed', String(method === 'phone'));
        translate();
        // Native modal dialogs make third-party captcha portals outside the dialog inert.
        // The local backdrop and keyboard loop preserve the flow while portals remain usable.
        backdrop.hidden = false;
        if (typeof dialog.show === 'function') dialog.show(); else dialog.setAttribute('open', '');
        (method === 'phone' ? el('current-phone') : el('send-proof')).focus();
      } catch (error) { if (generation === epoch) message('card-status', '', error); }
      finally { if (generation === epoch) { busy = false; tick(); } }
    }
    async function run(callback) {
      if (busy || !action || !client.current(snapshot)) return;
      busy = true; tick(); const epoch = generation, captured = snapshot;
      try { await callback(() => valid(epoch, captured)); }
      catch (error) {
        if (!valid(epoch, captured)) return;
        if (['UNAUTHORIZED', 'ACCOUNT_NOT_ACTIVE', 'ACCOUNT_BANNED'].includes(error.code)) {
          close(); status = null; user = null; renderCard(); message('card-status', '', error); return;
        }
        message('feedback', '', error);
        if (error.code === 'REAUTH_INVALID') { resetProof(); message('feedback', '重新进行安全验证'); }
        if (['CHALLENGE_EXPIRED', 'CHALLENGE_USED', 'CHALLENGE_INVALID'].includes(error.code)) { challenge = null; proofChallenge = null; }
        el('proof-code').value = ''; el('target-code').value = '';
      } finally { if (valid(epoch, captured)) { busy = false; tick(); } }
    }
    function code(name) {
      const value = el(name).value.trim();
      if (!/^\d{6}$/.test(value)) throw Object.assign(new Error(), { code: 'INVALID_REQUEST' });
      return value;
    }
    el('send-proof').onclick = () => run(async current => {
      if (method === 'email') {
        await client.emailSend(user.email); if (current()) emailCooldown = Date.now() + 60000;
      } else {
        const phone = shared.normalizePhone(el('current-phone').value);
        const result = await client.send(phone, 'reauth'); if (current()) proofChallenge = { phone, id: result.challenge_id };
      }
    });
    el('verify-proof').onclick = () => run(async current => {
      const value = code('proof-code'); let result;
      if (method === 'email') result = await client.emailProof(value, action);
      else {
        const phone = shared.normalizePhone(el('current-phone').value);
        if (!proofChallenge || proofChallenge.phone !== phone) throw Object.assign(new Error(), { code: 'CHALLENGE_INVALID' });
        result = await client.phoneProof(phone, proofChallenge.id, value, action);
      }
      if (!current()) return;
      proof = result.reauth_token; grantUntil = Date.now() + result.expires_in * 1000;
      el('proof-code').value = ''; el('current-phone').value = ''; proofChallenge = null;
      el('proof-step').hidden = true; el('target-step').hidden = action === 'unbind';
      el('unbind-step').hidden = action !== 'unbind'; el('commit').hidden = false;
      message('feedback', ''); (action === 'unbind' ? el('confirm') : el('target-phone')).focus();
    });
    el('send-target').onclick = () => run(async current => {
      if (!proof || Date.now() >= grantUntil) throw Object.assign(new Error(), { code: 'REAUTH_INVALID' });
      const phone = shared.normalizePhone(el('target-phone').value);
      const result = await client.send(phone, action, proof);
      if (current()) { challenge = { phone, id: result.challenge_id }; el('target-code').value = ''; el('target-code').focus(); }
    });
    el('commit').onclick = () => run(async current => {
      if (!proof || Date.now() >= grantUntil) throw Object.assign(new Error(), { code: 'REAUTH_INVALID' });
      let data = { reauth_token: proof };
      if (action === 'unbind') {
        if (!status.has_email || method !== 'email' || !el('confirm').checked) throw Object.assign(new Error(), { code: 'ALTERNATIVE_LOGIN_REQUIRED' });
      } else {
        const phone = shared.normalizePhone(el('target-phone').value);
        if (!challenge || challenge.phone !== phone) throw Object.assign(new Error(), { code: 'CHALLENGE_INVALID' });
        data = { ...data, phone, challenge_id: challenge.id, code: code('target-code') };
      }
      const finishedAction = action;
      try { await client.mutate(action, data); }
      catch (error) {
        if (!current()) return;
        if (['NETWORK', 'TIMEOUT', 'SERVICE_UNAVAILABLE', 'UPSTREAM_TIMEOUT', 'UPSTREAM_UNAVAILABLE', 'IDENTITY_UNAVAILABLE'].includes(error.code)) {
          close(); await load(); message('card-status', '操作结果尚未确认，已重新读取手机号状态，请核对后重试'); return;
        }
        throw error;
      }
      if (!current()) return;
      close(); await load();
      message('card-status', { bind: '手机号绑定成功', change: '手机号更换成功', unbind: '手机号解绑成功' }[finishedAction]);
      options.onChanged?.();
    });
    el('confirm').onchange = tick;
    for (const name of ['current-phone', 'target-phone']) el(name).oninput = () => { if (name === 'target-phone') challenge = null; else proofChallenge = null; tick(); };
    for (const value of ['email', 'phone']) el(`${value}-method`).onclick = () => selectMethod(value);
    for (const value of ['bind', 'change', 'unbind']) el(value).onclick = () => begin(value);
    for (const value of ['close', 'cancel']) el(value).onclick = close;
    el('form').onsubmit = event => event.preventDefault();
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('close', () => { if (action) close(); });
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key !== 'Tab') return;
      const controls = Array.from(dialog.querySelectorAll('button,input,select,textarea,a[href]'))
        .filter(node => !node.disabled && !node.closest('[hidden]') && node.tabIndex >= 0);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && global.document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && global.document.activeElement === last) { event.preventDefault(); first?.focus(); }
    });
    backdrop.onclick = close;
    el('reload').onclick = () => { close(); void load(); };
    const invalidate = () => { close(); status = null; user = null; renderCard(); };
    const storage = event => { if (event.key === 'token' || event.key === 'user' || event.key === null) { invalidate(); void load(); } };
    const refreshed = () => { if (action) invalidate(); };
    const restored = event => { if (event.persisted) { invalidate(); void load(); } };
    global.addEventListener('storage', storage);
    global.addEventListener('phone-auth-session-refresh', refreshed);
    global.addEventListener('pagehide', invalidate);
    global.addEventListener('pageshow', restored);
    global.addEventListener('site-language-change', translate);
    const timer = global.setInterval(() => {
      if (action && !client.current(snapshot)) invalidate();
      tick();
    }, 250);
    const result = { reload: load, close, destroy() { close(); global.clearInterval(timer); global.removeEventListener('storage', storage); global.removeEventListener('phone-auth-session-refresh', refreshed); global.removeEventListener('pagehide', invalidate); global.removeEventListener('pageshow', restored); global.removeEventListener('site-language-change', translate); mounted.delete(root); root.replaceChildren(); portal.remove(); } };
    mounted.set(root, result); translate(); void load(); return result;
  }
  global.SunlandPhoneSettings = { mount };
  function autoMount() { const root=global.document?.getElementById('phoneSettings'); if(!root)return; const enabled=global.document.querySelector('meta[name="sunland-phone-ui-enabled"]')?.content==='true'; root.hidden=!enabled; if(enabled)mount(root); }
  if (global.document?.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', autoMount, { once: true }); else autoMount();
})(window);
