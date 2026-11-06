import { getUserFromRequest, getUserStatus, accountStatusRejection, applicationSigningSecret,
  signJWT, callIdentityRpc, readJsonBodyWithLimit, json } from 'sunland-production-auth-helpers';
import { createPhoneAuthWorker } from './routes.js';
import { requireAdmin } from './release-policy.js';
import { PhoneAuthError } from './errors.js';
import { turnstileProbe } from './turnstile-probe.js';
export { PhoneAuthCoordinator } from './coordinator.js';
const hooks = { getUserFromRequest, getUserStatus, accountStatusRejection, applicationSigningSecret,
  signJWT, callIdentityRpc, readJsonBodyWithLimit, json };
const worker = createPhoneAuthWorker({ fetch(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: json({}, 200, env).headers });
  return json({ error: 'Not found' }, 404, env);
} }, hooks, { loginOnly: true });

export default { async fetch(request, env, ctx) {
  const path = new URL(request.url).pathname;
  if (path.startsWith('/v1/phone/_admin/')) {
    if (path === '/v1/phone/_admin/turnstile-probe') return turnstileProbe(request, env, { readBody: readJsonBodyWithLimit });
    try {
      if (request.method !== 'POST' || !['/v1/phone/_admin/initialize', '/v1/phone/_admin/status'].includes(path)) return json({ error: 'Not found' }, 404, env);
      await requireAdmin(env, request);
      const parsed = await readJsonBodyWithLimit(request, 4096);
      if (parsed.error) return json({ error: 'Invalid request' }, 400, env);
      const result = await env.PHONE_AUTH_COORDINATOR.getByName('sunland-phone-auth-v1').fetch(new Request('https://phone-auth.internal/' + path.split('/').at(-1), {
        method: 'POST', headers: { Authorization: request.headers.get('Authorization'), 'Content-Type': 'application/json' }, body: JSON.stringify(parsed.value),
      }));
      return json(await result.json(), result.status, env);
    } catch (error) { return json({ error: 'Unauthorized or unavailable' }, error instanceof PhoneAuthError ? error.status : 503, env); }
  }
  return worker.fetch(request, env, ctx);
} };
