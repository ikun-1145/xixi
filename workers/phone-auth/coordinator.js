import { DypnsapiClient } from './dypnsapi.js';
import { SmsRelayClient, smsProvider, requireRelayTemplatePurpose } from './relay.js';
import { PhoneAuthError, requireSmsEnabled } from './errors.js';
import { requestJson } from './http.js';
import { releasePolicy, allowCanaryRecipient, requireAdmin } from './release-policy.js';

export const SINGLETON_NAME = 'sunland-phone-auth-v1';
export const LEDGER_KEY = 'account';
const EXTRA_LOGIN_KEY = 'canary:login-extra:v1';
const V1_BACKUP_KEY = 'account:v1:backup';
const TEMPORARY_KEY = 'quota:temporary:2026-11-19';
const TEMPORARY_START = Date.UTC(2026, 10, 18, 16);
const TEMPORARY_END = Date.UTC(2026, 10, 19, 16);
const TEMPORARY_LIMIT = 20;
const DAY = 86400000;
const dayNumber = (now, schema) => Math.floor((now + (schema === 2 ? 8 * 3600000 : 0)) / DAY);
const TTL = 300000;
const LOCK = 600000;
const PURPOSES = Object.freeze({ login: 'sl-login-v1', bind: 'sl-bind-v1', change: 'sl-change-v1',
  unbind: 'sl-unbind-v1', reauth: 'sl-reauth-v1' });
const positive = n => Number.isSafeInteger(n) && n > 0;
const nonnegative = n => Number.isSafeInteger(n) && n >= 0;
const fail = (code, status = 400) => { throw new PhoneAuthError(code, status); };
const jsonValue = value => value === null || typeof value === 'string' || typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value)) ||
  (Array.isArray(value) && value.every(jsonValue)) ||
  (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype &&
    Object.values(value).every(jsonValue));
const policyFields = ['perPhoneDaily', 'perIpDaily', 'dailyLimit', 'unitCostMicros', 'dailyBudgetMicros',
  'totalBudgetMicros', 'ipRequestsPerMinute', 'globalRequestsPerMinute'];

function settings(env) {
  requireSmsEnabled(env);
  releasePolicy(env);
  let policy;
  try { policy = JSON.parse(env.PHONE_AUTH_POLICY); } catch { fail('SMS_CONFIG', 503); }
  if (!policy || policyFields.some(k => !positive(policy[k])) || policy.dailyLimit > 10000 ||
      typeof env.PHONE_AUTH_HMAC_KEY !== 'string' || env.PHONE_AUTH_HMAC_KEY.length < 32 ||
      !/^[a-zA-Z0-9_-]{1,32}$/.test(env.PHONE_AUTH_HMAC_KEY_ID || '') ||
      typeof env.TURNSTILE_SECRET !== 'string' || !env.TURNSTILE_SECRET.trim() ||
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(env.PHONE_TURNSTILE_HOSTNAME || '')) fail('SMS_CONFIG', 503);
  return policy;
}

function validate(input, context, operation, now) {
  const fields = operation === 'send' ? ['phone', 'purpose', 'turnstile_token'] : ['phone', 'purpose', 'challenge_id', 'code'];
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      fields.some(k => !Object.hasOwn(input, k)) ||
      Object.keys(input).some(k => !fields.includes(k) && !(operation === 'send' && k === 'challenge_id')) ||
      !Object.hasOwn(PURPOSES, input.purpose) || typeof input.phone !== 'string') fail('INVALID_REQUEST');
  const phone = input.phone.startsWith('+86') ? input.phone.slice(3) : input.phone;
  if (!/^1[3-9]\d{9}$/.test(phone)) fail('INVALID_REQUEST');
  if (operation === 'send') {
    if (typeof input.turnstile_token !== 'string' || !input.turnstile_token.length || input.turnstile_token.length > 2048 ||
        (Object.hasOwn(input, 'challenge_id') && (typeof input.challenge_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.challenge_id)))) fail('INVALID_REQUEST');
  } else if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.challenge_id || '') ||
      typeof input.code !== 'string' || !/^\d{6}$/.test(input.code)) fail('INVALID_REQUEST');
  // The ingress must supply CF-Connecting-IP itself, never a client body or XFF.
  const rawIp = context?.ip;
  let ip;
  if (typeof rawIp === 'string' && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(rawIp) && rawIp.split('.').every(x => Number(x) <= 255)) {
    ip = rawIp.split('.').map(x => String(Number(x))).join('.');
  } else if (typeof rawIp === 'string' && /^[0-9a-fA-F:]+$/.test(rawIp) && rawIp.includes(':')) {
    try { ip = new URL(`https://[${rawIp}]/`).hostname.slice(1, -1); } catch { fail('INVALID_REQUEST'); }
  } else fail('INVALID_REQUEST');
  let principal = 'anonymous-login';
  if (input.purpose !== 'login') {
    if (typeof context.userId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9@._+-]{0,127}$/.test(context.userId) ||
        typeof context.sessionId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(context.sessionId) ||
        context.identityStatus !== 'active') fail('REAUTH_REQUIRED', 403);
    // Only the authenticated ingress can start reauthentication. It must check
    // current factor ownership again in the identity transaction after SMS PASS.
    if (!(input.purpose === 'reauth' && context.reauthentication === true) &&
        (!nonnegative(context.reauthenticatedAt) || context.reauthenticatedAt > now ||
         now - context.reauthenticatedAt > TTL)) fail('REAUTH_REQUIRED', 403);
    principal = JSON.stringify([context.userId, context.sessionId]);
  }
  return { phone, ip, principal };
}

