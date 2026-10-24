import { DypnsapiClient } from './dypnsapi.js';
import { PhoneAuthError, requireSmsEnabled } from './errors.js';
import { requestJson } from './http.js';
import { releasePolicy, allowCanaryRecipient, requireAdmin } from './release-policy.js';

export const SINGLETON_NAME = 'sunland-phone-auth-v1';
export const LEDGER_KEY = 'account';
const DAY = 86400000;
const TTL = 300000;
const LOCK = 600000;
const PURPOSES = Object.freeze({ login: 'sl-login-v1', bind: 'sl-bind-v1', change: 'sl-change-v1',
  unbind: 'sl-unbind-v1', reauth: 'sl-reauth-v1' });
const positive = n => Number.isSafeInteger(n) && n > 0;
const nonnegative = n => Number.isSafeInteger(n) && n >= 0;
const fail = (code, status = 400) => { throw new PhoneAuthError(code, status); };

function settings(env) {
  requireSmsEnabled(env);
  releasePolicy(env);
  let policy;
  try { policy = JSON.parse(env.PHONE_AUTH_POLICY); } catch { fail('SMS_CONFIG', 503); }
  const fields = ['perPhoneDaily', 'perIpDaily', 'dailyLimit', 'unitCostMicros', 'dailyBudgetMicros',
    'totalBudgetMicros', 'ipRequestsPerMinute', 'globalRequestsPerMinute'];
  if (!policy || fields.some(k => !positive(policy[k])) || policy.dailyLimit > 10000 ||
      typeof env.PHONE_AUTH_HMAC_KEY !== 'string' || env.PHONE_AUTH_HMAC_KEY.length < 32 ||
      !/^[a-zA-Z0-9_-]{1,32}$/.test(env.PHONE_AUTH_HMAC_KEY_ID || '') ||
      typeof env.TURNSTILE_SECRET !== 'string' || !env.TURNSTILE_SECRET.trim() ||
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(env.PHONE_TURNSTILE_HOSTNAME || '')) fail('SMS_CONFIG', 503);
  return policy;
}

