import { PhoneAuthError } from './errors.js';
const enc = new TextEncoder();
const idPattern = /^[A-Za-z0-9][A-Za-z0-9@._+-]{0,127}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hex = /^[0-9a-f]{64}$/;
const keyId = /^[A-Za-z0-9_-]{1,64}$/;
const purposes = new Set(['bind', 'change', 'unbind', 'delete']);
const fail = (code, status = 400) => { throw new PhoneAuthError(code, status); };
const toHex = bytes => [...new Uint8Array(bytes)].map(n => n.toString(16).padStart(2, '0')).join('');
const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
function unb64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw Error('invalid encoding');
  const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
  if (b64(bytes) !== value) throw Error('noncanonical encoding');
  return bytes;
}
function normalize(phone) {
  if (typeof phone !== 'string') fail('INVALID_REQUEST');
  const local = phone.startsWith('+86') ? phone.slice(3) : phone;
  if (!/^1[3-9]\d{9}$/.test(local)) fail('INVALID_REQUEST');
  return `+86${local}`;
}
async function hmac(secret, domain, value) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name:'HMAC', hash:'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(`${domain}\0${value}`)));
}
const sha = async value => toHex(await crypto.subtle.digest('SHA-256', enc.encode(value)));
const opaque = () => b64(crypto.getRandomValues(new Uint8Array(32)));
function proofHash(token) {
  try { if (unb64(token).length !== 32) throw Error(); } catch { fail('REAUTH_INVALID', 403); }
  return sha(token);
}
const ERROR_STATUS = { INVALID_REQUEST:400, PHONE_KEY_MISMATCH:503, ACCOUNT_NOT_ACTIVE:403, ACCOUNT_BANNED:403,
  PHONE_CONFLICT:409, PHONE_ALREADY_BOUND:409, PHONE_NOT_BOUND:409, REAUTH_INVALID:403,
  ALTERNATIVE_LOGIN_REQUIRED:409, OPERATION_CONFLICT:409, DELETION_CONFLICT:409 };

