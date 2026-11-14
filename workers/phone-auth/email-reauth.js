import { PhoneAuthError } from './errors.js';
import { requestJson } from './http.js';

// This sender is separate from login email OTPs and never retries a delivery.
export async function sendPhoneReauthEmail({ env, email, otp, bindCode, fetchImpl, random = crypto }) {
  const key = env?.PHONE_REAUTH_EMAIL_API_KEY;
  if (typeof key !== 'string' || !key.trim() || typeof bindCode !== 'function' ||
      !otp || typeof otp.reserve !== 'function' || typeof otp.delivery !== 'function') throw new PhoneAuthError('IDENTITY_CONFIG', 503);
  const bytes = new Uint32Array(1);
  do { random.getRandomValues(bytes); } while (bytes[0] >= 4294000000);
  const code = String(bytes[0] % 1000000).padStart(6, '0');
  const requestId = random.randomUUID();
  const reserved = await otp.reserve(bindCode(code), requestId);
  if (reserved?.code === 'THROTTLED') throw new PhoneAuthError('RATE_LIMITED', 429);
  if (reserved?.code !== 'OK') throw new PhoneAuthError('IDENTITY_UNAVAILABLE', 503);
  let outcome = 'unknown';
  try {
    const result = await requestJson('https://api.resend.com/emails', {
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Idempotency-Key': `phone-reauth-${requestId}` },
      body: JSON.stringify({ from: '霜蓝 AI <no-reply@api-mail.sunland.dev>', to: email,
        subject: '霜蓝 AI 安全验证', text: `您的安全验证码是 ${code}，有效期为 5 分钟。如果不是您本人操作，请忽略此邮件。` }),
    }, { fetchImpl, timeoutMs: 10000 });
    outcome = result.status >= 200 && result.status < 300 && typeof result.data.id === 'string' && result.data.id.length > 0 ? 'delivered' :
      result.status >= 400 && result.status < 500 && result.status !== 408 && result.status !== 429 ? 'failed' : 'unknown';
  } catch { /* Keep unknown delivery eligible for manual verification. */ }
  await otp.delivery(requestId, outcome);
  if (outcome !== 'delivered') throw new PhoneAuthError('IDENTITY_UNAVAILABLE', 503);
  return { success: true, retry_after: 60 };
}
