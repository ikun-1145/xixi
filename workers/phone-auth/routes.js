import { PhoneAuthError } from './errors.js';
import { createPhoneIdentity } from './identity.js';
import { sendPhoneCode, checkPhoneCode } from './service.js';

const PREFIX = '/v1/phone/';
const ROUTES = new Set(['send-code', 'verify-code', 'status', 'reauth/email', 'reauth/phone', 'bind', 'change', 'unbind', 'delete-authorize']);
const ACTIONS = new Set(['bind', 'change', 'unbind', 'delete']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const invalid = () => { throw new PhoneAuthError('INVALID_REQUEST'); };
function fields(input, required, optional = []) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      required.some(key => !Object.hasOwn(input, key)) ||
      Object.keys(input).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}
function phone(value) { if (typeof value !== 'string' || !/^(\+86)?1[3-9]\d{9}$/.test(value)) invalid(); }
function code(value) { if (typeof value !== 'string' || !/^\d{6}$/.test(value)) invalid(); }
function uuid(value) { if (typeof value !== 'string' || !UUID.test(value)) invalid(); }
function operationId(value) { if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) invalid(); }
function proof(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value)) invalid(); }
function action(value) { if (!ACTIONS.has(value)) invalid(); }
function challenge(input) { phone(input.phone); code(input.code); uuid(input.challenge_id); }
function sensitive(input) { proof(input.reauth_token); operationId(input.operation_id); }
function ingressIp(request) {
  const value = request.headers.get('CF-Connecting-IP');
  if (typeof value === 'string' && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) && value.split('.').every(x => Number(x) <= 255)) return value;
  if (typeof value === 'string' && /^[0-9a-fA-F:]+$/.test(value) && value.includes(':')) {
    try { return new URL(`https://[${value}]/`).hostname.slice(1, -1); } catch { /* reject invalid IP */ }
  }
  invalid();
}

