import { fetchWithTimeout } from './worker.js';
import { ProofError } from './payment-proof.js';

const RPCS = new Set(['sunland_waffo_register_intent', 'sunland_waffo_apply_event', 'sunland_waffo_status']);
export async function productionRpc(env, name, body) {
  const key = env.WAFFO_PRODUCTION_SERVICE_ROLE_KEY;
  if (!RPCS.has(name) || !key || key === env.SUPABASE_ANON_KEY) throw new ProofError('entitlement_configuration');
  const headers = { 'Content-Type': 'application/json', 'Content-Profile': 'public', 'Accept-Profile': 'public', apikey: key };
  // Modern sb_secret keys are gateway API keys, not JWTs. Legacy service_role is a JWT.
  if (!key.startsWith('sb_secret_')) headers.Authorization = `Bearer ${key}`;
  try {
    const response = await fetchWithTimeout(`https://klyrasrqgxijwrxuoevj.supabase.co/rest/v1/rpc/${name}`, {
      method: 'POST', redirect: 'error', headers, body: JSON.stringify(body),
    });
    if (!response.ok) throw new ProofError(response.status === 409 ? 'entitlement_conflict' : 'entitlement_http');
    const result = await response.json();
    if (!result || typeof result !== 'object' || Array.isArray(result)
      || !Number.isSafeInteger(result.version) || result.version < 0
      || typeof result.paymentConfirmed !== 'boolean'
      || ![null, 'pending', 'granted', 'revoked'].includes(result.entitlementState)) throw new ProofError('entitlement_response');
    if (result.entitlementState === 'granted' && !result.paymentConfirmed) throw new ProofError('entitlement_response');
    return result;
  } catch (error) {
    if (error instanceof ProofError) throw error;
    throw new ProofError('entitlement_unavailable');
  }
}
