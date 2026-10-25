import { OTP_PATHS, administrator, signedAdmission, maintenance, boundedText, bodyHash } from './otp-admission.js';
const OTP_GATE_NAME = 'sunland-otp-gate-v1';
const LEGACY_VERSION = 'f405a850-780d-483f-8942-83e1798711fe';
const initial = () => ({ schema: 1, mode: 'BLOCK', authority: 'legacy', generation: 1, admitted: 0, terminal: 0, pending: 0, unknown: 0, legacyEvidence: null });
function valid(s) {
  return s?.schema === 1 && ['BLOCK', 'CANARY', 'OPEN'].includes(s.mode) && ['legacy', 'rpc'].includes(s.authority) &&
    ['generation', 'admitted', 'terminal', 'pending', 'unknown'].every(k => Number.isSafeInteger(s[k]) && s[k] >= 0) &&
    s.generation > 0 && s.admitted === s.terminal + s.pending && s.unknown <= s.pending &&
    (s.legacyEvidence === null || (typeof s.legacyEvidence === 'string' && /^[A-Za-z0-9:/._-]{8,256}$/.test(s.legacyEvidence)));
}
const drained = s => s.mode === 'BLOCK' && s.pending === 0 && s.unknown === 0 && s.legacyEvidence !== null;
const summary = s => ({ mode: s.mode, authority: s.authority, generation: s.generation, admitted: s.admitted, terminal: s.terminal,
  pending: s.pending, unknown: s.unknown, legacy_before_gateway: s.legacyEvidence ? 'EXTERNALLY_ATTESTED' : 'UNKNOWN',
  legacy_evidence_reference: s.legacyEvidence, drained: drained(s) });

