import { PhoneAuthError } from './errors.js';
const fail = (code, status = 503) => { throw new PhoneAuthError(code, status); };

// Server-only policy: caller input cannot select a release mode or recipient.
export function releasePolicy(env) {
  if (!['canary', 'public'].includes(env.PHONE_RELEASE_MODE)) fail('RELEASE_CONFIG');
  let hashes = [];
  if (env.PHONE_RELEASE_MODE === 'canary') {
    try { hashes = JSON.parse(env.PHONE_SMS_CANARY_PHONE_HASHES); } catch { fail('RELEASE_CONFIG'); }
    if (!Array.isArray(hashes) || !hashes.length || hashes.length > 16 ||
        hashes.some(hash => typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) ||
        new Set(hashes).size !== hashes.length) fail('RELEASE_CONFIG');
  }
  return { mode: env.PHONE_RELEASE_MODE, hashes };
}

export function allowCanaryRecipient(policy, phoneHash) {
  if (policy.mode === 'canary' && !policy.hashes.includes(phoneHash)) fail('CANARY_DENIED', 403);
}

export async function requireAdmin(env, request) {
  const token = env.PHONE_AUTH_ADMIN_TOKEN;
  const enc = new TextEncoder();
  if (typeof token !== 'string' || enc.encode(token).length < 32 || enc.encode(token).length > 512 ||
      [env.PHONE_AUTH_HMAC_KEY, env.PHONE_IDENTITY_LOOKUP_KEY, env.PHONE_ALIYUN_ACCESS_KEY_SECRET, env.TURNSTILE_SECRET].includes(token)) fail('RELEASE_CONFIG');
  const authorization = request.headers.get('Authorization') || '';
  const presented = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!presented || enc.encode(presented).length > 512) fail('UNAUTHORIZED', 401);
  // Let WebCrypto compare the MAC in constant time rather than compare secrets
  // with JavaScript string equality. Both keys/signatures stay in memory only.
  const algorithm = { name: 'HMAC', hash: 'SHA-256' };
  const key = await crypto.subtle.importKey('raw', enc.encode(token), algorithm, false, ['sign']);
  const suppliedKey = await crypto.subtle.importKey('raw', enc.encode(presented), algorithm, false, ['verify']);
  const message = enc.encode('sunland-phone-auth-admin:v1');
  if (!await crypto.subtle.verify('HMAC', suppliedKey, await crypto.subtle.sign('HMAC', key, message), message)) fail('UNAUTHORIZED', 401);
}