async function digest(secret, domain, value) {
  const encode = value => new TextEncoder().encode(value);
  const key = await crypto.subtle.importKey('raw', encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = await crypto.subtle.sign('HMAC', key, encode(`${domain}\0${value}`));
  return [...new Uint8Array(bytes)].map(n => n.toString(16).padStart(2, '0')).join('');
}

const ledgerFingerprint = (env, policy, release) => digest(env.PHONE_AUTH_HMAC_KEY, 'ledger-config:v1', JSON.stringify([
  env.PHONE_AUTH_HMAC_KEY_ID, release.mode, [...release.hashes].sort(), policyFields.map(k => policy[k])
]));
const structureFingerprint = env => digest(env.PHONE_AUTH_HMAC_KEY, 'ledger-structure:v2', JSON.stringify([2, env.PHONE_AUTH_HMAC_KEY_ID, SINGLETON_NAME]));
const operationFingerprint = (env, policy) => digest(env.PHONE_AUTH_HMAC_KEY, 'ledger-operation:v2', JSON.stringify(policyFields.map(k => policy[k])));
function v2Policy(env, name) {
  let policy;
  try { policy = JSON.parse(env[name]); } catch { fail('RELEASE_CONFIG', 503); }
  if (!policy || policyFields.some(k => !positive(policy[k])) || policy.dailyLimit !== 100) fail('RELEASE_CONFIG', 503);
  return policy;
}

function randomCode() {
  const bytes = new Uint32Array(1);
  // Rejection sampling avoids modulo bias while retaining leading zeroes.
  do { crypto.getRandomValues(bytes); } while (bytes[0] >= 4294000000);
  return String(bytes[0] % 1000000).padStart(6, '0');
}

const otpValue = (id, phoneHash, purpose, code) => JSON.stringify([id, phoneHash, purpose, code]);
async function verifyRelayCode(secret, mac, value) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, Uint8Array.from(mac.match(/../g), x => parseInt(x, 16)),
    enc.encode(`sms-relay-otp:v1\0${value}`));
}

// Importable DO class using the supported constructor + fetch entrypoint.
// ponytail: one coordinator is the global budget authority; sharding needs a
// separate atomic global reservation authority before it can be introduced.
export class PhoneAuthCoordinator {
  constructor(state, env, { now = Date.now, fetchImpl = (url, init) => globalThis.fetch(url, init) } = {}) {
    this.storage = state.storage;
    this.env = env;
    this.now = now;
    this.fetchImpl = fetchImpl;
  }

  async transaction(fn) {
    try { return await this.storage.transaction(fn); }
    catch (error) {
      if (error instanceof PhoneAuthError) throw error;
      fail('SERVICE_UNAVAILABLE', 503);
    }
  }

  async account(tx, now) {
    const account = await tx.get(LEDGER_KEY);
    // No automatic initialization: an evicted/missing ledger cannot reset cost.
    if (!account || ![1, 2].includes(account.schema) || account.enabled !== true || account.keyId !== this.env.PHONE_AUTH_HMAC_KEY_ID ||
        !['testReserved', 'totalMicros', 'day', 'dayCount', 'dayMicros', 'minute', 'minuteCount', 'lastNow'].every(k => nonnegative(account[k])) ||
        account.testReserved > 3 ||
        !nonnegative(now) || now < account.lastNow) fail('SERVICE_UNAVAILABLE', 503);
    if (account.schema === 2 && (account.dayCount > 100 || account.structureConfig !== await structureFingerprint(this.env) ||
        typeof account.operationConfig !== 'string' || !/^[0-9a-f]{64}$/.test(account.operationConfig))) fail('SERVICE_UNAVAILABLE', 503);
    account.lastNow = now;
    if (account.day !== dayNumber(now, account.schema)) {
      if (account.day > dayNumber(now, account.schema)) fail('SERVICE_UNAVAILABLE', 503);
      account.day = dayNumber(now, account.schema); account.dayCount = 0; account.dayMicros = 0;
    }
    if (account.minute !== Math.floor(now / 60000)) {
      account.minute = Math.floor(now / 60000); account.minuteCount = 0;
    }
    return account;
  }

  async claimTurnstile(tx, tokenHash, now) {
    const key = `t:turnstile:${tokenHash}`;
    if (await tx.get(key) !== undefined) return false;
    await tx.put(key, { deleteAfter: now + TTL + 30000 + 10000 });
    return true;
  }

  async cleanup(tx, now) {
    const cursor = await tx.get('cleanup-cursor');
    const records = await tx.list({ prefix: 't:', startAfter: typeof cursor === 'string' ? cursor : '', limit: 32 });
    for (const [name, value] of records) if (nonnegative(value?.deleteAfter) && value.deleteAfter <= now) await tx.delete(name);
    await tx.put('cleanup-cursor', records.size === 32 ? [...records.keys()].at(-1) : '');
  }