// Independent persistent admission authority, never the SMS cost ledger.
export class OtpMaintenanceGate {
  constructor(ctx, env) { this.storage = ctx.storage; this.env = env; }
  async change(fn) {
    return this.storage.transaction(async tx => {
      let s = await tx.get('control');
      if (!s) {
        if ((await tx.list({ limit: 1 })).size) throw Error('Missing control with existing records');
        s = initial();
      }
      if (!valid(s)) throw Error('Invalid gate state');
      const output = await fn(s, tx); await tx.put('control', s); return output;
    });
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    try {
      if (path === '/__internal/claim') {
        if (request.method !== 'POST' || !await administrator(this.env.OTP_GATEWAY_AUTH_KEY, request)) return new Response(null, { status: 401 });
        const input = JSON.parse(await boundedText(request, 4096));
        const accepted = await this.change(async (_s, tx) => {
          if (typeof input.id !== 'string' || !/^[0-9a-f-]{36}$/.test(input.id)) return false;
          const row = await tx.get('pending:' + input.id);
          if (!row || row.claimed || row.state !== 'pending' || row.generation !== input.generation || row.path !== input.path || row.hash !== input.hash || row.authority !== input.authority) return false;
          await tx.put('pending:' + input.id, { ...row, claimed: true }); return true;
        });
        return new Response(null, { status: accepted ? 200 : 409, headers: { 'Cache-Control': 'no-store' } });
      }
      if (path.startsWith('/__ops/otp/')) {
        if (request.method !== 'POST' || !await administrator(this.env.OTP_GATEWAY_ADMIN_TOKEN, request)) return new Response(null, { status: 401 });
        const action = path.slice('/__ops/otp/'.length);
        const input = JSON.parse(await boundedText(request, 4096));
        const result = await this.change(async s => {
          if (action === 'close') { s.mode = 'BLOCK'; s.generation++; }
          else if (action === 'attest-legacy') {
            // An operator must supply the external termination evidence. This is
            // an attestation, not a local proof or a timed reset of UNKNOWN.
            if (s.mode !== 'BLOCK' || input.version !== LEGACY_VERSION ||
                typeof input.reference !== 'string' || !/^[A-Za-z0-9:/._-]{8,256}$/.test(input.reference)) throw Error('Evidence required');
            s.legacyEvidence = input.reference;
          } else if (action === 'resume-legacy') {
            // Cancel a cutover before RPC authority ever became active. This
            // restores the same old authority, and does not attest a drain.
            if (s.mode !== 'BLOCK' || s.authority !== 'legacy' || s.pending || s.unknown || input.generation !== s.generation) throw Error('Cannot resume legacy');
            s.mode = 'OPEN';
          } else if (action === 'switch-rpc') {
            if (!drained(s) || s.authority !== 'legacy' || input.generation !== s.generation) throw Error('Not drained');
            s.authority = 'rpc'; s.generation++;
          } else if (['canary', 'open'].includes(action)) {
            if (!drained(s) || input.generation !== s.generation) throw Error('Not drained');
            if (action === 'canary' && (!this.env.OTP_TEST_EMAIL || !this.env.OTP_TEST_IPS)) throw Error('Canary configuration required');
            s.mode = action === 'open' ? 'OPEN' : 'CANARY';
          } else if (action !== 'status') throw Error('Unknown command');
          return summary(s);
        });
        return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
      }
      if (request.method !== 'POST' || !OTP_PATHS.has(path)) return maintenance();
      const snapshot = await this.change(s => ({ mode: s.mode, generation: s.generation }));
      const { mode } = snapshot;
      if (mode === 'BLOCK') return maintenance();
      // CANARY is private-credential + configured mailbox + trusted edge IP.
      // Header rejection is defence in depth; public requests cannot opt in.
      if (mode === 'CANARY' && (!await administrator(this.env.OTP_GATEWAY_ADMIN_TOKEN, request) ||
          request.headers.has('CF-Worker') || request.headers.get('CF-Connecting-IP') === '2a06:98c0:3600::103')) return maintenance();
      const text = await boundedText(request);
      if (mode === 'CANARY') {
        const email = JSON.parse(text)?.email;
        const ips = (this.env.OTP_TEST_IPS || '').split(',').map(x => x.trim());
        if (typeof email !== 'string' || email.trim().toLowerCase() !== this.env.OTP_TEST_EMAIL.trim().toLowerCase() ||
            ips.includes('*') || !ips.includes(request.headers.get('CF-Connecting-IP'))) return maintenance();
      }
      const id = crypto.randomUUID();
      const hash = await bodyHash(text, this.env.OTP_GATEWAY_AUTH_KEY);
      const generation = await this.change(async (s, tx) => {
        if (s.mode !== mode || s.generation !== snapshot.generation || s.mode === 'BLOCK' || s.pending >= 256) throw Error('Gate closed');
        s.admitted++; s.pending++;
        await tx.put('pending:' + id, { generation: s.generation, state: 'pending', authority: s.authority, path, hash, claimed: false });
        return s.generation;
      });
      let known = false;
      try {
        const headers = new Headers(request.headers);
        headers.delete('Authorization');
        headers.set('X-Sunland-Otp-Admission', await signedAdmission(this.env.OTP_GATEWAY_AUTH_KEY, path, text, id, generation));
        const upstream = await this.env.ORIGIN.fetch(new Request(request, { headers, body: text }));
        const body = await boundedText(upstream, 16384);
        // Reviewed OTP paths await their effects, with no waitUntil. 5xx and
        // transport/body failures remain UNKNOWN; timeout never subtracts work.
        known = upstream.status < 500;
        if (!known) return maintenance();
        return new Response(body, { status: upstream.status, headers: upstream.headers });
      } finally {
        await this.change(async (s, tx) => {
          const row = await tx.get('pending:' + id);
          if (!row) return;
          if (known && row.claimed) { s.pending--; s.terminal++; await tx.delete('pending:' + id); }
          else if (row.state !== 'unknown') { s.unknown++; await tx.put('pending:' + id, { ...row, state: 'unknown' }); }
        });
      }
    } catch { return maintenance(); }
  }
}
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    try {
      if (path.startsWith('/__ops/otp/') || (OTP_PATHS.has(path) && request.method === 'POST')) {
        return await env.OTP_MAINTENANCE.getByName(OTP_GATE_NAME).fetch(request);
      }
      if (path.startsWith('/__ops/phone/')) {
        const action = path.slice('/__ops/phone/'.length);
        if (request.method !== 'POST' || !['initialize', 'status'].includes(action) ||
            !await administrator(env.PHONE_AUTH_ADMIN_TOKEN, request)) return new Response(null, { status: 401 });
        const text = await boundedText(request, 4096);
        return await env.PHONE_AUTH_COORDINATOR.getByName('sunland-phone-auth-v1').fetch(new Request('https://phone-auth.internal/' + action, {
          method: 'POST', headers: request.headers, body: text,
        }));
      }
      if (OTP_PATHS.has(path) && request.method === 'OPTIONS') {
        const blocked = maintenance(); return new Response(null, { status: 204, headers: blocked.headers });
      }
      return await env.ORIGIN.fetch(request);
    } catch { return maintenance(); }
  },
};
