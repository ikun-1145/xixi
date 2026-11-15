import { PhoneAuthError, requireSmsEnabled } from './errors.js';
import { SINGLETON_NAME } from './coordinator.js';

async function call(env, operation, input, context) {
  requireSmsEnabled(env);
  if (typeof env.PHONE_AUTH_COORDINATOR?.getByName !== 'function') throw new PhoneAuthError('SERVICE_UNAVAILABLE', 503);
  try {
    const response = await env.PHONE_AUTH_COORDINATOR.getByName(SINGLETON_NAME).fetch(new Request(`https://phone-auth.internal/${operation}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input, context }),
    }));
    const output = await response.json();
    if (!response.ok) throw new PhoneAuthError(output?.code || 'SERVICE_UNAVAILABLE', response.status);
    if (output?.success !== true || (operation === 'check' && output.verified !== true)) throw new PhoneAuthError('SERVICE_UNAVAILABLE', 503);
    if (operation === 'check') return { success: true, verified: true };
    if (typeof output.challenge_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(output.challenge_id) ||
        !Number.isInteger(output.expires_in) || output.expires_in < 0 || output.expires_in > 300 ||
        !Number.isInteger(output.retry_after) || output.retry_after < 0 || output.retry_after > 600) {
      throw new PhoneAuthError('SERVICE_UNAVAILABLE', 503);
    }
    return { success: true, challenge_id: output.challenge_id, expires_in: output.expires_in, retry_after: output.retry_after };
  } catch (error) {
    if (error instanceof PhoneAuthError) throw error;
    throw new PhoneAuthError('SERVICE_UNAVAILABLE', 503);
  }
}

// Internal server-only functions. `context` must be produced by the existing
// JWT/status/reauth middleware, never deserialized from a browser request.
export const sendPhoneCode = (env, input, context) => call(env, 'send', input, context);
export const checkPhoneCode = (env, input, context) => call(env, 'check', input, context);
