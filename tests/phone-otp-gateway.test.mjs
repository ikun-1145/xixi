import test from 'node:test';
import assert from 'node:assert/strict';
import { OtpMaintenanceGate } from '../workers/phone-auth/otp-gateway.js';
import { signedAdmission, validAdmission } from '../workers/phone-auth/otp-admission.js';
const token = 'synthetic-independent-operator-32-bytes';
class Storage {
  data = new Map(); tail = Promise.resolve();
  async transaction(fn) {
    const previous = this.tail; let release; this.tail = new Promise(r => { release = r; }); await previous;
    try {
      const data = structuredClone(this.data);
      const result = await fn({ get: async k => data.get(k), put: async (k, v) => data.set(k, v), delete: async k => data.delete(k),
        list: async ({ limit = 32 } = {}) => new Map([...data].slice(0, limit)) });
      this.data = data; return result;
    } finally { release(); }
  }
}
const request = (path, body = {}) => new Request('https://gate.test/__ops/otp/' + path, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
test('missing control with retained pending data cannot reset counts or attest a false drain', async () => {
  const storage = new Storage(); storage.data.set('pending:unknown', { state: 'unknown' });
  const gate = new OtpMaintenanceGate({ storage }, { OTP_GATEWAY_ADMIN_TOKEN: token });
  assert.equal((await gate.fetch(request('status'))).status, 503);
  assert.equal((await gate.fetch(request('attest-legacy', { version: 'f405a850-780d-483f-8942-83e1798711fe', reference: 'synthetic://proof' }))).status, 503);
  assert.equal(storage.data.has('control'), false);
});
test('signature binds action and body; source claim is independently required by the Worker', async () => {
  const secret = 'synthetic-admission-key-at-least-32-bytes';
  const proof = await signedAdmission(secret, '/send-code', '{}', crypto.randomUUID(), 1);
  const make = (path, body) => new Request('https://origin.test' + path, { method: 'POST', headers: { 'X-Sunland-Otp-Admission': proof }, body });
  assert.equal(await validAdmission(secret, make('/send-code', '{}'), '{}'), true);
  assert.equal(await validAdmission(secret, make('/verify-code', '{}'), '{}'), false);
  assert.equal(await validAdmission(secret, make('/send-code', '{"changed":true}'), '{"changed":true}'), false);
});
test('close/reopen generation fences requests still reading their bodies before admission', async () => {
  const storage = new Storage(); let originCalls = 0;
  const gate = new OtpMaintenanceGate({ storage }, { OTP_GATEWAY_ADMIN_TOKEN: token, OTP_GATEWAY_AUTH_KEY: 'synthetic-aba-admission-key-32-bytes', ORIGIN: { fetch() { originCalls++; return Response.json({ ok: true }); } } });
  await gate.fetch(request('status'));
  storage.data.get('control').legacyEvidence = 'synthetic://proof';
  assert.equal((await gate.fetch(request('open', { generation: 1 }))).status, 200);
  let controller, reading;
  const began = new Promise(r => { reading = r; });
  const stream = new ReadableStream({ start(c) { controller = c; }, pull() { reading(); } });
  const pending = gate.fetch(new Request('https://gate.test/send-code', { method: 'POST', body: stream, duplex: 'half' }));
  await began; await new Promise(setImmediate);
  const closed = await (await gate.fetch(request('close'))).json();
  assert.equal(closed.pending, 0);
  assert.equal((await gate.fetch(request('open', { generation: closed.generation }))).status, 200);
  controller.enqueue(new TextEncoder().encode('{}')); controller.close();
  assert.equal((await pending).status, 503); assert.equal(originCalls, 0);
  assert.equal(storage.data.get('control').admitted, 0);
});
