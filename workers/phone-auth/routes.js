import { PhoneAuthError } from './errors.js';
import { createPhoneIdentity } from './identity.js';
import { sendPhoneCode, checkPhoneCode, checkUnifiedPhoneCode, requireUnifiedPhoneProof } from './service.js';
import { validatePhoneEmailConfig } from './email-reauth.js';

const PREFIX = '/v1/phone/';
const ROUTES = new Set(['send-code', 'verify-code', 'unified/verify', 'unified/email/send', 'unified/register', 'status', 'reauth/email/send', 'reauth/email', 'reauth/phone', 'bind', 'change', 'unbind', 'delete-authorize']);
const ACTIONS = new Set(['bind', 'change', 'unbind', 'delete']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const invalid = () => { throw new PhoneAuthError('INVALID_REQUEST'); };
function fields(input, required, optional = []) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      required.some(key => !Object.hasOwn(input, key)) ||
      Object.keys(input).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}
function phone(value) { if (typeof value !== 'string' || !/^(\+86)?1[3-9]\d{9}$/.test(value)) invalid(); }
function email(value) { if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || value !== value.trim().toLowerCase()) invalid(); }
function code(value) { if (typeof value !== 'string' || !/^\d{6}$/.test(value)) invalid(); }
function uuid(value) { if (typeof value !== 'string' || !UUID.test(value)) invalid(); }
function operationId(value) { if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) invalid(); }
function proof(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value)) invalid(); }
async function sha256(value) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join(''); }
async function otpDigest(secret, purpose, value) {
  const enc = new TextEncoder(); const key = await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC',key,enc.encode(`sunland-otp-v1:${purpose}:${value}`)))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
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
  sms = { sendPhoneCode, checkPhoneCode, checkUnifiedPhoneCode, requireUnifiedPhoneProof },
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
        // The configured relay template only covers registration and login.
        // Keep account management and reauthentication closed even if a
        // separate feature switch is accidentally enabled.
        if (env?.PHONE_SMS_PROVIDER === 'relay' && ['reauth/email/send', 'reauth/email', 'reauth/phone', 'bind', 'change', 'unbind'].includes(route))
          throw new PhoneAuthError('IDENTITY_DISABLED', 503);
        const managementEnabled = !loginOnly || env?.PHONE_ACCOUNT_MANAGEMENT_ENABLED === 'true';
        if (!managementEnabled && ['reauth/email/send', 'reauth/email', 'bind', 'change', 'unbind'].includes(route)) throw new PhoneAuthError('IDENTITY_DISABLED', 503);
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

        if (route.startsWith('unified/')) {
          if (env?.PHONE_UNIFIED_LOGIN_ENABLED !== 'true') throw new PhoneAuthError('IDENTITY_DISABLED', 503);
          const common = ['phone','challenge_id','operation_id','proof'];
          fields(input, [...common, ...(route === 'unified/verify' ? ['code'] : ['email']),
            ...(route === 'unified/register' ? ['email_code'] : [])]);
          phone(input.phone); operationId(input.challenge_id); operationId(input.operation_id); proof(input.proof);
          const context = {ip:ingressIp(request)}, proofHash = await sha256(input.proof);
          const proofInput = {phone:input.phone, challengeId:input.challenge_id, operationId:input.operation_id, proofHash};
          async function issueSession(result) {
            const state = await hooks.getUserStatus(env,result.user_id);
            const rejection = hooks.accountStatusRejection(state);
            if (rejection) throw new PhoneAuthError(['ACCOUNT_NOT_ACTIVE','ACCOUNT_BANNED'].includes(rejection.error) ? rejection.error : 'IDENTITY_UNAVAILABLE',rejection.status);
            const user = {id:result.user_id,email:result.email};
            return {token:await hooks.signJWT(user,signingSecret()),user,onboarding:result.onboarding,is_new_user:result.is_new_user};
          }
          if (route === 'unified/verify') {
            code(input.code);
            await sms.checkUnifiedPhoneCode(env,{phone:input.phone,purpose:'login',challenge_id:input.challenge_id,code:input.code},context,
              {proofHash,operationId:input.operation_id});
            try { return respond({status:'authenticated',...await issueSession(await identity.login({phone:input.phone,operationId:input.operation_id}))}); }
            catch (error) {
              if (!(error instanceof PhoneAuthError) || error.code !== 'REGISTRATION_DISABLED') throw error;
              if (env.PHONE_NEW_REGISTRATION_ENABLED !== 'true') throw error;
              const verified = await sms.requireUnifiedPhoneProof(env,{...proofInput,action:'mark-registration'},context);
              return respond({status:'registration_required',expires_in:verified.expires_in});
            }
          }
          if (env.PHONE_NEW_REGISTRATION_ENABLED !== 'true') throw new PhoneAuthError('REGISTRATION_DISABLED',403);
          email(input.email);
          if (route === 'unified/email/send') {
            if (typeof hooks.sendPhoneReauthEmail !== 'function' || typeof hooks.createEmailOtp !== 'function') throw new PhoneAuthError('IDENTITY_CONFIG',503);
            validatePhoneEmailConfig(env);
            await sms.requireUnifiedPhoneProof(env,{...proofInput,action:'send-email',emailHash:await sha256(input.email)},context);
            const otp = hooks.createEmailOtp({secret:signingSecret(),email:`phone-register:v1\0${input.email}`,ip:context.ip,rpc});
            const hash = await identity.phoneHash(input.phone);
            return respond(await hooks.sendPhoneReauthEmail({env,email:input.email,otp,bindCode:value=>JSON.stringify([value,hash,input.challenge_id,input.operation_id])}));
          }
          code(input.email_code);
          await sms.requireUnifiedPhoneProof(env,{...proofInput,action:'verify',emailHash:await sha256(input.email)},context);
          const secret = signingSecret(), subjectEmail = `phone-register:v1\0${input.email}`;
          const subject = await otpDigest(secret,'mail',subjectEmail), ip = await otpDigest(secret,'ip',context.ip);
          const c = await rpc('sunland_otp',{p_action:'challenge',p_subject:subject,p_ip:ip});
          if (c?.ok && c.payload?.code === 'THROTTLED') throw new PhoneAuthError('RATE_LIMITED',429);
          if (!c?.ok || !c.payload || c.payload.code !== 'OK' || !UUID.test(c.payload.request_id || '')) throw new PhoneAuthError('IDENTITY_UNAVAILABLE',503);
          const hash = await identity.phoneHash(input.phone);
          const bound = JSON.stringify([input.email_code,hash,input.challenge_id,input.operation_id]);
          const codeHash = await otpDigest(secret,'code',`${subjectEmail}:${c.payload.request_id}:${bound}`);
          const result = await identity.login({phone:input.phone,email:input.email,operationId:input.operation_id,
            unifiedOtp:{p_subject:subject,p_ip:ip,p_request_id:c.payload.request_id,p_code_hash:codeHash}});
          return respond({status:'authenticated',...await issueSession(result)});
        }

        if (route === 'send-code') {
          fields(input, ['phone', 'purpose', 'turnstile_token'], ['reauth_token', 'challenge_id', 'email', 'operation_id']);
          const registration = Object.hasOwn(input, 'email') || Object.hasOwn(input, 'operation_id');
          let registrationOtp, registrationPhoneHash;
          if (registration) {
            if (input.purpose !== 'login' || env?.PHONE_NEW_REGISTRATION_ENABLED !== 'true') throw new PhoneAuthError('REGISTRATION_DISABLED', 403);
            email(input.email); operationId(input.challenge_id); operationId(input.operation_id);
            if (typeof hooks.sendPhoneReauthEmail !== 'function' || typeof hooks.createEmailOtp !== 'function') throw new PhoneAuthError('IDENTITY_CONFIG', 503);
            validatePhoneEmailConfig(env);
            registrationOtp = hooks.createEmailOtp({ secret: signingSecret(), email: `phone-register:v1\0${input.email}`, ip: ingressIp(request), rpc });
            registrationPhoneHash = await identity.phoneHash(input.phone);
          }
          phone(input.phone);
          if (env?.PHONE_SMS_PROVIDER === 'relay' && input.purpose !== 'login') throw new PhoneAuthError('IDENTITY_DISABLED', 503);
          // Relay sends must remain recoverable even from an old cached login page.
          if (loginOnly && env?.PHONE_SMS_PROVIDER === 'relay' && !Object.hasOwn(input, 'challenge_id')) invalid();
          if (Object.hasOwn(input, 'challenge_id')) operationId(input.challenge_id);
          if (!managementEnabled && !['login', 'reauth'].includes(input.purpose)) throw new PhoneAuthError('IDENTITY_DISABLED', 503);
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
          const sent = await sms.sendPhoneCode(env, { phone: input.phone, purpose: input.purpose, turnstile_token: input.turnstile_token,
            ...(Object.hasOwn(input, 'challenge_id') ? { challenge_id: input.challenge_id } : {}) }, trusted);
          if (registration) {
            await hooks.sendPhoneReauthEmail({ env, email: input.email, otp: registrationOtp, bindCode: value => JSON.stringify([value, registrationPhoneHash, input.challenge_id, input.operation_id]) });
          }
          return respond(sent);
        }
        if (route === 'verify-code') {
          fields(input, ['phone', 'challenge_id', 'code', 'operation_id'], ['email', 'email_code']);
          challenge(input); operationId(input.operation_id);
          const registration = Object.hasOwn(input, 'email') || Object.hasOwn(input, 'email_code');
          const secret = signingSecret();
          if (registration) {
            if (env?.PHONE_NEW_REGISTRATION_ENABLED !== 'true') throw new PhoneAuthError('REGISTRATION_DISABLED', 403);
            email(input.email); code(input.email_code);
            if (typeof hooks.createEmailOtp !== 'function') throw new PhoneAuthError('IDENTITY_CONFIG', 503);
            const otp = hooks.createEmailOtp({ secret, email: `phone-register:v1\0${input.email}`, ip: ingressIp(request), rpc });
            const hash = await identity.phoneHash(input.phone);
            const verified = await otp.consume(JSON.stringify([input.email_code, hash, input.challenge_id, input.operation_id]));
            if (verified?.code !== 'OK') throw new PhoneAuthError(verified?.code === 'THROTTLED' ? 'RATE_LIMITED' : 'CODE_INVALID', verified?.code === 'THROTTLED' ? 429 : 400);
          }
          await sms.checkPhoneCode(env, { phone: input.phone, purpose: 'login', challenge_id: input.challenge_id, code: input.code }, { ip: ingressIp(request) });
          const result = await identity.login({ phone: input.phone, operationId: input.operation_id, ...(registration ? {email: input.email} : {}) });
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
        if (route === 'reauth/email/send') {
          if (!loginOnly || env?.PHONE_EMAIL_REAUTH_ENABLED !== 'true' || typeof hooks.sendPhoneReauthEmail !== 'function' || typeof hooks.createEmailOtp !== 'function') throw new PhoneAuthError('IDENTITY_DISABLED', 503);
          fields(input, ['action']); action(input.action);
          const auth = await authenticated(input.action === 'delete' ? 'account_delete' : 'protected');
          const current = await identity.status(auth.userId);
          if (typeof current.email !== 'string' || !/^\S+@\S+\.\S+$/.test(current.email.trim()) || current.email.trim().length > 254) throw new PhoneAuthError('ALTERNATIVE_LOGIN_REQUIRED', 403);
          const email = current.email.trim().toLowerCase();
          const otp = hooks.createEmailOtp({ secret: signingSecret(), email: `phone-reauth:v1\0${email}`, ip: ingressIp(request), rpc });
          return respond(await hooks.sendPhoneReauthEmail({ env, email, otp, bindCode: value => JSON.stringify([value, auth.userId, auth.sessionHash, input.action]) }));
        }
        if (route === 'reauth/email' || route === 'reauth/phone') {
          const email = route === 'reauth/email';
          fields(input, email ? ['code', 'action'] : ['phone', 'challenge_id', 'code', 'action']);
          code(input.code); action(input.action);
          if (!managementEnabled && input.action !== 'delete') throw new PhoneAuthError('IDENTITY_DISABLED', 503);
          if (!email) challenge(input);
          const auth = await authenticated(input.action === 'delete' ? 'account_delete' : 'protected');
          let subject;
          if (email) {
            const current = await identity.status(auth.userId);
            if (typeof current.email !== 'string' || !current.email.trim()) throw new PhoneAuthError('ALTERNATIVE_LOGIN_REQUIRED', 403);
            subject = current.email;
            if (loginOnly && env?.PHONE_EMAIL_REAUTH_ENABLED !== 'true') throw new PhoneAuthError('IDENTITY_DISABLED', 503);
            const otp = hooks.createEmailOtp({ secret: signingSecret(), email: loginOnly ? `phone-reauth:v1\0${subject.trim().toLowerCase()}` : subject, ip: ingressIp(request), rpc });
            const result = await otp.consume(loginOnly ? JSON.stringify([input.code, auth.userId, auth.sessionHash, input.action]) : input.code);
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
