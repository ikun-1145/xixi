import { PhoneAuthError, requireSmsEnabled } from './errors.js';
import { requestJson } from './http.js';

export function smsProvider(env) {
  const provider = env.PHONE_SMS_PROVIDER === undefined ? 'aliyun' : env.PHONE_SMS_PROVIDER;
  if (!['aliyun', 'relay'].includes(provider)) throw new PhoneAuthError('SMS_CONFIG', 503);
  return provider;
}

// The relay's current template is approved solely for registration and login.
export function requireRelayTemplatePurpose(env, purpose) {
  if (purpose !== 'login') throw new PhoneAuthError('IDENTITY_DISABLED', 503);
}

export class SmsRelayClient {
  constructor(env, { fetchImpl = (url, init) => globalThis.fetch(url, init) } = {}) {
    requireSmsEnabled(env);
    let url;
    try { url = new URL(env.SMS_RELAY_URL); } catch { /* fixed configuration error below */ }
    if (!url || url.protocol !== 'https:' || url.username || url.password || url.hash ||
        typeof env.SUNLAND_SMS_RELAY_KEY !== 'string' || !env.SUNLAND_SMS_RELAY_KEY.trim() ||
        env.SUNLAND_SMS_RELAY_KEY.trim() !== env.SUNLAND_SMS_RELAY_KEY || env.SUNLAND_SMS_RELAY_KEY.length > 8192 ||
        /[\x00-\x1f\x7f]/.test(env.SUNLAND_SMS_RELAY_KEY)) throw new PhoneAuthError('SMS_CONFIG', 503);
    this.env = env;
    this.url = url.href;
    this.fetchImpl = fetchImpl;
  }

  async send({ phone, code, purpose }) {
    requireSmsEnabled(this.env);
    // Account management stays separately gated; each purpose remains bound
    // to its own challenge even though the relay uses the login template.
    const allowed = ['login', 'reauth'].includes(purpose) ||
      (this.env.PHONE_ACCOUNT_MANAGEMENT_ENABLED === 'true' && ['bind', 'change'].includes(purpose));
    if (!allowed || typeof phone !== 'string' || !/^1[3-9]\d{9}$/.test(phone) ||
        typeof code !== 'string' || !/^\d{6}$/.test(code)) throw new PhoneAuthError('INVALID_REQUEST');
    requireRelayTemplatePurpose(this.env, purpose);
    const { status, data } = await requestJson(this.url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: this.env.SUNLAND_SMS_RELAY_KEY, phone, code, scene: 'login' }),
    }, { fetchImpl: this.fetchImpl, timeoutMs: 8000 });
    // Even a business rejection may have followed a send. Never classify it as
    // definitely unsent or release the coordinator's unknown-outcome quarantine.
    if (status < 200 || status >= 300 || data.ok !== 1) throw new PhoneAuthError('PROVIDER_UNAVAILABLE', 503);
    return { accepted: true };
  }
}
