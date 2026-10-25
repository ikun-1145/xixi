import original, * as hooks from 'sunland-controlled-baseline';
import { createPhoneAuthWorker } from './routes.js';
import { OTP_PATHS, maintenance, boundedText, claimAdmission } from './otp-admission.js';
export { PhoneAuthCoordinator } from './coordinator.js';

export function controlledWorker({ fallback = false, legacy = false } = {}) {
  const phone = createPhoneAuthWorker(original, hooks);
  return { ...phone, async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/v1/phone/') && request.method !== 'OPTIONS' &&
        (fallback || legacy || env.PHONE_IDENTITY_ENABLED !== 'true')) {
      return hooks.json({ success: false, code: 'IDENTITY_DISABLED', error: '手机号认证暂未启用' }, 503, env);
    }
    if (OTP_PATHS.has(path) && request.method === 'POST') {
      try {
        const text = await boundedText(request);
        if (!await claimAdmission(env, request, text, legacy ? 'legacy' : 'rpc')) return maintenance();
        return await phone.fetch(new Request(request, { body: text }), env, ctx);
      } catch { return maintenance(); }
    }
    return phone.fetch(request, env, ctx);
  } };
}