function validate(input, context, operation, now) {
  const fields = operation === 'send' ? ['phone', 'purpose', 'turnstile_token'] : ['phone', 'purpose', 'challenge_id', 'code'];
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).length !== fields.length || Object.keys(input).some(k => !fields.includes(k)) ||
      !Object.hasOwn(PURPOSES, input.purpose) || typeof input.phone !== 'string') fail('INVALID_REQUEST');
  const phone = input.phone.startsWith('+86') ? input.phone.slice(3) : input.phone;
  if (!/^1[3-9]\d{9}$/.test(phone)) fail('INVALID_REQUEST');
  if (operation === 'send') {
    if (typeof input.turnstile_token !== 'string' || !input.turnstile_token.length || input.turnstile_token.length > 2048) fail('INVALID_REQUEST');
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
    if (!account || account.schema !== 1 || account.enabled !== true || account.keyId !== this.env.PHONE_AUTH_HMAC_KEY_ID ||
        !['testReserved', 'totalMicros', 'day', 'dayCount', 'dayMicros', 'minute', 'minuteCount', 'lastNow'].every(k => nonnegative(account[k])) ||
        account.testReserved > 3 ||
        !nonnegative(now) || now < account.lastNow) fail('SERVICE_UNAVAILABLE', 503);
    account.lastNow = now;
    if (account.day !== Math.floor(now / DAY)) {
      account.day = Math.floor(now / DAY); account.dayCount = 0; account.dayMicros = 0;
    }
    if (account.minute !== Math.floor(now / 60000)) {
      account.minute = Math.floor(now / 60000); account.minuteCount = 0;
    }
    return account;
  }

  async prepare(input, context, operation) {
    const policy = settings(this.env);
    const now = this.now();
    const normalized = validate(input, context, operation, now);
    const [phoneHash, ipHash, principalHash] = await Promise.all([
      digest(this.env.PHONE_AUTH_HMAC_KEY, 'phone', normalized.phone),
      digest(this.env.PHONE_AUTH_HMAC_KEY, 'ip', normalized.ip),
      digest(this.env.PHONE_AUTH_HMAC_KEY, 'principal', normalized.principal),
    ]);
    if (operation === 'send') allowCanaryRecipient(releasePolicy(this.env), phoneHash);
    await this.transaction(async tx => {
      const now = this.now();
      const account = await this.account(tx, now);
      const key = `t:requests:${ipHash}`;
      const previous = await tx.get(key);
      if (previous && (!nonnegative(previous.count) || !nonnegative(previous.minute))) fail('SERVICE_UNAVAILABLE', 503);
      const count = previous?.minute === account.minute ? previous.count : 0;
      if (count >= policy.ipRequestsPerMinute || account.minuteCount >= policy.globalRequestsPerMinute) fail('RATE_LIMITED', 429);
      account.minuteCount++;
      await tx.put(LEDGER_KEY, account);
      await tx.put(key, { minute: account.minute, count: count + 1, deleteAfter: now + 120000 });
      // Bounded opportunistic maintenance, never scans/deletes the account key.
      const cursor = await tx.get('cleanup-cursor');
      const records = await tx.list({ prefix: 't:', startAfter: typeof cursor === 'string' ? cursor : '', limit: 32 });
      for (const [name, value] of records) if (nonnegative(value?.deleteAfter) && value.deleteAfter <= now) await tx.delete(name);
      await tx.put('cleanup-cursor', records.size === 32 ? [...records.keys()].at(-1) : '');
    });
    return { ...normalized, phoneHash, ipHash, principalHash, policy };
  }

  async send(input, context) {
    const prepared = await this.prepare(input, context, 'send');
    const { phone, ip, phoneHash, ipHash, principalHash, policy } = prepared;
    const { status, data } = await requestJson('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: this.env.TURNSTILE_SECRET, response: input.turnstile_token, remoteip: ip }),
    }, { fetchImpl: this.fetchImpl, timeoutMs: Number(this.env.PHONE_API_TIMEOUT_MS ?? 5000) });
    const challengeTime = Date.parse(data?.challenge_ts);
    if (status !== 200 || data?.success !== true || data.hostname !== this.env.PHONE_TURNSTILE_HOSTNAME ||
        data.action !== `phone_${input.purpose}` || !Number.isFinite(challengeTime) ||
        this.now() - challengeTime > TTL || challengeTime - this.now() > 30000) fail('CAPTCHA_FAILED', 403);

    const now = this.now();
    validate(input, context, 'send', now);
    const id = crypto.randomUUID();
    const phoneKey = `t:phone:${phoneHash}`;
    const ipKey = `t:ip:${ipHash}`;
    const challengeKey = `t:challenge:${id}`;
    const challenge = { schema: 1, phoneHash, principalHash, purpose: input.purpose, status: 'sending',
      attempts: 0, expiresAt: now + TTL, deleteAfter: now + LOCK * 2 };
    const reservedAt = await this.transaction(async tx => {
      const now = this.now();
      validate(input, context, 'send', now);
      const account = await this.account(tx, now);
      const release = releasePolicy(this.env);
      allowCanaryRecipient(release, phoneHash);
      if (release.mode === 'canary' && account.testReserved >= 3) fail('CANARY_LIMITED', 429);
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
      if (phoneCount >= policy.perPhoneDaily || ipCount >= policy.perIpDaily) fail('RATE_LIMITED', 429);
      if (account.dayCount >= policy.dailyLimit || account.totalMicros > policy.totalBudgetMicros - policy.unitCostMicros ||
          account.dayMicros > policy.dailyBudgetMicros - policy.unitCostMicros) fail('BUDGET_EXCEEDED', 429);
      account.dayCount++; account.dayMicros += policy.unitCostMicros; account.totalMicros += policy.unitCostMicros;
      if (release.mode === 'canary') account.testReserved++;
      await tx.put(LEDGER_KEY, account);
      await tx.put(phoneKey, { day: account.day, count: phoneCount + 1, lockUntil: now + LOCK,
        challengeId: id, quarantined: true });
      await tx.put(ipKey, { day: account.day, count: ipCount + 1, deleteAfter: now + DAY * 2 });
      await tx.put(challengeKey, { ...challenge, expiresAt: now + TTL, deleteAfter: now + LOCK * 2 });
      return now;
    });

    try {
      await new DypnsapiClient(this.env, { fetchImpl: this.fetchImpl, now: this.now }).send({ phone, scheme: PURPOSES[input.purpose], outId: id });
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

  async check(input, context) {
    const { phone, phoneHash, principalHash } = await this.prepare(input, context, 'check');
    const key = `t:challenge:${input.challenge_id}`;
    const attempt = await this.transaction(async tx => {
      const now = this.now();
      validate(input, context, 'check', now);
      await this.account(tx, now);
      const c = await tx.get(key);
      if (!c || c.schema !== 1 || c.phoneHash !== phoneHash || c.principalHash !== principalHash || c.purpose !== input.purpose) fail('CHALLENGE_INVALID');
      const locked = await tx.get(`t:phone:${phoneHash}`);
      if (!locked || locked.challengeId !== input.challenge_id || locked.quarantined || !nonnegative(locked.lockUntil)) fail('SERVICE_UNAVAILABLE', 503);
      if (!nonnegative(c.expiresAt) || !nonnegative(c.attempts)) fail('SERVICE_UNAVAILABLE', 503);
      if (c.expiresAt <= now) fail('CHALLENGE_EXPIRED');
      if (c.status !== 'sent' || c.attempts >= 5) fail('CHALLENGE_USED', 409);
      c.status = 'verifying'; c.attempts++;
      await tx.put(key, c);
      return c.attempts;
    });
    let providerError;
    try {
      await new DypnsapiClient(this.env, { fetchImpl: this.fetchImpl, now: this.now }).check({
        phone, scheme: PURPOSES[input.purpose], outId: input.challenge_id, code: input.code });
    } catch (error) { providerError = error; }
    const expired = await this.transaction(async tx => {
      const now = this.now();
      await this.account(tx, now);
      validate(input, context, 'check', now);
      const c = await tx.get(key);
      if (!c || c.status !== 'verifying' || c.attempts !== attempt) fail('SERVICE_UNAVAILABLE', 503);
      const locked = await tx.get(`t:phone:${phoneHash}`);
      if (!locked || locked.challengeId !== input.challenge_id || locked.quarantined) fail('SERVICE_UNAVAILABLE', 503);
      const expired = c.expiresAt <= now;
      c.status = expired ? 'failed' : !providerError ? 'consumed' :
        providerError.code === 'CODE_INVALID' && c.attempts < 5 ? 'sent' : 'failed';
      await tx.put(key, c);
      return expired;
    });
    if (expired) fail('CHALLENGE_EXPIRED');
    if (providerError) throw providerError;
    return { success: true, verified: true };
  }

  async fetch(request) {
    try {
      const path = new URL(request.url).pathname;
      if (request.method === 'POST' && ['/initialize', '/status'].includes(path)) {
        await requireAdmin(this.env, request);
        const policy = releasePolicy(this.env);
        const now = this.now();
        if (!nonnegative(now) || !/^[a-zA-Z0-9_-]{1,32}$/.test(this.env.PHONE_AUTH_HMAC_KEY_ID || '') ||
            typeof this.env.PHONE_AUTH_HMAC_KEY !== 'string' || this.env.PHONE_AUTH_HMAC_KEY.length < 32) fail('RELEASE_CONFIG', 503);
        const output = await this.transaction(async tx => {
          if (path === '/initialize') {
            if ((await tx.list({ limit: 1 })).size) fail('OPERATION_CONFLICT', 409);
            await tx.put(LEDGER_KEY, { schema: 1, enabled: true, keyId: this.env.PHONE_AUTH_HMAC_KEY_ID,
              testReserved: 0, totalMicros: 0, day: Math.floor(now / DAY), dayCount: 0, dayMicros: 0,
              minute: Math.floor(now / 60000), minuteCount: 0, lastNow: now });
          }
          const account = await this.account(tx, now);
          return { success: true, schema: account.schema, enabled: account.enabled, mode: policy.mode,
            test_reserved: account.testReserved, total_micros: account.totalMicros,
            day_count: account.dayCount, day_micros: account.dayMicros };
        });
        return Response.json(output, { headers: { 'Cache-Control': 'no-store' } });
      }
      if (request.method !== 'POST' || !['/send', '/check'].includes(path)) fail('INVALID_REQUEST');
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
      const output = await this[path.slice(1)](body?.input, body?.context);
      return Response.json(output, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      const safe = error instanceof PhoneAuthError ? error : new PhoneAuthError('SERVICE_UNAVAILABLE', 503);
      return Response.json({ error: safe.message, code: safe.code }, { status: safe.status, headers: { 'Cache-Control': 'no-store' } });
    }
  }
}
