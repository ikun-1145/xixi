(function () {
  'use strict';
  // This fragment is our opaque request correlation, never a provider status or order ID.
  // Remove all return parameters immediately; never persist them or render their contents.
  var context = new URLSearchParams(window.location.hash.slice(1)).get('checkout');
  try { window.history.replaceState(null, '', window.location.pathname); } catch (_) { context = null; }
  var hour = new Date().getHours();
  document.body.classList.toggle('night', hour >= 18 || hour < 6);
  var messages = {
    zh: ['立即返回霜蓝 AI', '付款成功，Pro 权益待开通'],
    'zh-Hant': ['立即返回霜藍 AI', '付款成功，Pro 權益待開通'],
    en: ['Return to Sunland AI now', 'Payment confirmed. Pro activation is pending.'],
    ja: ['霜藍 AI に戻る', '支払い完了。Pro の有効化は保留中です。'],
    ko: ['Sunland AI로 돌아가기', '결제가 확인되었습니다. Pro 활성화는 보류 중입니다.'],
    es: ['Volver a Sunland AI', 'Pago confirmado. La activación de Pro está pendiente.']
  };
  var language = 'zh';
  try { language = window.localStorage.getItem('lang') || 'zh'; } catch (_) {}
  var copy = messages[language] || messages.zh;
  document.documentElement.lang = { zh: 'zh-CN', 'zh-Hant': 'zh-TW' }[language] || (messages[language] ? language : 'zh-CN');
  document.getElementById('return-link').textContent = copy[0];
  function goBack() { window.location.replace('/ai.html'); }
  var token;
  try { token = window.localStorage.getItem('token'); } catch (_) {}
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(context || '') || !token) {
    goBack();
    return;
  }
  // A slow/unavailable backend must also return silently; no indefinite pending page.
  var controller = new AbortController();
  var expired = false;
  var fallback = window.setTimeout(function () { expired = true; controller.abort(); goBack(); }, 4000);
  window.fetch('https://waffopay.sunland.dev/checkout/waffo/production/status', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ checkout: context }), signal: controller.signal,
    credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer'
  }).then(function (response) {
    if (!response.ok) throw new Error('unavailable');
    return response.json();
  }).then(function (result) {
    if (expired) return;
    window.clearTimeout(fallback);
    // Confirmed requires this user's server-validated payment proof, never an observation.
    if (!result || result.paymentConfirmed !== true || !([true, false].includes(result.entitlementEnabled)) || !['pending', 'granted', 'failed'].includes(result.entitlementState)) { goBack(); return; }
    var status = document.getElementById('return-status');
    var granted = {
      zh: '付款成功，Pro 已激活', 'zh-Hant': '付款成功，Pro 已啟用',
      en: 'Payment confirmed. Pro is active.', ja: '支払い完了。Pro は有効です。',
      ko: '결제가 확인되었습니다. Pro가 활성화되었습니다.', es: 'Pago confirmado. Pro está activo.'
    };
    status.textContent = result.entitlementState === 'granted' ? (granted[language] || granted.zh) : copy[1];
    status.hidden = false;
    window.setTimeout(goBack, 1800);
  }).catch(function () { window.clearTimeout(fallback); if (!expired) goBack(); });
}());
