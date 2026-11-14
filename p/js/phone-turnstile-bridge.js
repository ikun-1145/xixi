(function (global) {
  'use strict';
  const allowed = new Set(['phone_login', 'phone_bind', 'phone_change', 'phone_reauth']);
  const action = new URLSearchParams(global.location.search).get('action');
  const button = global.document.getElementById('start');
  const status = global.document.getElementById('status');
  if (global.location.origin !== 'https://sunland.dev' || global.location.pathname !== '/auth/phone-turnstile.html' ||
      global.top !== global.self || !allowed.has(action) ||
      typeof global.SunlandPhoneAuth?.runTurnstile !== 'function') {
    button.disabled = true;
    status.textContent = '验证页面不可用，请返回应用重试。';
    return;
  }
  // Native code reads this closure only by evaluating in the main frame.
  // Cross-origin challenge iframes cannot set the result or call the getter.
  let result = null;
  Object.defineProperty(global, '__phoneTurnstileTakeResult', { value() {
    const current = result; result = null; return current;
  }, configurable: false, writable: false });
  let busy = false;
  button.onclick = async () => {
    if (busy) return;
    busy = true;
    button.disabled = true;
    try {
      const token = await global.SunlandPhoneAuth.runTurnstile(action);
      if (typeof token !== 'string' || !token.length || token.length > 2048) throw new Error('invalid token');
      result = { type: 'token', action, token };
      status.textContent = '验证完成，请返回应用。';
    } catch {
      result = { type: 'error', action };
      status.textContent = '验证未完成，请返回应用重试。';
    }
  };
})(window);