// Server only. No database credentials or raw phone numbers cross the public API.
export function createPhoneIdentity(env, { rpc } = {}) {
  if (env?.PHONE_IDENTITY_ENABLED !== 'true') fail('IDENTITY_DISABLED', 503);
  let keys;
  try {
    keys = JSON.parse(env.PHONE_IDENTITY_ENCRYPTION_KEYS);
    if (!keys || typeof keys !== 'object' || Array.isArray(keys) || Object.keys(keys).length > 16 ||
        !keyId.test(env.PHONE_IDENTITY_ENCRYPTION_KEY_ID || '') || !Object.hasOwn(keys, env.PHONE_IDENTITY_ENCRYPTION_KEY_ID) ||
        Object.entries(keys).some(([id,k]) => !keyId.test(id) || unb64(k).length !== 32)) throw Error();
  } catch { fail('IDENTITY_CONFIG', 503); }
  if (typeof rpc !== 'function' || !keyId.test(env.PHONE_IDENTITY_LOOKUP_KEY_ID || '') ||
      typeof env.PHONE_IDENTITY_LOOKUP_KEY !== 'string' || env.PHONE_IDENTITY_LOOKUP_KEY.length < 32 ||
      typeof env.PHONE_AUTH_HMAC_KEY !== 'string' || env.PHONE_AUTH_HMAC_KEY.length < 32) fail('IDENTITY_CONFIG', 503);
  const phoneHash = phone => hmac(env.PHONE_IDENTITY_LOOKUP_KEY, 'sunland-phone-index:v1', normalize(phone));
  const sessionHash = token => {
    if (typeof token !== 'string' || !token.length || token.length > 16384) fail('UNAUTHORIZED', 401);
    return hmac(env.PHONE_AUTH_HMAC_KEY, 'sunland-phone-session:v1', token);
  };
  const lookupCheck = hmac(env.PHONE_IDENTITY_LOOKUP_KEY, 'sunland-phone-index-canary:v1', '');
  async function call(action, data) {
    try {
      const r = await rpc('sunland_phone_identity', { p_action:action, p_data:{...data,
        lookup_key_id:env.PHONE_IDENTITY_LOOKUP_KEY_ID, lookup_check:await lookupCheck} });
      if (!r?.ok || !r.payload || typeof r.payload !== 'object' || Array.isArray(r.payload)) fail('IDENTITY_UNAVAILABLE', 503);
      if (r.payload.code !== 'OK') {
        if (Object.hasOwn(ERROR_STATUS,r.payload.code)) fail(r.payload.code,ERROR_STATUS[r.payload.code]);
        fail('IDENTITY_UNAVAILABLE',503);
      }
      return r.payload;
    } catch (error) {
      if (error instanceof PhoneAuthError) throw error;
      fail('IDENTITY_UNAVAILABLE',503);
    }
  }
  function auth({userId,sessionHash:session,purpose}) {
    if (!idPattern.test(userId || '') || !hex.test(session || '') || (purpose && !purposes.has(purpose))) fail('INVALID_REQUEST');
    return { user_id:userId, session_hash:session };
  }
  async function cipher(phone, userId, hash) {
    const kid = env.PHONE_IDENTITY_ENCRYPTION_KEY_ID;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey('raw',unb64(keys[kid]),'AES-GCM',false,['encrypt']);
    const ciphertext = await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:enc.encode(JSON.stringify(['sunland-phone:v1',userId,hash]))},key,enc.encode(phone));
    return JSON.stringify({version:1,key_id:kid,iv:b64(iv),ciphertext:b64(ciphertext)});
  }
  async function target(phone, userId) {
    const normalized = normalize(phone); const hash = await phoneHash(normalized);
    return {phone_hash:hash,encrypted_phone:await cipher(normalized,userId,hash),last4:normalized.slice(-4)};
  }
  async function operation(action, operationId, semantic) {
    if (!uuid.test(operationId || '')) fail('INVALID_REQUEST');
    return { operation_id:operationId, request_hash:await hmac(env.PHONE_AUTH_HMAC_KEY,'sunland-phone-operation:v1',JSON.stringify([action,operationId,...semantic])) };
  }
  return {
    sessionHash, phoneHash,
    async status(userId) {
      if (!idPattern.test(userId || '')) fail('INVALID_REQUEST');
      const r = await call('status',{user_id:userId});
      if (r.user_id !== userId || !Number.isSafeInteger(r.version) || r.version < 0 ||
          !(r.email === null || typeof r.email === 'string')) fail('IDENTITY_UNAVAILABLE',503);
      if (r.phone === null) return {user_id:userId,email:r.email,version:r.version,phone_hash:null,masked_phone:null};
      try {
        const p = r.phone, c = JSON.parse(p.encrypted_phone);
        if (p.lookup_key_id !== env.PHONE_IDENTITY_LOOKUP_KEY_ID || !hex.test(p.phone_hash) || !/^\d{4}$/.test(p.last4) ||
            c.version !== 1 || !Object.hasOwn(keys,c.key_id) || Object.keys(c).length !== 4 || unb64(c.iv).length !== 12) throw Error();
        const key = await crypto.subtle.importKey('raw',unb64(keys[c.key_id]),'AES-GCM',false,['decrypt']);
        const bytes = await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(c.iv),additionalData:enc.encode(JSON.stringify(['sunland-phone:v1',userId,p.phone_hash]))},key,unb64(c.ciphertext));
        const phone = new TextDecoder('utf-8',{fatal:true}).decode(bytes);
        if (normalize(phone) !== phone || await phoneHash(phone) !== p.phone_hash || phone.slice(-4) !== p.last4) throw Error();
        return {user_id:userId,email:r.email,version:r.version,phone_hash:p.phone_hash,masked_phone:`+86 *******${p.last4}`};
      } catch { fail('IDENTITY_UNAVAILABLE',503); }
    },
    async issueGrant({userId,sessionHash:session,purpose,method,subject}) {
      const data = auth({userId,sessionHash:session,purpose});
      if (!purposes.has(purpose) || !['email','phone'].includes(method) || typeof subject !== 'string' || !subject.length || subject.length > 320) fail('INVALID_REQUEST');
      const token = opaque(); const r = await call('grant',{...data,purpose,method,subject,proof_hash:await sha(token)});
      if (!Number.isSafeInteger(r.issued_at) || r.expires_in !== 300 || !Number.isSafeInteger(r.version)) fail('IDENTITY_UNAVAILABLE',503);
      return {reauth_token:token,issued_at:r.issued_at,expires_in:300,version:r.version};
    },
    async proof({userId,sessionHash:session,purpose,reauthToken}) {
      const data = auth({userId,sessionHash:session,purpose});
      if (!purposes.has(purpose)) fail('INVALID_REQUEST');
      const r = await call('proof',{...data,purpose,proof_hash:await proofHash(reauthToken)});
      if (!Number.isSafeInteger(r.issued_at) || !Number.isSafeInteger(r.version) || !['email','phone'].includes(r.method)) fail('IDENTITY_UNAVAILABLE',503);
      return {issued_at:r.issued_at,version:r.version,method:r.method};
    },
    async login({phone,operationId}) {
      const candidate = crypto.randomUUID(); const data = await target(phone,candidate);
      const r = await call('login',{...data,candidate_id:candidate,...await operation('login',operationId,[data.phone_hash])});
      if (!idPattern.test(r.user_id || '') || !(r.email === null || typeof r.email === 'string') ||
          typeof r.is_new_user !== 'boolean' || ![0,1].includes(r.onboarding?.version) || ![1,2,3].includes(r.onboarding?.step) ||
          (r.onboarding.version === 1 && r.onboarding.step !== 3)) fail('IDENTITY_UNAVAILABLE',503);
      return r;
    },
    async mutate(action,{userId,sessionHash:session,reauthToken,phone,operationId}) {
      if (!['bind','change','unbind'].includes(action)) fail('INVALID_REQUEST');
      const data = auth({userId,sessionHash:session,purpose:action}); const hash = await proofHash(reauthToken);
      const t = action === 'unbind' ? {} : await target(phone,userId);
      const r = await call(action,{...data,...t,proof_hash:hash,...await operation(action,operationId,[userId,session,hash,t.phone_hash || null])});
      if (r.user_id !== userId || !Number.isSafeInteger(r.version)) fail('IDENTITY_UNAVAILABLE',503);
      return r;
    },
    async authorizeDelete({userId,sessionHash:session,reauthToken,operationId}) {
      const data = auth({userId,sessionHash:session,purpose:'delete'}); const hash = await proofHash(reauthToken);
      // Existing Edge execute hashes the UTF8 token, rather than decoded bytes.
      const token = opaque(); const tokenHash = await sha(token);
      const r = await call('delete_authorize',{...data,proof_hash:hash,token_hash:tokenHash,
        ...await operation('delete_authorize',operationId,[userId,session,hash,tokenHash])});
      if (r.user_id !== userId || !uuid.test(r.deletion_job_id || '') || r.expires_in !== 600) fail('IDENTITY_UNAVAILABLE',503);
      return {ok:true,deletion_job_id:r.deletion_job_id,deletion_token:token,expires_in:600};
    },
  };
}
