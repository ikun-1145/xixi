const enc = new TextEncoder();
export const OTP_PATHS = new Set(['/send-code', '/verify-code']);
const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
export const bodyHash = async (text, secret) => hex(await crypto.subtle.sign('HMAC', await key(secret, ['sign']), enc.encode('otp-body:v1\0' + text)));
function key(secret, usages) {
  if (typeof secret !== 'string' || secret.length < 32) throw Error('Missing admission key');
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usages);
}
export async function signedAdmission(secret, path, text, id, generation, now = Date.now()) {
  const message = [id, String(generation), String(now), path, await bodyHash(text, secret)].join('\n');
  return [id, generation, now, hex(await crypto.subtle.sign('HMAC', await key(secret, ['sign']), enc.encode(message)))].join('.');
}
export async function validAdmission(secret, request, text) {
  try {
    const parts = (request.headers.get('X-Sunland-Otp-Admission') || '').split('.');
    const [id, generation, time, signature] = parts;
    if (parts.length !== 4 || !/^[0-9a-f-]{36}$/.test(id) || !/^[1-9]\d{0,9}$/.test(generation) ||
        !/^\d{13}$/.test(time) || !/^[0-9a-f]{64}$/.test(signature) ||
        Date.now() - Number(time) > 300000 || Number(time) - Date.now() > 30000) return false;
    const message = [id, generation, time, new URL(request.url).pathname, await bodyHash(text, secret)].join('\n');
    return await crypto.subtle.verify('HMAC', await key(secret, ['verify']), Uint8Array.from(signature.match(/../g), x => parseInt(x, 16)), enc.encode(message));
  } catch { return false; }
}
export async function claimAdmission(env, request, text, authority) {
  if (!await validAdmission(env.OTP_GATEWAY_AUTH_KEY, request, text)) return false;
  try {
    const [id, generation] = request.headers.get('X-Sunland-Otp-Admission').split('.');
    const response = await env.OTP_MAINTENANCE.getByName('sunland-otp-gate-v1').fetch('https://otp-gate.internal/__internal/claim', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.OTP_GATEWAY_AUTH_KEY },
      body: JSON.stringify({ id, generation: Number(generation), path: new URL(request.url).pathname, hash: await bodyHash(text, env.OTP_GATEWAY_AUTH_KEY), authority }),
    });
    return response.status === 200;
  } catch { return false; }
}
export async function administrator(secret, request) {
  try {
    const presented = request.headers.get('Authorization') || '';
    if (!presented.startsWith('Bearer ') || presented.length > 520) return false;
    const expected = await crypto.subtle.sign('HMAC', await key(secret, ['sign']), enc.encode('otp-operator:v1'));
    return await crypto.subtle.verify('HMAC', await key(presented.slice(7), ['verify']), expected, enc.encode('otp-operator:v1'));
  } catch { return false; }
}
export function maintenance() {
  return Response.json({ error: 'OTP_MAINTENANCE' }, { status: 503, headers: {
    'Cache-Control': 'no-store', 'Retry-After': '60', 'Access-Control-Allow-Origin': 'https://sunland.dev',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Request-Id, X-Sunland-Android-Build, X-Sunland-Ios-Build',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, PATCH, DELETE, OPTIONS',
  } });
}
export async function boundedText(request, max = 204800) {
  const reader = request.body?.getReader();
  if (!reader) throw Error('Missing body');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > max) { void reader.cancel().catch(() => {}); throw Error('Body limit'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
