import { requireAdmin } from './release-policy.js';
import { requestJson } from './http.js';
import { PhoneAuthError } from './errors.js';

// No DO, database, SMS adapter, or request logging is used by this diagnostic.
export async function turnstileProbe(request, env, { readBody, fetchImpl, now = Date.now, timeoutMs = 5000 } = {}) {
  const reply = (ok, status) => Response.json({ ok }, { status, headers: { 'Cache-Control': 'no-store' } });
  try {
    if (request.method !== 'POST') return reply(false, 405);
    await requireAdmin(env, request);
    if (['PHONE_IDENTITY_ENABLED', 'PHONE_SMS_ENABLED', 'PHONE_NEW_REGISTRATION_ENABLED'].some(k => env?.[k] !== 'false')) return reply(false, 403);
    if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) return reply(false, 400);
    const parsed = await readBody(request, 4096);
    const input = parsed?.value;
    if (parsed?.error || !input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).length !== 1 || typeof input.token !== 'string' || !input.token.length || input.token.length > 2048) return reply(false, 400);
    if (typeof env.TURNSTILE_SECRET !== 'string' || !env.TURNSTILE_SECRET.trim() ||
        typeof env.PHONE_TURNSTILE_HOSTNAME !== 'string' || !env.PHONE_TURNSTILE_HOSTNAME) return reply(false, 503);
    const { status, data } = await requestJson('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: input.token }),
    }, { fetchImpl, timeoutMs });
    const timestamp = Date.parse(data?.challenge_ts), current = now();
    const valid = status === 200 && data?.success === true && data.hostname === env.PHONE_TURNSTILE_HOSTNAME &&
      data.action === 'phone_login' && Number.isFinite(timestamp) && Number.isFinite(current) &&
      current - timestamp <= 300000 && timestamp - current <= 30000;
    return reply(valid, valid ? 200 : 403);
  } catch (error) {
    return reply(false, error instanceof PhoneAuthError && error.code === 'UNAUTHORIZED' ? 401 : 503);
  }
}