  async temporaryQuota(tx, account, policy, now) {
    if (this.env.PHONE_TEMPORARY_SMS_20261119_ENABLED !== 'true' || account.schema !== 2 ||
        now < TEMPORARY_START || now >= TEMPORARY_END || account.day !== dayNumber(TEMPORARY_START, 2) ||
        account.dayCount !== 100 || policy.dailyLimit !== 100) fail('BUDGET_EXCEEDED', 429);
    const backup = await tx.get(V1_BACKUP_KEY);
    if (!backup || backup.schema !== 1 || backup.initConfig !== account.initConfig ||
        backup.keyId !== account.keyId) fail('SERVICE_UNAVAILABLE', 503);
    const marker = await tx.get(TEMPORARY_KEY);
    if (marker === undefined) {
      if (account.dayMicros !== 0) fail('SERVICE_UNAVAILABLE', 503);
      return {schema:1, day:account.day, used:0, structureConfig:account.structureConfig};
    }
    if (!marker || marker.schema !== 1 || marker.day !== account.day ||
        marker.structureConfig !== account.structureConfig || !nonnegative(marker.used) ||
        marker.used > TEMPORARY_LIMIT || account.dayMicros !== marker.used * policy.unitCostMicros ||
        Object.keys(marker).length !== 4) fail('SERVICE_UNAVAILABLE', 503);
    return marker;
  }

  async prepare(input, context, operation, extraFingerprint) {
    const policy = settings(this.env);
    const now = this.now();
    const normalized = validate(input, context, operation, now);
    const [phoneHash, ipHash, principalHash] = await Promise.all([
      digest(this.env.PHONE_AUTH_HMAC_KEY, 'phone', normalized.phone),
      digest(this.env.PHONE_AUTH_HMAC_KEY, 'ip', normalized.ip),
      digest(this.env.PHONE_AUTH_HMAC_KEY, 'principal', normalized.principal),
    ]);
    if (operation === 'send') allowCanaryRecipient(releasePolicy(this.env), phoneHash);
    const tokenHash = operation === 'send' ? await digest(this.env.PHONE_AUTH_HMAC_KEY, 'turnstile-token:v1', input.turnstile_token) : null;
    const claimed = await this.transaction(async tx => {
      const now = this.now();
      const account = await this.account(tx, now);
      if (releasePolicy(this.env).mode === 'public' && account.schema !== 2) fail('RELEASE_CONFIG', 503);
      if (account.schema === 2 && (releasePolicy(this.env).mode !== 'public' ||
          this.env.PHONE_LOGIN_EXTRA_CANARY_ENABLED !== 'false' || policy.dailyLimit !== 100 ||
          account.operationConfig !== await operationFingerprint(this.env, policy))) fail('RELEASE_CONFIG', 503);
      if (extraFingerprint !== undefined && (account.testReserved !== 3 || account.initConfig !== extraFingerprint))
        fail('RELEASE_CONFIG', 503);
      const key = `t:requests:${ipHash}`;
      const previous = await tx.get(key);
      if (previous && (!nonnegative(previous.count) || !nonnegative(previous.minute))) fail('SERVICE_UNAVAILABLE', 503);
      const count = previous?.minute === account.minute ? previous.count : 0;
      if (count >= policy.ipRequestsPerMinute || account.minuteCount >= policy.globalRequestsPerMinute) fail('RATE_LIMITED', 429);
      account.minuteCount++;
      await tx.put(LEDGER_KEY, account);
      await tx.put(key, { minute: account.minute, count: count + 1, deleteAfter: now + 120000 });
      const claimed = !tokenHash || await this.claimTurnstile(tx, tokenHash, now);
      await this.cleanup(tx, now);
      return claimed;
    });
    if (!claimed) fail('CAPTCHA_FAILED', 403);
    return { ...normalized, phoneHash, ipHash, principalHash, policy };
  }

