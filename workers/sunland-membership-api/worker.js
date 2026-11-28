import { KEY_PATTERN, MAX_EMAILS, normalizeEmail } from './input.js';

const MAX_BODY_BYTES = 32 * 1024;
const BODY_TIMEOUT_MS = 5000;
const DB_TIMEOUT_MS = 5000;

class RequestError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
  }
}

async function readJson(request) {
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) {
    throw new RequestError(413, 'payload_too_large');
  }
  const contentType = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json' || !request.body) {
    throw new RequestError(400, 'invalid_request');
  }

  const reader = request.body.getReader();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, BODY_TIMEOUT_MS);

  try {
    const bytes = new Uint8Array(MAX_BODY_BYTES);
    let offset = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (timedOut) throw new RequestError(408, 'request_timeout');
      if (done) break;
      if (offset + value.byteLength > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        throw new RequestError(413, 'payload_too_large');
      }
      bytes.set(value, offset);
      offset += value.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset)));
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(400, 'invalid_request');
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

async function checkMembership(env, key, emails, count, fetchRpc) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(env.SUPABASE_PUBLISHABLE_KEY) ||
      !/^slw_rpc_[A-Za-z0-9_-]{43}$/.test(env.MEMBERSHIP_RPC_TOKEN)) {
    throw new RequestError(500, 'internal_error');
  }
  const url = new URL('/rest/v1/rpc/sunland_membership_check', env.SUPABASE_URL);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new RequestError(500, 'internal_error');
  }

  try {
    const response = await fetchRpc(url, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        apikey: env.SUPABASE_PUBLISHABLE_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_worker_token: env.MEMBERSHIP_RPC_TOKEN,
        p_hash: hash,
        p_emails: emails,
        p_count: count,
      }),
      signal: AbortSignal.timeout(DB_TIMEOUT_MS),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new RequestError(503, 'membership_unavailable');
    }
    return await response.json();
  } catch {
    throw new RequestError(503, 'membership_unavailable');
  }
}

export function createWorker({ fetchRpc = fetch, log = entry => console.log(JSON.stringify(entry)) } = {}) {
  return {
    async fetch(request, env) {
      const started = Date.now();
      const requestId = crypto.randomUUID();
      const headers = new Headers({
        'Cache-Control': 'private, no-store, max-age=0',
        'CDN-Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Request-Id': requestId,
      });
      let partner = null;
      let count = 0;
      let outcome;
      const send = (status, body, result = String(status)) => {
        outcome = result;
        return Response.json(body, { status, headers });
      };

      try {
        const { pathname } = new URL(request.url);
        const single = pathname === '/v1/membership/verify';
        const batch = pathname === '/v1/membership/batch';
        const health = pathname === '/health';
        if (!single && !batch && !health) throw new RequestError(404, 'not_found');
        const method = health ? 'GET' : 'POST';
        if (request.method !== method) {
          headers.set('Allow', method);
          throw new RequestError(405, 'method_not_allowed');
        }
        if (health) return send(200, { status: 'ok' });

        const auth = /^Bearer (\S+)$/i.exec(request.headers.get('authorization') || '');
        if (!auth || !KEY_PATTERN.test(auth[1])) throw new RequestError(401, 'invalid_api_key');
        const body = await readJson(request);
        const field = single ? 'email' : 'emails';
        if (!body || typeof body !== 'object' || Array.isArray(body) ||
            Object.keys(body).length !== 1 || !Object.hasOwn(body, field)) {
          throw new RequestError(400, 'invalid_request');
        }
        const input = single ? [body.email] : body.emails;
        if (!Array.isArray(input) || input.length === 0 || input.length > MAX_EMAILS) {
          throw new RequestError(400, 'invalid_batch_size');
        }
        count = input.length;
        const normalized = input.map(normalizeEmail);
        if (normalized.includes(null)) throw new RequestError(400, 'invalid_email');
        const emails = [...new Set(normalized)];

        const result = await checkMembership(env, auth[1], emails, count, fetchRpc);
        if (typeof result?.partner === 'string' && /^[a-z0-9][a-z0-9_-]{0,47}$/.test(result.partner)) {
          partner = result.partner;
        }
        switch (result?.status) {
          case 400:
            if (!partner) throw new RequestError(500, 'internal_error');
            throw new RequestError(400, 'invalid_batch_size');
          case 401: throw new RequestError(401, 'invalid_api_key');
          case 403: throw new RequestError(403, 'access_disabled');
          case 429:
            if (!Number.isInteger(result.retry_after) || result.retry_after < 1 || result.retry_after > 86400) {
              throw new RequestError(500, 'internal_error');
            }
            headers.set('Retry-After', String(result.retry_after));
            throw new RequestError(429, 'rate_limited');
          case 503: throw new RequestError(503, 'membership_unavailable');
          case 200: {
            if (!partner || !Array.isArray(result.results) || result.results.length !== emails.length ||
                !emails.every((email, i) => result.results[i]?.email === email &&
                  typeof result.results[i]?.is_pro === 'boolean')) {
              throw new RequestError(500, 'internal_error');
            }
            const results = result.results.map(({ email, is_pro }) => ({ email, is_pro }));
            return send(200, single ? { success: true, is_pro: results[0].is_pro } :
              { success: true, results }, result.anomaly === true ? '200_anomalous_access' : '200');
          }
          default: throw new RequestError(500, 'internal_error');
        }
      } catch (error) {
        const status = error instanceof RequestError ? error.status : 500;
        const code = error instanceof RequestError ? error.message : 'internal_error';
        if (status === 401) headers.set('WWW-Authenticate', 'Bearer realm="sunland-membership"');
        return send(status, { success: false, error: { code }, request_id: requestId }, `${status}_${code}`);
      } finally {
        log({ partner, time: new Date(started).toISOString(), count, duration_ms: Date.now() - started,
          request_id: requestId, outcome });
      }
    },
  };
}

export default createWorker();