// Wrap the actual existing Worker. Its helpers remain the only JWT/status/CORS
// authority; unrelated requests are forwarded before the body is touched.
export function createPhoneAuthWorker(existingWorker, hooks, {
  identityFactory = createPhoneIdentity,
  sms = { sendPhoneCode, checkPhoneCode },
  loginOnly = false,
} = {}) {
  return {
    ...existingWorker,
    async fetch(request, env, executionContext) {
      const path = new URL(request.url).pathname;
      const route = path.startsWith(PREFIX) ? path.slice(PREFIX.length) : '';
      if (!ROUTES.has(route) || request.method === 'OPTIONS') return existingWorker.fetch(request, env, executionContext);
      try {
        if (request.method !== 'POST') throw new PhoneAuthError('INVALID_REQUEST', 405);
        if (env?.PHONE_IDENTITY_ENABLED !== 'true') throw new PhoneAuthError('IDENTITY_DISABLED', 503);
        if (loginOnly && ['reauth/email', 'bind', 'change', 'unbind'].includes(route)) throw new PhoneAuthError('IDENTITY_DISABLED', 503);
        if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) invalid();
        const parsed = await hooks.readJsonBodyWithLimit(request, 8192);
        if (parsed?.error) throw new PhoneAuthError('INVALID_REQUEST', parsed.error === 'too_large' ? 413 : 400);
        const input = parsed?.value;
        const identity = identityFactory(env, { rpc: (name, args) => hooks.callIdentityRpc(env, name, args) });
        const rpc = (name, args) => hooks.callIdentityRpc(env, name, args);
        const respond = value => hooks.json(value, 200, env);
        function signingSecret() {
          const secret = hooks.applicationSigningSecret(env);
          if (typeof secret !== 'string' || !secret.trim()) throw new PhoneAuthError('IDENTITY_CONFIG', 503);
          return secret;
        }
        async function authenticated(operation = 'protected') {
          const user = await hooks.getUserFromRequest(request, env);
          const header = request.headers.get('Authorization');
          if (!user?.id || !header?.startsWith('Bearer ') || !header.slice(7)) throw new PhoneAuthError('UNAUTHORIZED', 401);
          const state = await hooks.getUserStatus(env, user.id);
          const rejection = hooks.accountStatusRejection(state, operation);
          if (rejection) throw new PhoneAuthError(['ACCOUNT_NOT_ACTIVE', 'ACCOUNT_BANNED'].includes(rejection.error) ? rejection.error : 'IDENTITY_UNAVAILABLE', rejection.status);
          return { userId: user.id, sessionHash: await identity.sessionHash(header.slice(7)) };
        }
        const context = auth => ({ ip: ingressIp(request), userId: auth.userId, sessionId: auth.sessionHash, identityStatus: 'active' });
        async function currentPhone(auth, value) {
          const current = await identity.status(auth.userId);
          const hash = await identity.phoneHash(value);
          if (!current.phone_hash || current.phone_hash !== hash) throw new PhoneAuthError('REAUTH_INVALID', 403);
          return hash;
        }
        async function recent(auth, purpose) {
          return identity.proof({ ...auth, purpose, reauthToken: input.reauth_token });
        }

        if (route === 'send-code') {
          fields(input, ['phone', 'purpose', 'turnstile_token'], ['reauth_token', 'challenge_id']);
          phone(input.phone);
          if (Object.hasOwn(input, 'challenge_id')) operationId(input.challenge_id);
          if (loginOnly && !['login', 'reauth'].includes(input.purpose)) throw new PhoneAuthError('IDENTITY_DISABLED', 503);
          if (!['login', 'bind', 'change', 'unbind', 'reauth'].includes(input.purpose) ||
              typeof input.turnstile_token !== 'string' || !input.turnstile_token.length || input.turnstile_token.length > 2048) invalid();
          let trusted = { ip: ingressIp(request) };
          if (input.purpose === 'reauth') {
            if (input.reauth_token !== undefined) invalid();
            // Banned active users may prove ownership solely to delete. The
            // requested grant action is checked again by the reauth endpoints.
            const auth = await authenticated('account_delete');
            await currentPhone(auth, input.phone);
            trusted = { ...context(auth), reauthentication: true };
          } else if (input.purpose !== 'login') {
            proof(input.reauth_token);
            const auth = await authenticated();
            const grant = await recent(auth, input.purpose);
            if (input.purpose === 'unbind' && grant.method !== 'email') throw new PhoneAuthError('ALTERNATIVE_LOGIN_REQUIRED', 403);
            trusted = { ...context(auth), reauthenticatedAt: grant.issued_at };
          } else if (input.reauth_token !== undefined) invalid();
          return respond(await sms.sendPhoneCode(env, { phone: input.phone, purpose: input.purpose, turnstile_token: input.turnstile_token,
            ...(Object.hasOwn(input, 'challenge_id') ? { challenge_id: input.challenge_id } : {}) }, trusted));
        }
        if (route === 'verify-code') {
          fields(input, ['phone', 'challenge_id', 'code', 'operation_id']);
          challenge(input); operationId(input.operation_id);
          const secret = signingSecret();
          await sms.checkPhoneCode(env, { phone: input.phone, purpose: 'login', challenge_id: input.challenge_id, code: input.code }, { ip: ingressIp(request) });
          const result = await identity.login({ phone: input.phone, operationId: input.operation_id });
          const state = await hooks.getUserStatus(env, result.user_id);
          const rejection = hooks.accountStatusRejection(state);
          if (rejection) throw new PhoneAuthError(['ACCOUNT_NOT_ACTIVE', 'ACCOUNT_BANNED'].includes(rejection.error) ? rejection.error : 'IDENTITY_UNAVAILABLE', rejection.status);
          const user = { id: result.user_id, email: result.email };
          const token = await hooks.signJWT(user, secret);
          return respond({ token, user, onboarding: result.onboarding, is_new_user: result.is_new_user });
        }
        if (route === 'status') {
          fields(input, []);
          const auth = await authenticated();
          const current = await identity.status(auth.userId);
          return respond({ bound: Boolean(current.phone_hash), phone: current.masked_phone, has_email: typeof current.email === 'string' && Boolean(current.email.trim()) });
        }
        if (route === 'reauth/email' || route === 'reauth/phone') {
          const email = route === 'reauth/email';
          fields(input, email ? ['code', 'action'] : ['phone', 'challenge_id', 'code', 'action']);
          code(input.code); action(input.action);
          if (loginOnly && input.action !== 'delete') throw new PhoneAuthError('IDENTITY_DISABLED', 503);
          if (!email) challenge(input);
          const auth = await authenticated(input.action === 'delete' ? 'account_delete' : 'protected');
          let subject;
          if (email) {
            const current = await identity.status(auth.userId);
            if (typeof current.email !== 'string' || !current.email.trim()) throw new PhoneAuthError('ALTERNATIVE_LOGIN_REQUIRED', 403);
            subject = current.email;
            const otp = hooks.createEmailOtp({ secret: signingSecret(), email: subject, ip: ingressIp(request), rpc });
            const result = await otp.consume(input.code);
            if (result?.code !== 'OK') throw new PhoneAuthError(result?.code === 'THROTTLED' ? 'RATE_LIMITED' : 'CODE_INVALID', result?.code === 'THROTTLED' ? 429 : 400);
          } else {
            if (input.action === 'unbind') throw new PhoneAuthError('ALTERNATIVE_LOGIN_REQUIRED', 403);
            subject = await currentPhone(auth, input.phone);
            await sms.checkPhoneCode(env, { phone: input.phone, purpose: 'reauth', challenge_id: input.challenge_id, code: input.code }, { ...context(auth), reauthentication: true });
          }
          const grant = await identity.issueGrant({ ...auth, purpose: input.action, method: email ? 'email' : 'phone', subject });
          return respond({ reauth_token: grant.reauth_token, expires_in: grant.expires_in });
        }
        if (route === 'bind' || route === 'change') {
          fields(input, ['phone', 'challenge_id', 'code', 'reauth_token', 'operation_id']);
          challenge(input); sensitive(input);
          const auth = await authenticated();
          const grant = await recent(auth, route);
          await sms.checkPhoneCode(env, { phone: input.phone, purpose: route, challenge_id: input.challenge_id, code: input.code }, { ...context(auth), reauthenticatedAt: grant.issued_at });
          await identity.mutate(route, { ...auth, reauthToken: input.reauth_token, phone: input.phone, operationId: input.operation_id });
          return respond({ ok: true });
        }
        fields(input, ['reauth_token', 'operation_id']); sensitive(input);
        const auth = await authenticated(route === 'delete-authorize' ? 'account_delete' : 'protected');
        if (route === 'delete-authorize') {
          const result = await identity.authorizeDelete({ ...auth, reauthToken: input.reauth_token, operationId: input.operation_id });
          return respond({ ok: true, deletion_job_id: result.deletion_job_id, deletion_token: result.deletion_token, expires_in: result.expires_in });
        }
        const grant = await recent(auth, 'unbind');
        if (grant.method !== 'email') throw new PhoneAuthError('ALTERNATIVE_LOGIN_REQUIRED', 403);
        await identity.mutate('unbind', { ...auth, reauthToken: input.reauth_token, operationId: input.operation_id });
        return respond({ ok: true });
      } catch (error) {
        const safe = error instanceof PhoneAuthError ? error : new PhoneAuthError('IDENTITY_UNAVAILABLE', 503);
        return hooks.json({ success: false, code: safe.code, error: safe.message }, safe.status, env);
      }
    },
  };
}