  async send(input, context) {
    // Reject unconfirmed template use before touching the ledger or Turnstile.
    requireSmsEnabled(this.env);
    if (smsProvider(this.env) === 'relay') requireRelayTemplatePurpose(this.env, input?.purpose);
    let extraFingerprint;
    if (this.env.PHONE_LOGIN_EXTRA_CANARY_ENABLED === 'true') {
      const policy = settings(this.env), release = releasePolicy(this.env);
      if (release.mode !== 'canary' || release.hashes.length !== 1 || input?.purpose !== 'login' ||
          this.env.PHONE_SMS_PROVIDER !== 'relay' || this.env.PHONE_IDENTITY_ENABLED !== 'true' ||
          ['PHONE_NEW_REGISTRATION_ENABLED','PHONE_ACCOUNT_MANAGEMENT_ENABLED','PHONE_EMAIL_REAUTH_ENABLED',
            'PHONE_TURNSTILE_DIAGNOSTICS_ENABLED'].some(k => this.env[k] !== 'false') ||
          policy.perPhoneDaily !== 3 || policy.perIpDaily !== 3 || policy.dailyLimit !== 3 ||
          policy.unitCostMicros !== 200000 || policy.dailyBudgetMicros !== 600000 || policy.totalBudgetMicros !== 600000)
        fail('RELEASE_CONFIG', 503);
      extraFingerprint = await ledgerFingerprint(this.env, policy, release);
    }
    const prepared = await this.prepare(input, context, 'send', extraFingerprint);
    const { phone, ip, phoneHash, ipHash, principalHash, policy } = prepared;
    const provider = smsProvider(this.env);
    const relay = provider === 'relay' ? new SmsRelayClient(this.env, { fetchImpl: this.fetchImpl }) : null;
    if (relay && !['login', 'reauth'].includes(input.purpose) &&
        !(this.env.PHONE_ACCOUNT_MANAGEMENT_ENABLED === 'true' && ['bind', 'change'].includes(input.purpose))) fail('INVALID_REQUEST');
    const { status, data } = await requestJson('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', cache:'no-store', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: this.env.TURNSTILE_SECRET, response: input.turnstile_token, remoteip: ip }),
    }, { fetchImpl: this.fetchImpl, timeoutMs: Number(this.env.PHONE_API_TIMEOUT_MS ?? 5000) });
    const challengeTime = Date.parse(data?.challenge_ts);
    if (status !== 200 || data?.success !== true || data.hostname !== this.env.PHONE_TURNSTILE_HOSTNAME ||
        data.action !== `phone_${input.purpose}` || !Number.isFinite(challengeTime) ||
        this.now() - challengeTime > TTL || challengeTime - this.now() > 30000) fail('CAPTCHA_FAILED', 403);

    const now = this.now();
    validate(input, context, 'send', now);
    const id = input.challenge_id ?? crypto.randomUUID();
    const phoneKey = `t:phone:${phoneHash}`;
    const ipKey = `t:ip:${ipHash}`;
    const challengeKey = `t:challenge:${id}`;
    const code = relay ? randomCode() : undefined;
    const otpMac = relay ? await digest(this.env.PHONE_AUTH_HMAC_KEY, 'sms-relay-otp:v1', otpValue(id, phoneHash, input.purpose, code)) : undefined;
    const challenge = { schema: 1, provider, ...(relay ? { otpMac } : {}), phoneHash, principalHash, purpose: input.purpose, status: 'sending',
      attempts: 0, expiresAt: now + TTL, deleteAfter: now + LOCK * 2 };
    const reservedAt = await this.transaction(async tx => {
      const now = this.now();
      validate(input, context, 'send', now);
      const account = await this.account(tx, now);
      const release = releasePolicy(this.env);
      if (release.mode === 'public' && account.schema !== 2) fail('RELEASE_CONFIG', 503);
      if (account.schema === 2 && (release.mode !== 'public' || this.env.PHONE_LOGIN_EXTRA_CANARY_ENABLED !== 'false' ||
          policy.dailyLimit !== 100 || account.operationConfig !== await operationFingerprint(this.env, policy))) fail('RELEASE_CONFIG', 503);
      allowCanaryRecipient(release, phoneHash);
      if (await tx.get(challengeKey)) fail('OPERATION_CONFLICT', 409);
      const extra = extraFingerprint !== undefined;
      if (extra) {
        if (account.testReserved !== 3 || account.initConfig !== extraFingerprint)
          fail('RELEASE_CONFIG', 503);
        const used = await tx.get(EXTRA_LOGIN_KEY);
        if (used !== undefined) {
          if (!used || used.schema !== 1 || used.used !== 1 || Object.keys(used).length !== 2) fail('SERVICE_UNAVAILABLE', 503);
          fail('CANARY_LIMITED', 429);
        }
        if (account.totalMicros !== 600000) fail('RELEASE_CONFIG', 503);
      } else if (release.mode === 'canary' && account.testReserved >= 3) fail('CANARY_LIMITED', 429);
      const p = await tx.get(phoneKey);
      const i = await tx.get(ipKey);
      for (const value of [p, i]) {
        if (value && (!nonnegative(value.day) || !nonnegative(value.count))) fail('SERVICE_UNAVAILABLE', 503);
      }
      if (p?.quarantined) fail('SERVICE_UNAVAILABLE', 503);
      if (p && !nonnegative(p.lockUntil)) fail('SERVICE_UNAVAILABLE', 503);
      if (p?.lockUntil > now) fail('RATE_LIMITED', 429);
      const phoneCount = p?.day === account.day ? p.count : 0;
      const ipCount = i?.day === account.day ? i.count : 0;
      if (phoneCount >= policy.perPhoneDaily + Number(extra) || ipCount >= policy.perIpDaily + Number(extra)) fail('RATE_LIMITED', 429);
      let temporary;
      if (account.dayCount >= policy.dailyLimit + Number(extra)) {
        if (account.schema !== 2 || extra) fail('BUDGET_EXCEEDED', 429);
        temporary = await this.temporaryQuota(tx, account, policy, now);
        if (temporary.used >= TEMPORARY_LIMIT) fail('BUDGET_EXCEEDED', 429);
      }
      if (account.schema === 1 &&
          (account.totalMicros > policy.totalBudgetMicros + Number(extra) * policy.unitCostMicros - policy.unitCostMicros ||
          account.dayMicros > policy.dailyBudgetMicros + Number(extra) * policy.unitCostMicros - policy.unitCostMicros)) fail('BUDGET_EXCEEDED', 429);
      if (!Number.isSafeInteger(account.totalMicros + policy.unitCostMicros) || !Number.isSafeInteger(account.dayMicros + policy.unitCostMicros)) fail('SERVICE_UNAVAILABLE', 503);
      if (temporary) {
        temporary.used++;
        await tx.put(TEMPORARY_KEY, temporary);
      } else account.dayCount++;
      account.dayMicros += policy.unitCostMicros; account.totalMicros += policy.unitCostMicros;
      if (extra) await tx.put(EXTRA_LOGIN_KEY, {schema:1,used:1});
      else if (release.mode === 'canary') account.testReserved++;
      await tx.put(LEDGER_KEY, account);
      await tx.put(phoneKey, { day: account.day, count: phoneCount + 1, lockUntil: now + LOCK,
        challengeId: id, quarantined: true });
      await tx.put(ipKey, { day: account.day, count: ipCount + 1, deleteAfter: now + DAY * 2 });
      await tx.put(challengeKey, { ...challenge, expiresAt: now + TTL, deleteAfter: now + LOCK * 2 });
      return now;
    });

    try {
      if (relay) await relay.send({ phone, code, purpose: input.purpose });
      else await new DypnsapiClient(this.env, { fetchImpl: this.fetchImpl, now: this.now }).send({ phone, scheme: PURPOSES[input.purpose], outId: id });
    } catch (error) {
      await this.transaction(async tx => {
        await this.account(tx, this.now());
        const saved = await tx.get(challengeKey);
        if (!saved || saved.status !== 'sending') fail('SERVICE_UNAVAILABLE', 503);
        saved.status = 'failed';
        await tx.put(challengeKey, saved);
        if (['PROVIDER_RATE_LIMITED', 'PROVIDER_AUTH', 'PROVIDER_CONFIG', 'SMS_CONFIG', 'INVALID_REQUEST'].includes(error?.code)) {
          const locked = await tx.get(phoneKey);
          if (!locked || locked.challengeId !== id) fail('SERVICE_UNAVAILABLE', 503);
          locked.quarantined = false;
          locked.deleteAfter = reservedAt + DAY * 2;
          await tx.put(phoneKey, locked);
        } else {
          // An aborted request need not mean supplier cancellation. Quarantine
          // until separately reviewed recovery; do not guess its processing TTL.
          const locked = await tx.get(phoneKey);
          if (!locked || locked.challengeId !== id) fail('SERVICE_UNAVAILABLE', 503);
          locked.quarantined = true;
          delete locked.deleteAfter;
          await tx.put(phoneKey, locked);
        }
      });
      throw error;
    }
    await this.transaction(async tx => {
      await this.account(tx, this.now());
      const saved = await tx.get(challengeKey);
      if (!saved || saved.status !== 'sending') fail('SERVICE_UNAVAILABLE', 503);
      if (saved.expiresAt <= this.now()) fail('CHALLENGE_EXPIRED');
      saved.status = 'sent'; await tx.put(challengeKey, saved);
      const locked = await tx.get(phoneKey);
      if (!locked || locked.challengeId !== id) fail('SERVICE_UNAVAILABLE', 503);
      locked.quarantined = false;
      locked.deleteAfter = reservedAt + DAY * 2;
      await tx.put(phoneKey, locked);
    });
    return { success: true, challenge_id: id, expires_in: Math.floor((reservedAt + TTL - this.now()) / 1000),
      retry_after: Math.ceil((reservedAt + LOCK - this.now()) / 1000) };
  }

  async check(input, context, unified) {
    const { phone, phoneHash, principalHash } = await this.prepare(input, context, 'check');
    const key = `t:challenge:${input.challenge_id}`;
    if (unified && (this.env.PHONE_UNIFIED_LOGIN_ENABLED !== 'true' || input.purpose !== 'login' ||
        !/^[0-9a-f]{64}$/.test(unified.proofHash || '') ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(unified.operationId || ''))) fail('INVALID_REQUEST');
    const proofKey = unified ? `t:unified:${unified.proofHash}` : null;
    const attempt = await this.transaction(async tx => {
      const now = this.now();
      validate(input, context, 'check', now);
      await this.account(tx, now);
      const c = await tx.get(key);
      if (!c || c.schema !== 1 || c.phoneHash !== phoneHash || c.principalHash !== principalHash || c.purpose !== input.purpose) fail('CHALLENGE_INVALID');
      if (unified && c.status === 'consumed') {
        const existing = await tx.get(proofKey);
        if (existing && existing.phoneHash === phoneHash && existing.challengeId === input.challenge_id &&
            existing.operationId === unified.operationId && existing.expiresAt > now) return { recovered: true };
      }
      const locked = await tx.get(`t:phone:${phoneHash}`);
      if (!locked || locked.challengeId !== input.challenge_id || !nonnegative(locked.lockUntil)) fail('SERVICE_UNAVAILABLE', 503);
      if (!nonnegative(c.expiresAt) || !nonnegative(c.attempts)) fail('SERVICE_UNAVAILABLE', 503);
      if (c.expiresAt <= now) fail('CHALLENGE_EXPIRED');
      if (c.status === 'sending' && locked.quarantined === true) fail('CHALLENGE_PENDING', 409);
      if (locked.quarantined) fail('SERVICE_UNAVAILABLE', 503);
      if (c.status !== 'sent' || c.attempts >= 5) fail('CHALLENGE_USED', 409);
      const provider = c.provider === undefined ? 'aliyun' : c.provider;
      if (!['aliyun', 'relay'].includes(provider) ||
          (provider === 'relay' && (typeof c.otpMac !== 'string' || !/^[0-9a-f]{64}$/.test(c.otpMac)))) fail('SERVICE_UNAVAILABLE', 503);
      c.status = 'verifying'; c.attempts++;
      await tx.put(key, c);
      return { count: c.attempts, provider, otpMac: c.otpMac };
    });
    if (attempt.recovered) return { success:true, verified:true };
    let providerError;
    try {
      if (attempt.provider === 'relay') {
        if (!await verifyRelayCode(this.env.PHONE_AUTH_HMAC_KEY, attempt.otpMac,
          otpValue(input.challenge_id, phoneHash, input.purpose, input.code))) fail('CODE_INVALID');
      } else {
        await new DypnsapiClient(this.env, { fetchImpl: this.fetchImpl, now: this.now }).check({
          phone, scheme: PURPOSES[input.purpose], outId: input.challenge_id, code: input.code });
      }
    } catch (error) { providerError = error; }
    const expired = await this.transaction(async tx => {
      const now = this.now();
      await this.account(tx, now);
      validate(input, context, 'check', now);
      const c = await tx.get(key);
      if (!c || c.status !== 'verifying' || c.attempts !== attempt.count) fail('SERVICE_UNAVAILABLE', 503);
      const locked = await tx.get(`t:phone:${phoneHash}`);
      if (!locked || locked.challengeId !== input.challenge_id || locked.quarantined) fail('SERVICE_UNAVAILABLE', 503);
      const expired = c.expiresAt <= now;
      c.status = expired ? 'failed' : !providerError ? 'consumed' :
        providerError.code === 'CODE_INVALID' && c.attempts < 5 ? 'sent' : 'failed';
      if (!expired && !providerError && unified) {
        if (await tx.get(proofKey) !== undefined) fail('OPERATION_CONFLICT', 409);
        await tx.put(proofKey, {schema:1, phoneHash, challengeId:input.challenge_id,
          operationId:unified.operationId, expiresAt:now + TTL, deleteAfter:now + TTL + LOCK});
      }
      await tx.put(key, c);
      return expired;
    });
    if (expired) fail('CHALLENGE_EXPIRED');
    if (providerError) throw providerError;
    return { success: true, verified: true };
  }

  async unifiedProof(input, context) {
    if (this.env.PHONE_UNIFIED_LOGIN_ENABLED !== 'true' || !input ||
        !['mark-registration', 'verify', 'send-email'].includes(input.action) ||
        !/^[0-9a-f]{64}$/.test(input.proofHash || '') ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.operationId || '')) fail('INVALID_REQUEST');
    const candidate = {phone:input.phone, purpose:'login', challenge_id:input.challengeId, code:'000000'};
    const now = this.now();
    const normalized = validate(candidate, context, 'check', now);
    const phoneHash = await digest(this.env.PHONE_AUTH_HMAC_KEY, 'phone', normalized.phone);
    return this.transaction(async tx => {
      const now = this.now();
      await this.account(tx, now);
      const key = `t:unified:${input.proofHash}`;
      const item = await tx.get(key);
      if (!item || item.schema !== 1 || item.phoneHash !== phoneHash || item.challengeId !== input.challengeId ||
          item.operationId !== input.operationId || !nonnegative(item.expiresAt) || item.expiresAt <= now)
        fail('CHALLENGE_INVALID', 403);
      // Only a proof whose phone was found unregistered may drive email/registration.
      if (input.action === 'mark-registration') {
        if (item.registration !== true) { item.registration = true; await tx.put(key, item); }
      } else if (item.registration !== true) fail('CHALLENGE_INVALID', 403);
      if (input.action === 'send-email') {
        const sends = item.emailSends ?? 0, next = item.nextEmailAt ?? 0;
        if (!nonnegative(sends) || !nonnegative(next)) fail('SERVICE_UNAVAILABLE', 503);
        if (sends >= 5 || next > now) fail('RATE_LIMITED', 429);
        item.emailSends = sends + 1; item.nextEmailAt = now + 60000;
        await tx.put(key, item);
      }
      return {success:true, expires_in:Math.floor((item.expiresAt - now) / 1000)};
    });
  }

  async fetch(request) {
    try {
      const path = new URL(request.url).pathname;
      if (request.method === 'POST' && path === '/export-ledger') {
        await requireAdmin(this.env, request);
        if (this.env.PHONE_LEDGER_EXPORT_ENABLED !== 'true' ||
            ['PHONE_IDENTITY_ENABLED', 'PHONE_SMS_ENABLED', 'PHONE_NEW_REGISTRATION_ENABLED',
              'PHONE_ACCOUNT_MANAGEMENT_ENABLED', 'PHONE_EMAIL_REAUTH_ENABLED', 'PHONE_TURNSTILE_DIAGNOSTICS_ENABLED',
              'PHONE_LOGIN_EXTRA_CANARY_ENABLED'].some(k => this.env[k] !== 'false')) fail('RELEASE_CONFIG', 503);
        // This exporter understands KV records only. Refuse rather than omit
        // independently created SQL tables or a non-SQLite storage backend.
        if (!this.storage.sql || typeof this.storage.getCurrentBookmark !== 'function') fail('SERVICE_UNAVAILABLE', 503);
        const tables = this.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray();
        if (tables.some(row => row.name !== '_cf_KV'))
          fail('SERVICE_UNAVAILABLE', 503);
        const bookmark = await this.storage.getCurrentBookmark();
        if (typeof bookmark !== 'string' || !bookmark.length) fail('SERVICE_UNAVAILABLE', 503);
        const release = releasePolicy(this.env);
        let config;
        try { config = JSON.parse(this.env.PHONE_AUTH_POLICY); } catch { fail('RELEASE_CONFIG', 503); }
        if (!config || policyFields.some(k => !positive(config[k]))) fail('RELEASE_CONFIG', 503);
        const policy = Object.fromEntries(policyFields.map(k => [k, config[k]]));
        const snapshot = await this.transaction(async tx => {
          const records = []; let startAfter, bytes = 0;
          for (;;) {
            const page = await tx.list({ ...(startAfter === undefined ? {} : { startAfter }), limit: 128 });
            if (!page.size) break;
            for (const [key, value] of page) {
              // All application values must round-trip through JSON. A new
              // unsupported type must fail closed instead of silently changing.
              const encoded = JSON.stringify(value);
              if (typeof key !== 'string' || !jsonValue(value) || typeof encoded !== 'string' ||
                  JSON.stringify(structuredClone(value)) !== encoded || JSON.stringify(JSON.parse(encoded)) !== encoded)
                fail('SERVICE_UNAVAILABLE', 503);
              bytes += new TextEncoder().encode(key).length + new TextEncoder().encode(encoded).length;
              if (bytes > 2097152 || records.length >= 10000) fail('SERVICE_UNAVAILABLE', 503);
              records.push([key, value]); startAfter = key;
            }
            if (page.size < 128) break;
          }
          const alarm = await tx.getAlarm();
          if (alarm !== null && (!nonnegative(alarm))) fail('SERVICE_UNAVAILABLE', 503);
          if (!records.some(([key]) => key === LEDGER_KEY)) fail('SERVICE_UNAVAILABLE', 503);
          return { records, alarm };
        });
        return Response.json({format:'sunland-phone-ledger-v1', ...snapshot, bookmark,
          keyId:this.env.PHONE_AUTH_HMAC_KEY_ID, policy, release},
          {headers:{'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'}});
      }
      if (request.method === 'POST' && path === '/migrate-v2') {
        await requireAdmin(this.env, request);
        if (['PHONE_IDENTITY_ENABLED', 'PHONE_SMS_ENABLED', 'PHONE_NEW_REGISTRATION_ENABLED',
          'PHONE_ACCOUNT_MANAGEMENT_ENABLED', 'PHONE_EMAIL_REAUTH_ENABLED', 'PHONE_TURNSTILE_DIAGNOSTICS_ENABLED',
          'PHONE_LOGIN_EXTRA_CANARY_ENABLED'].some(k => this.env[k] !== 'false')) fail('RELEASE_CONFIG', 503);
        const release = releasePolicy(this.env);
        if (release.mode !== 'canary') fail('RELEASE_CONFIG', 503);
        let oldPolicy;
        try { oldPolicy = JSON.parse(this.env.PHONE_AUTH_POLICY); } catch { fail('RELEASE_CONFIG', 503); }
        if (!oldPolicy || policyFields.some(k => !positive(oldPolicy[k]))) fail('RELEASE_CONFIG', 503);
        const oldFingerprint = await ledgerFingerprint(this.env, oldPolicy, release);
        const target = v2Policy(this.env, 'PHONE_AUTH_V2_POLICY');
        const structure = await structureFingerprint(this.env), operation = await operationFingerprint(this.env, target);
        const result = await this.transaction(async tx => {
          const storedAccount = await tx.get(LEDGER_KEY);
          const original = storedAccount && structuredClone(storedAccount);
          const backup = await tx.get(V1_BACKUP_KEY);
          if (!original) fail('SERVICE_UNAVAILABLE', 503);
          if (original.schema === 2) {
            if (!backup || backup.schema !== 1 || original.structureConfig !== structure || original.operationConfig !== operation ||
                backup.initConfig !== oldFingerprint) fail('OPERATION_CONFLICT', 409);
            const current = await this.account(tx, this.now());
            return {success:true, state:'ready', migrated:false, schema:2, day_count:current.dayCount, total_micros:current.totalMicros};
          }
          if (original.schema !== 1 || backup !== undefined || original.initConfig !== oldFingerprint) fail('OPERATION_CONFLICT', 409);
          // Validate v1 without writing normalized counters back; preserve its complete original bytes as a separate record.
          await this.account(tx, this.now());
          // V1 did not pin operational policy on every send and lacks exact UTC+8
          // timestamps. Preserve all records and conservatively block this day.
          const carriedCount = 100;
          const upgraded = {...original, schema:2, structureConfig:structure, operationConfig:operation,
            day:dayNumber(this.now(), 2), dayCount:carriedCount, dayMicros:0, lastNow:this.now()};
          await tx.put(V1_BACKUP_KEY, original);
          await tx.put(LEDGER_KEY, upgraded);
          return {success:true, state:'ready', migrated:true, schema:2, day_count:carriedCount, total_micros:upgraded.totalMicros};
        });
        return Response.json(result, {headers:{'Cache-Control':'no-store'}});
      }
      if (request.method === 'POST' && ['/initialize', '/status'].includes(path)) {
        await requireAdmin(this.env, request);
        const policy = releasePolicy(this.env);
        const now = this.now();
        if (!nonnegative(now) || !/^[a-zA-Z0-9_-]{1,32}$/.test(this.env.PHONE_AUTH_HMAC_KEY_ID || '') ||
            typeof this.env.PHONE_AUTH_HMAC_KEY !== 'string' || this.env.PHONE_AUTH_HMAC_KEY.length < 32) fail('RELEASE_CONFIG', 503);
        let config;
        try { config = JSON.parse(this.env.PHONE_AUTH_POLICY); } catch { fail('RELEASE_CONFIG', 503); }
        if (!config || policyFields.some(k => !positive(config[k])) || config.dailyLimit > 10000) fail('RELEASE_CONFIG', 503);
        const fingerprint = await ledgerFingerprint(this.env, config, policy);
        const output = await this.transaction(async tx => {
          const stored = await tx.get(LEDGER_KEY);
          const any = (await tx.list({ limit: 1 })).size > 0;
          let state = !stored ? (any ? 'abnormal' : 'uninitialized') :
            ![1, 2].includes(stored.schema) ? 'incompatible' : 'ready';
          let account;
          if (state === 'ready') {
            if (stored.keyId !== this.env.PHONE_AUTH_HMAC_KEY_ID) state = 'incompatible';
          }
          if (state === 'ready') {
            try { account = await this.account(tx, now); }
            catch (error) { if (!(error instanceof PhoneAuthError)) throw error; state = 'abnormal'; }
            if (state === 'ready' && stored.schema === 2) {
              let expected;
              try { expected = policy.mode === 'public' ? v2Policy(this.env, 'PHONE_AUTH_POLICY') : v2Policy(this.env, 'PHONE_AUTH_V2_POLICY'); }
              catch { state = 'incompatible'; }
              if (state === 'ready' && stored.operationConfig !== await operationFingerprint(this.env, expected)) state = 'incompatible';
            } else if (state === 'ready' && stored.initConfig === undefined) state = 'unverified';
            else if (state === 'ready' && (typeof stored.initConfig !== 'string' || !/^[0-9a-f]{64}$/.test(stored.initConfig))) state = 'abnormal';
            else if (state === 'ready' && stored.initConfig !== fingerprint) state = 'incompatible';
          }
          if (path === '/status' && state !== 'ready') return { success: true, state };
          if (path === '/initialize' && state === 'uninitialized') {
            await tx.put(LEDGER_KEY, { schema: 1, enabled: true, keyId: this.env.PHONE_AUTH_HMAC_KEY_ID, initConfig: fingerprint,
              testReserved: 0, totalMicros: 0, day: Math.floor(now / DAY), dayCount: 0, dayMicros: 0,
              minute: Math.floor(now / 60000), minuteCount: 0, lastNow: now });
            account = await this.account(tx, now);
          } else if (path === '/initialize' && (state !== 'ready' || stored.schema !== 1 || stored.initConfig !== fingerprint)) {
            fail('OPERATION_CONFLICT', 409);
          }
          let temporaryUsed = 0, temporaryLimit = 0;
          if (account.schema === 2 && this.env.PHONE_TEMPORARY_SMS_20261119_ENABLED === 'true' &&
              now >= TEMPORARY_START && now < TEMPORARY_END && account.dayCount === 100) {
            let target;
            try { target = policy.mode === 'public' ? v2Policy(this.env, 'PHONE_AUTH_POLICY') : v2Policy(this.env, 'PHONE_AUTH_V2_POLICY'); }
            catch { fail('RELEASE_CONFIG', 503); }
            const marker = await this.temporaryQuota(tx, account, target, now);
            temporaryUsed = marker.used; temporaryLimit = TEMPORARY_LIMIT;
          }
          return { success: true, state: 'ready', schema: account.schema, enabled: account.enabled, mode: policy.mode,
            test_reserved: account.testReserved, total_micros: account.totalMicros,
            day_count: account.dayCount, day_micros: account.dayMicros,
            temporary_limit: temporaryLimit, temporary_used: temporaryUsed };
        });
        return Response.json(output, { headers: { 'Cache-Control': 'no-store' } });
      }
      if (request.method !== 'POST' || !['/send', '/check', '/claim-turnstile', '/unified-check', '/unified-proof'].includes(path)) fail('INVALID_REQUEST');
      if (path === '/claim-turnstile') {
        await requireAdmin(this.env, request);
        if (this.env.PHONE_TURNSTILE_DIAGNOSTICS_ENABLED !== 'true' ||
            ['PHONE_IDENTITY_ENABLED', 'PHONE_SMS_ENABLED', 'PHONE_NEW_REGISTRATION_ENABLED'].some(k => this.env[k] !== 'false')) fail('SERVICE_UNAVAILABLE', 503);
      }
      // Binding transport only; no public route is installed by this module.
      const reader = request.body?.getReader();
      if (!reader) fail('INVALID_REQUEST');
      const parts = []; let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength; if (size > 8192) { void reader.cancel().catch(() => {}); fail('INVALID_REQUEST'); }
          parts.push(value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
      let body;
      try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { fail('INVALID_REQUEST'); }
      if (path === '/claim-turnstile') {
        const token = body?.token;
        if (!body || Object.keys(body).length !== 1 || typeof token !== 'string' || !token.length || token.length > 2048 ||
            typeof this.env.PHONE_AUTH_HMAC_KEY !== 'string' || this.env.PHONE_AUTH_HMAC_KEY.length < 32) fail('INVALID_REQUEST');
        const tokenHash = await digest(this.env.PHONE_AUTH_HMAC_KEY, 'turnstile-token:v1', token);
        const claimed = await this.transaction(async tx => {
          const now = this.now();
          const account = await this.account(tx, now); // Missing ledger must never create markers.
          await tx.put(LEDGER_KEY, account);
          const claimed = await this.claimTurnstile(tx, tokenHash, now);
          await this.cleanup(tx, now);
          return claimed;
        });
        if (!claimed) fail('CAPTCHA_FAILED', 403);
        return Response.json({ success:true }, { headers:{ 'Cache-Control':'no-store' } });
      }
      if (path === '/unified-check' && (!body?.unified || typeof body.unified !== 'object')) fail('INVALID_REQUEST');
      const output = path === '/unified-check' ? await this.check(body?.input, body?.context, body?.unified) :
        path === '/unified-proof' ? await this.unifiedProof(body?.input, body?.context) :
        await this[path.slice(1)](body?.input, body?.context);
      return Response.json(output, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      const safe = error instanceof PhoneAuthError ? error : new PhoneAuthError('SERVICE_UNAVAILABLE', 503);
      return Response.json({ error: safe.message, code: safe.code }, { status: safe.status, headers: { 'Cache-Control': 'no-store' } });
    }
  }
}
