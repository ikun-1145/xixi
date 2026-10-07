import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync, createSign, createVerify, createHash } from 'node:crypto';
import worker from '../workers/waffopay/worker.js';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ref = '11111111-1111-4111-8111-111111111111';
const secondRef = '22222222-2222-4222-8222-222222222222';
const SERVICE = 'synthetic-service-role';
const RPC = 'https://klyrasrqgxijwrxuoevj.supabase.co/rest/v1/rpc/';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PINNED = { mode: 'prod', merchant_id: 'MER_synthetic', store_id: 'STO_prod', product_id: 'PROD_prod', currency: 'CNY' };
const CLOSED = ['refunded', 'revoked'];
const read = name => readFileSync(new URL(`../workers/waffopay/production-backend/${name}`, import.meta.url), 'utf8');
const incident = JSON.parse(readFileSync(new URL('./fixtures/waffo-production-first-payment.json', import.meta.url), 'utf8'));

// In-memory mirror of the Supabase RPC contract (SQL itself is covered by verify-source-rpc.mjs on PGlite).
class PgError extends Error { constructor(status, message) { super(message); this.status = status; } }
function registerIntent(sb, i) {
  if (!i || !UUID.test(i.payment_reference || '') || !UUID.test(i.request_key || '') || i.amount_minor !== 1500
    || Object.entries(PINNED).some(([key, value]) => i[key] !== value)) throw new PgError(400, 'WAFFO_INVALID_INTENT');
  if (!sb.users.get(i.user_id)?.active) throw new PgError(403, 'ACCOUNT_NOT_ACTIVE');
  const existing = [...sb.intents].find(([, v]) => v.user === i.user_id && v.request === i.request_key);
  if (!existing && sb.intents.has(i.payment_reference)) throw new PgError(409, 'duplicate key');
  if (!existing) sb.intents.set(i.payment_reference, { user: i.user_id, request: i.request_key });
  return { status: existing ? 'duplicate' : 'registered', paymentReference: existing ? existing[0] : i.payment_reference,
    paymentConfirmed: false, entitlementState: 'pending', version: 0 };
}
function view(order, status) {
  return { ...(status ? { status } : {}), paymentConfirmed: !!order && order.confirmed && !CLOSED.includes(order.state),
    entitlementState: order ? (CLOSED.includes(order.state) ? 'revoked' : order.state) : null, version: order?.version ?? 0 };
}
function applyEvent(sb, p) {
  const type = p?.event_type, id = p?.event_id;
  if (!p || !UUID.test(p.payment_reference || '') || Object.entries(PINNED).some(([key, value]) => p[key] !== value)
    || !['order.completed', 'refund.succeeded', 'refund.failed'].includes(type) || !/^[a-f0-9]{64}$/.test(p.event_sha256 || '')
    || !/^ORD_[A-Za-z0-9]+$/.test(p.order_id || '') || !/^PAY_[A-Za-z0-9]+$/.test(p.payment_id || '')
    || !/^[A-Za-z0-9_-]{1,128}$/.test(id || '')) throw new PgError(400, 'WAFFO_INVALID_EVENT');
  if (type === 'order.completed') {
    if (id !== p.payment_id || p.payment_status !== 'succeeded' || p.order_status !== 'completed' || p.amount_minor !== 1500
      || p.charged_minor !== 1500 || !/^[a-f0-9]{64}$/.test(p.proof_sha256 || '') || typeof p.entitlement_enabled !== 'boolean') {
      throw new PgError(400, 'WAFFO_INVALID_PAYMENT_PROOF');
    }
  } else if (p.refund_status !== (type === 'refund.succeeded' ? 'succeeded' : 'failed')) throw new PgError(400, 'WAFFO_INVALID_REFUND_PROOF');
  const user = sb.users.get(p.user_id);
  if (!user?.active) throw new PgError(403, 'ACCOUNT_NOT_ACTIVE');
  if (sb.intents.get(p.payment_reference)?.user !== p.user_id) throw new PgError(400, 'WAFFO_INTENT_USER_MISMATCH');
  if (!sb.orders.has(p.order_id)) {
    if ([...sb.orders.values()].some(o => o.payment_id === p.payment_id || o.ref === p.payment_reference)) throw new PgError(409, 'duplicate key');
    sb.orders.set(p.order_id, { payment_id: p.payment_id, ref: p.payment_reference, user: p.user_id, proof: null, confirmed: false, state: 'pending', version: 1 });
  }
  const order = sb.orders.get(p.order_id);
  if (order.payment_id !== p.payment_id || order.ref !== p.payment_reference || order.user !== p.user_id) throw new PgError(400, 'WAFFO_ORDER_BINDING_CONFLICT');
  const old = sb.events.get(`${type}|${id}`);
  if (old && (old.sha !== p.event_sha256 || old.order !== p.order_id)) throw new PgError(400, 'WAFFO_EVENT_CONFLICT');
  if (!old) sb.events.set(`${type}|${id}`, { sha: p.event_sha256, order: p.order_id });
  let changed = false, result = 'recorded';
  if (type === 'refund.succeeded') {
    if (order.state !== 'refunded') {
      Object.assign(order, { state: 'refunded', confirmed: false, version: order.version + 1 });
      if (sb.sources.has(`waffo|${p.order_id}`)) sb.sources.get(`waffo|${p.order_id}`).active = false;
      changed = true;
    }
    result = 'refunded';
  } else if (type === 'order.completed' && !CLOSED.includes(order.state)) {
    if (!order.confirmed) Object.assign(order, { confirmed: true, proof: p.proof_sha256, version: order.version + 1 });
    else if (order.proof !== p.proof_sha256) throw new PgError(400, 'WAFFO_PAYMENT_PROOF_CONFLICT');
    if (p.entitlement_enabled && order.state === 'pending') {
      if (sb.sources.has(`waffo|${p.order_id}`)) throw new PgError(409, 'duplicate key');
      sb.sources.set(`waffo|${p.order_id}`, { user: p.user_id, active: true });
      Object.assign(order, { state: 'granted', version: order.version + 1 });
      changed = true;
    }
    result = order.state === 'granted' ? 'granted' : 'recorded';
  } else if (CLOSED.includes(order.state)) result = order.state;
  if (changed) user.pro = [...sb.sources.values()].some(s => s.user === p.user_id && s.active);
  return view(order, old && !changed ? 'duplicate' : result);
}
function status(sb, { p_user_id, p_request_key }) {
  const intent = sb.users.get(p_user_id)?.active ? [...sb.intents].find(([, v]) => v.user === p_user_id && v.request === p_request_key) : null;
  return view(intent ? [...sb.orders.values()].find(o => o.ref === intent[0]) : null);
}
function rpc(sb, name, init) {
  if (init.method !== 'POST' || init.headers.apikey !== SERVICE || init.headers.Authorization !== `Bearer ${SERVICE}`) return Response.json({}, { status: 401 });
  const body = JSON.parse(init.body);
  sb.calls.push([name, body]);
  const failure = name === 'sunland_waffo_apply_event' ? sb.fail.shift() : undefined;
  if (failure === 'before') return Response.json({}, { status: 503 });
  // One PG transaction: any raised error rolls back every write.
  const snapshot = structuredClone([sb.users, sb.intents, sb.orders, sb.events, sb.sources]);
  try {
    const handler = { sunland_waffo_register_intent: () => registerIntent(sb, body.p_intent),
      sunland_waffo_apply_event: () => applyEvent(sb, body.p_event), sunland_waffo_status: () => status(sb, body) }[name];
    if (!handler) return Response.json({}, { status: 404 });
    const result = handler();
    // Commit succeeded, response lost (crash / timeout after PG commit).
    return failure === 'after' ? Response.json({}, { status: 503 }) : Response.json(result);
  } catch (error) {
    [sb.users, sb.intents, sb.orders, sb.events, sb.sources] = snapshot;
    if (error instanceof PgError) return Response.json({ message: error.message }, { status: error.status });
    throw error;
  }
}

function proofData(provider) {
  return { merchant: { id: 'MER_synthetic', storeMerchants: [{ store: { id: 'STO_prod' } }] },
    onetimeOrder: { id: 'ORD_one', store: { id: 'STO_prod' }, onetimeProduct: { id: provider.productId }, testMode: false,
      currency: 'CNY', status: provider.status, orderMerchantExternalId: ref,
      payments: [{ id: 'PAY_one', status: 'succeeded', refunds: provider.refunds }] } };
}
function world({ enabled = 'true', otherSource = false } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(read('schema.sql')); sqlite.exec(read('outbox.sql'));
  const statement = (sql, args) => ({ sql, args,
    async run() { const result = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(result.changes) } }; },
    async first() { return sqlite.prepare(sql).get(...args) || null; },
    async all() { return { results: sqlite.prepare(sql).all(...args) }; } });
  const db = { prepare(sql) { return { bind(...args) { return statement(sql, args); } }; },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { for (const s of statements) sqlite.prepare(s.sql).run(...s.args); sqlite.exec('COMMIT'); } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    } };
  const env = { WAFFO_ENVIRONMENT: 'test', WAFFO_PRODUCTION_ENABLED: 'true', WAFFO_PRODUCTION_ENTITLEMENT_ENABLED: enabled,
    WAFFO_PROD_MERCHANT_ID: 'MER_synthetic', WAFFO_PROD_STORE_ID: 'STO_prod', WAFFO_PROD_PRODUCT_ID: 'PROD_prod',
    WAFFO_PRIVATE_KEY_PRODUCTION: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    WAFFO_PRIVATE_KEY_TEST: other.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    WAFFO_WEBHOOK_PUBLIC_KEY_PROD: keys.publicKey.export({ type: 'spki', format: 'pem' }),
    WAFFO_WEBHOOK_PUBLIC_KEY_TEST: other.publicKey.export({ type: 'spki', format: 'pem' }),
    WAFFO_PRODUCTION_SERVICE_ROLE_KEY: SERVICE, SUPABASE_ANON_KEY: 'synthetic-anon', WAFFO_PRODUCTION_LEDGER: db,
    WAFFO_IDENTITY_SERVICE: { fetch: (url, options) => globalThis.fetch(url, options) } };
  const sb = { users: new Map([['fixture-user', { active: true, pro: otherSource }], ['other-user', { active: true, pro: false }]]),
    intents: new Map(), orders: new Map(), events: new Map(), sources: new Map(), calls: [], fail: [] };
  // An Afdian/activation/manual grant captured by the profile trigger as an 'other' source.
  if (otherSource) sb.sources.set('other|profile:fixture-user', { user: 'fixture-user', active: true });
  return { sqlite, env, sb, provider: { refunds: [], productId: 'PROD_prod', status: 'completed' },
    identity: { identity_status: 'active', user_id: 'fixture-user' }, sessions: [], logs: [] };
}
async function run(w, fn) {
  const previous = globalThis.fetch, previousLog = console.error;
  globalThis.fetch = async (url, init = {}) => {
    if (url === 'https://api.sunland.dev/v1/account/identity') return Response.json(w.identity);
    if (url === 'https://api.waffo.ai/v1/graphql') {
      const canonical = `POST\n/v1/graphql\n${init.headers['X-Timestamp']}\n${createHash('sha256').update(init.body).digest('base64')}`;
      const variables = JSON.parse(init.body).variables;
      // Production GraphQL is signed with the Production key only and never receives Supabase credentials.
      if (!createVerify('RSA-SHA256').update(canonical).verify(keys.publicKey, init.headers['X-Signature'], 'base64')
        || init.headers.apikey || init.headers.Authorization || variables.id !== 'ORD_one' || variables.merchant !== 'MER_synthetic') {
        return Response.json({}, { status: 401 });
      }
      // Live Production introspection requires String!, despite documentation examples using ID!.
      const query = JSON.parse(init.body).query;
      const types = Object.fromEntries(incident.queryArguments.map(field =>
        [field.name === 'merchant' ? 'merchant' : 'id', field.args[0].type.ofType.name]));
      if (Object.entries(types).some(([name, type]) => !query.includes(`$${name}: ${type}!`))) {
        return Response.json(incident.invalidIdResponse);
      }
      if (w.provider.graphqlErrors) return Response.json(incident.invalidIdResponse);
      return Response.json({ data: proofData(w.provider) });
    }
    if (url === 'https://api.waffo.ai/v1/actions/checkout/create-session') {
      w.sessions.push(init);
      return Response.json({ data: { checkoutUrl: 'https://checkout.waffo.ai/synthetic' } });
    }
    if (url.startsWith(RPC)) return rpc(w.sb, url.slice(RPC.length), init);
    throw new Error('unexpected network ' + url);
  };
  console.error = value => w.logs.push(String(value));
  try { return await fn(); } finally {
    globalThis.fetch = previous; console.error = previousLog; w.sqlite.close();
    assert.equal(w.logs.join('').includes(SERVICE), false);
  }
}
function event() { return { id: 'delivery1', eventId: 'PAY_one', eventType: 'order.completed', mode: 'prod',
  storeId: 'STO_prod', timestamp: Date.now(), data: { orderMerchantExternalId: ref, orderId: 'ORD_one',
    paymentId: 'PAY_one', orderStatus: 'completed', paymentStatus: 'succeeded', currency: 'CNY',
    chargedAmount: '15.00', listPrice: { subtotal: '15.00', total: '15.00', taxAmount: '0.00' } } }; }
// Waffo refund webhooks carry order binding fields; paymentId may be absent.
function refund(eventId = 'rf-1', eventType = 'refund.succeeded') { return { id: 'delivery-' + eventId, eventId, eventType, mode: 'prod',
  storeId: 'STO_prod', timestamp: Date.now(), data: { orderMerchantExternalId: ref, orderId: 'ORD_one', currency: 'CNY',
    refundStatus: eventType === 'refund.succeeded' ? 'succeeded' : 'failed', refundedAmount: '15.00' } }; }
function signed(body, key = keys.privateKey, timestamp = Date.now()) {
  const raw = JSON.stringify(body);
  const signature = createSign('RSA-SHA256').update(`${timestamp}.${raw}`).sign(key, 'base64');
  return new Request('https://waffopay.sunland.dev/webhook/waffo', { method: 'POST', body: raw,
    headers: { 'Content-Type': 'application/json', 'X-Waffo-Signature': `t=${timestamp},v1=${signature}` } });
}
function seed(w) {
  w.sqlite.prepare(`INSERT INTO payment_intents VALUES (?,'prod','fixture-user','STO_prod','PROD_prod','CNY',1500,?,1)`).run(ref, ref);
  w.sb.intents.set(ref, { user: 'fixture-user', request: ref });
}
async function deliver(w, body) { const response = await worker.fetch(signed(body), w.env); return [response.status, await response.json()]; }
const outbox = (w, type = 'order.completed', id = 'PAY_one') =>
  w.sqlite.prepare('SELECT state,attempt_count,last_error FROM production_outbox WHERE event_type=? AND event_id=?').get(type, id);
const applies = w => w.sb.calls.filter(([name]) => name === 'sunland_waffo_apply_event').length;
async function cron(w) {
  w.sqlite.prepare('UPDATE production_outbox SET updated_at=0').run();
  const waits = [];
  await worker.scheduled({}, w.env, { waitUntil: promise => waits.push(promise) });
  await Promise.all(waits);
}
const granted = { ok: true, status: 'granted', paymentConfirmed: true, entitlementState: 'granted', version: 3, entitlementEnabled: true };

test('first Production payload survives GraphQL failure; cron recovers and replay keeps one source', async () => {
  const w = world({ otherSource: true }); seed(w);
  await run(w, async () => {
    const body = structuredClone(incident.webhook);
    assert.equal(typeof body.timestamp, 'string');
    assert.equal(body.data.productId, undefined);
    assert.equal(body.data.orderMetadata.payment_reference, ref);
    assert.deepEqual(proofData(w.provider), incident.graphql.data);
    w.provider.graphqlErrors = true;
    assert.deepEqual(await deliver(w, body), [503, { ok: false, reason: 'proof_response' }]);
    assert.equal(outbox(w).state, 'pending');
    assert.equal(applies(w), 0);
    w.provider.graphqlErrors = false;
    await cron(w);
    assert.equal(outbox(w).state, 'delivered');
    assert.equal(outbox(w).last_error, null);
    assert.equal(w.sb.sources.get('waffo|ORD_one').active, true);
    assert.equal(w.sb.sources.get('other|profile:fixture-user').active, true);
    assert.deepEqual(await deliver(w, body), [200, { ...granted, status: 'duplicate' }]);
    assert.equal(w.sb.events.size, 1);
    assert.equal(w.sb.orders.get('ORD_one').version, 3);
    assert.equal(w.sb.sources.size, 2);
  });
});

test('trusted completion grants one Waffo source; replay is duplicate; mutated body conflicts before Supabase', async () => {
  const w = world(); seed(w);
  await run(w, async () => {
    const body = event();
    assert.deepEqual(await deliver(w, body), [200, granted]);
    assert.equal(w.sb.users.get('fixture-user').pro, true);
    assert.deepEqual([...w.sb.sources.keys()], ['waffo|ORD_one']);
    assert.equal(outbox(w).state, 'delivered');
    assert.deepEqual(await deliver(w, { ...body, id: 'delivery2', timestamp: body.timestamp + 100 }),
      [200, { ...granted, status: 'duplicate' }]);
    const before = applies(w);
    assert.equal((await deliver(w, { ...body, data: { ...body.data, chargedAmount: '16.00' } }))[0], 409);
    assert.equal(applies(w), before);
    assert.equal(w.sqlite.prepare('SELECT count(*) AS n FROM event_ledger').get().n, 1);
    assert.equal(w.sqlite.prepare('SELECT bound_reference FROM event_ledger').get().bound_reference, ref);
    assert.equal(w.sb.orders.get('ORD_one').version, 3);
  });
});

test('entitlement disabled confirms payment without granting; a later enabled replay grants exactly once', async () => {
  const w = world({ enabled: 'false' }); seed(w);
  await run(w, async () => {
    assert.deepEqual(await deliver(w, event()), [200, { ok: true, status: 'recorded', paymentConfirmed: true,
      entitlementState: 'pending', version: 2, entitlementEnabled: false }]);
    assert.equal(w.sb.sources.size, 0); assert.equal(w.sb.users.get('fixture-user').pro, false);
    w.env.WAFFO_PRODUCTION_ENTITLEMENT_ENABLED = 'true';
    assert.deepEqual(await deliver(w, { ...event(), id: 'delivery2' }), [200, granted]);
    assert.equal(w.sb.sources.size, 1);
  });
});

for (const otherSource of [false, true]) test(`refund revokes only its Waffo order source (other source: ${otherSource})`, async () => {
  const w = world({ otherSource }); seed(w);
  await run(w, async () => {
    assert.equal((await deliver(w, event()))[1].status, 'granted');
    w.provider.refunds = [{ id: 'rf-0', status: 'failed' }];
    assert.equal((await deliver(w, refund('rf-0', 'refund.failed')))[1].status, 'recorded');
    assert.equal(w.sb.sources.get('waffo|ORD_one').active, true);
    w.provider.refunds.push({ id: 'rf-1', status: 'succeeded' });
    assert.deepEqual(await deliver(w, refund()), [200, { ok: true, status: 'refunded', paymentConfirmed: false,
      entitlementState: 'revoked', version: 4, entitlementEnabled: true }]);
    assert.equal(w.sb.sources.get('waffo|ORD_one').active, false);
    assert.equal(w.sb.users.get('fixture-user').pro, otherSource);
    if (otherSource) assert.equal(w.sb.sources.get('other|profile:fixture-user').active, true);
    // A replayed completion after the tombstone can never re-grant.
    assert.equal((await deliver(w, { ...event(), id: 'delivery-late' }))[1].entitlementState, 'revoked');
    w.provider.refunds = [];
    assert.deepEqual(await deliver(w, { ...event(), id: 'delivery-lag' }), [200, { ok: true, status: 'duplicate',
      paymentConfirmed: false, entitlementState: 'revoked', version: 4, entitlementEnabled: true }]);
    assert.equal(w.sb.users.get('fixture-user').pro, otherSource);
  });
});

test('refund delivered before completion tombstones the order; late completion never grants', async () => {
  const w = world(); seed(w);
  w.provider.refunds = [{ id: 'rf-1', status: 'succeeded' }];
  await run(w, async () => {
    assert.equal((await deliver(w, refund()))[1].status, 'refunded');
    const [code, body] = await deliver(w, event());
    assert.equal(code, 200); assert.equal(body.entitlementState, 'revoked'); assert.equal(body.paymentConfirmed, false);
    assert.equal(w.sb.sources.size, 0); assert.equal(w.sb.users.get('fixture-user').pro, false);
    assert.equal(w.sb.calls.some(([name, b]) => name === 'sunland_waffo_apply_event' && b.p_event.event_type === 'order.completed'), false);
  });
});

test('missed refund webhook: any later event converges on the GraphQL refund record and revokes', async () => {
  const w = world(); seed(w);
  await run(w, async () => {
    assert.equal((await deliver(w, event()))[1].status, 'granted');
    w.provider.refunds = [{ id: 'arbitrary_refund-ID', status: 'succeeded' }];
    const [, body] = await deliver(w, { ...event(), id: 'delivery-retry' });
    assert.equal(body.status, 'refunded'); assert.equal(w.sb.users.get('fixture-user').pro, false);
    assert.ok(w.sb.events.has('refund.succeeded|arbitrary_refund-ID'));
  });
});

test('refund webhook ahead of GraphQL stays pending; cron retries until revoked', async () => {
  const w = world(); seed(w);
  await run(w, async () => {
    await deliver(w, event());
    assert.deepEqual(await deliver(w, refund()), [503, { ok: false, reason: 'proof_refund_pending' }]);
    assert.deepEqual({ ...outbox(w, 'refund.succeeded', 'rf-1') }, { state: 'pending', attempt_count: 1, last_error: 'proof_refund_pending' });
    assert.equal(w.sb.users.get('fixture-user').pro, true);
    const waits = [];
    await worker.scheduled({}, w.env, { waitUntil: promise => waits.push(promise) }); await Promise.all(waits);
    assert.equal(outbox(w, 'refund.succeeded', 'rf-1').attempt_count, 1);
    w.provider.refunds = [{ id: 'rf-1', status: 'succeeded' }];
    await cron(w);
    assert.deepEqual({ ...outbox(w, 'refund.succeeded', 'rf-1') }, { state: 'delivered', attempt_count: 2, last_error: null });
    assert.equal(w.sb.orders.get('ORD_one').state, 'refunded'); assert.equal(w.sb.users.get('fixture-user').pro, false);
  });
});

for (const failure of ['before', 'after']) test(`Supabase failure ${failure} commit leaves a pending outbox row; retry is idempotent`, async () => {
  const w = world(); seed(w); w.sb.fail.push(failure);
  await run(w, async () => {
    assert.deepEqual(await deliver(w, event()), [503, { ok: false, reason: 'entitlement_http' }]);
    assert.equal(outbox(w).state, 'pending'); assert.equal(outbox(w).last_error, 'entitlement_http');
    assert.equal(w.sb.orders.size, failure === 'after' ? 1 : 0);
    await cron(w);
    assert.equal(outbox(w).state, 'delivered');
    assert.deepEqual(await deliver(w, { ...event(), id: 'delivery-redelivery' }), [200, { ...granted, status: 'duplicate' }]);
    assert.equal(w.sb.sources.size, 1); assert.equal(w.sb.orders.get('ORD_one').version, 3);
  });
});

test('concurrent duplicate completions grant once; concurrent refund and completion end revoked', async () => {
  const w = world(); seed(w);
  await run(w, async () => {
    const results = await Promise.all([deliver(w, event()), deliver(w, { ...event(), id: 'delivery2' })]);
    assert.deepEqual(results.map(([, body]) => body.status).sort(), ['duplicate', 'granted']);
    assert.equal(w.sb.sources.size, 1);
    w.provider.refunds = [{ id: 'rf-1', status: 'succeeded' }];
    const raced = await Promise.all([deliver(w, refund()), deliver(w, { ...event(), id: 'delivery3' })]);
    assert.ok(raced.every(([code, body]) => code === 200 && body.entitlementState === 'revoked'));
    assert.equal(w.sb.sources.get('waffo|ORD_one').active, false); assert.equal(w.sb.users.get('fixture-user').pro, false);
  });
});

for (const [label, change] of [['wrong product', p => { p.productId = 'PROD_wrong'; }], ['incomplete order', p => { p.status = 'pending'; }],
  ['pending refund', p => { p.refunds = [{ id: 'rf-1', status: 'pending' }]; }]]) {
  test(`untrusted proof (${label}) never reaches Supabase or confirms the return page`, async () => {
    const w = world(); seed(w); change(w.provider);
    await run(w, async () => {
      assert.equal((await deliver(w, event()))[0], 400);
      assert.equal(applies(w), 0);
      assert.equal(w.sqlite.prepare('SELECT observation FROM event_ledger').get().observation, 'valid');
      assert.equal(outbox(w).state, 'pending');
      assert.deepEqual(await (await worker.fetch(statusRequest(), w.env)).json(),
        { paymentConfirmed: false, entitlementState: null, version: 0, entitlementEnabled: true });
    });
  });
}

for (const [label, change] of [['missing', env => { delete env.WAFFO_PRODUCTION_SERVICE_ROLE_KEY; }],
  ['anon key reused as', env => { env.WAFFO_PRODUCTION_SERVICE_ROLE_KEY = env.SUPABASE_ANON_KEY; }]]) {
  test(`${label} service credential fails closed before Supabase and before any Waffo checkout session`, async () => {
    const w = world(); seed(w); change(w.env);
    await run(w, async () => {
      assert.deepEqual(await deliver(w, event()), [503, { ok: false, reason: 'entitlement_configuration' }]);
      assert.equal(outbox(w).state, 'pending');
      assert.equal((await worker.fetch(checkoutRequest(secondRef), w.env)).status, 503);
      assert.equal(w.sb.calls.length, 0); assert.equal(w.sessions.length, 0);
    });
  });
}

for (const [label, request] of [
  ['missing signature', () => new Request('https://waffopay.sunland.dev/webhook/waffo', { method: 'POST', body: JSON.stringify(event()) })],
  ['Test key forged prod mode', () => signed(event(), other.privateKey)],
  ['stale signature', () => signed(event(), keys.privateKey, Date.now() - 46 * 60 * 1000)],
  ['future signature', () => signed(event(), keys.privateKey, Date.now() + 120000)],
]) test(`${label} rejects before ledger`, async () => {
  const w = world(); seed(w);
  await run(w, async () => {
    assert.equal((await worker.fetch(request(), w.env)).status, 401);
    assert.equal(w.sqlite.prepare('SELECT count(*) AS n FROM event_ledger').get().n, 0);
    assert.equal(w.sb.calls.length, 0);
  });
});
test('wrong production store rejected; unknown reference recorded unbound without outbox or Supabase', async () => {
  const w = world();
  await run(w, async () => {
    assert.equal((await worker.fetch(signed({ ...event(), storeId: 'STO_wrong' }), w.env)).status, 400);
    assert.deepEqual(await deliver(w, event()), [200, { ok: true, observation: 'unbound', result: 'recorded', entitlementEnabled: true }]);
    assert.equal(w.sqlite.prepare('SELECT count(*) AS n FROM production_outbox').get().n, 0);
    assert.equal(w.sb.calls.length, 0);
  });
});
test('Test and Production public key reuse fails closed', async () => {
  const w = world(); w.env.WAFFO_WEBHOOK_PUBLIC_KEY_PROD = w.env.WAFFO_WEBHOOK_PUBLIC_KEY_TEST;
  await run(w, async () => assert.equal((await worker.fetch(signed(event()), w.env)).status, 503));
});

function checkoutRequest(key = ref, body = { user_id: 'attacker', amount: 1 }) {
  return new Request('https://waffopay.sunland.dev/checkout/waffo/production', {
    method: 'POST', headers: { Authorization: 'Bearer synthetic-token', 'Idempotency-Key': key }, body: JSON.stringify(body) });
}
test('production checkout binds server identity in D1 and Supabase with stable idempotency', async () => {
  const w = world();
  await run(w, async () => {
    const first = await (await worker.fetch(checkoutRequest(), w.env)).json();
    const second = await (await worker.fetch(checkoutRequest(), w.env)).json();
    assert.deepEqual(first, { checkoutUrl: 'https://checkout.waffo.ai/synthetic', paymentReference: first.paymentReference, mode: 'prod', entitlementEnabled: true });
    assert.deepEqual(second, first);
    assert.equal(w.sqlite.prepare('SELECT user_id FROM payment_intents').get().user_id, 'fixture-user');
    assert.deepEqual(w.sb.intents.get(first.paymentReference), { user: 'fixture-user', request: ref });
    assert.deepEqual(w.sb.calls.map(([, b]) => b.p_intent.user_id), ['fixture-user', 'fixture-user']);
    const sessions = w.sessions.map(init => [init.headers['X-Idempotency-Key'], JSON.parse(init.body)]);
    assert.equal(sessions.length, 2); assert.equal(sessions[0][0], sessions[1][0]);
    assert.equal(sessions[0][1].productId, 'PROD_prod'); assert.equal(sessions[0][1].orderMerchantExternalId, first.paymentReference);
    assert.equal(sessions[0][1].successUrl, 'https://sunland.dev/waffo-return.html#checkout=' + ref);
  });
});
test('checkout refuses a Supabase intent binding conflict or inactive Supabase account before any Waffo session', async () => {
  const w = world(); w.sb.intents.set(secondRef, { user: 'fixture-user', request: ref });
  await run(w, async () => {
    assert.equal((await worker.fetch(checkoutRequest(), w.env)).status, 409);
    w.sb.users.get('fixture-user').active = false;
    assert.equal((await worker.fetch(checkoutRequest(secondRef), w.env)).status, 503);
    assert.equal(w.sessions.length, 0);
  });
});
for (const [label, identity, e2e] of [
  ['inactive identity', { user_id: 'fixture-user', identity_status: 'banned' }],
  ['identity outside the optional E2E restriction', { user_id: 'other-user', identity_status: 'active' }, 'fixture-user'],
]) test(`production checkout rejects ${label} before any intent or provider call`, async () => {
  const w = world(); w.identity = identity; if (e2e) w.env.WAFFO_PRODUCTION_E2E_SUB = e2e;
  await run(w, async () => {
    assert.equal((await worker.fetch(checkoutRequest(), w.env)).status, 403);
    assert.equal(w.sqlite.prepare('SELECT count(*) AS n FROM payment_intents').get().n, 0);
    assert.equal(w.sb.calls.length + w.sessions.length, 0);
  });
});
test('production checkout requires the exact deployed PRODUCTION secret name; old alias fails closed', async () => {
  const w = world();
  w.env.WAFFO_PRIVATE_KEY_PROD = w.env.WAFFO_PRIVATE_KEY_PRODUCTION; delete w.env.WAFFO_PRIVATE_KEY_PRODUCTION;
  await run(w, async () => {
    globalThis.fetch = () => { throw new Error('missing production secret must reject before external calls'); };
    assert.equal((await worker.fetch(checkoutRequest(), w.env)).status, 503);
    assert.equal(w.sqlite.prepare('SELECT count(*) AS n FROM payment_intents').get().n, 0);
  });
});
test('production identity diagnostics never expose token, body or unknown exception text', async () => {
  const w = world();
  await run(w, async () => {
    globalThis.fetch = () => { throw new Error('SENSITIVE_SENTINEL'); };
    const response = await worker.fetch(new Request('https://waffopay.sunland.dev/checkout/waffo/production', {
      method: 'POST', headers: { Authorization: 'Bearer SENSITIVE_SENTINEL', 'Idempotency-Key': ref }, body: '{}' }), w.env);
    assert.equal(response.status, 503);
    assert.deepEqual(JSON.parse(w.logs[0]), { event: 'waffo_production_identity_failed', reason: 'identity_network', stage: 'network', http_status: null });
    assert.equal(w.logs.join('').includes('SENSITIVE_SENTINEL'), false);
  });
});
test('production identity uses bound Worker service; missing binding fails closed', async () => {
  const w = world();
  await run(w, async () => {
    globalThis.fetch = () => { throw new Error('public same-zone fetch forbidden'); };
    w.env.WAFFO_IDENTITY_SERVICE = { async fetch(url, options) {
      assert.equal(this, w.env.WAFFO_IDENTITY_SERVICE);
      assert.equal(url, 'https://api.sunland.dev/v1/account/identity');
      assert.equal(options.method, 'POST'); assert.equal(options.headers.Authorization, 'Bearer synthetic-token');
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    } };
    assert.equal((await worker.fetch(checkoutRequest(), w.env)).status, 401);
    delete w.env.WAFFO_IDENTITY_SERVICE;
    assert.equal((await worker.fetch(checkoutRequest(), w.env)).status, 503);
    assert.equal(w.sqlite.prepare('SELECT count(*) AS n FROM payment_intents').get().n, 0);
  });
});

function statusRequest(body = { checkout: ref }, authorized = true) {
  return new Request('https://waffopay.sunland.dev/checkout/waffo/production/status', {
    method: 'POST', headers: authorized ? { Authorization: 'Bearer synthetic-token' } : {}, body: JSON.stringify(body) });
}
test('return status reads Supabase for the verified caller only; refund turns it off; read never grants', async () => {
  const w = world(); seed(w);
  await run(w, async () => {
    const read = async (body, identity = 'fixture-user') => { w.identity.user_id = identity;
      const response = await worker.fetch(statusRequest(body), w.env);
      assert.equal(response.headers.get('Cache-Control'), 'no-store'); return response.json(); };
    const none = { paymentConfirmed: false, entitlementState: null, version: 0, entitlementEnabled: true };
    assert.deepEqual(await read({ checkout: ref }), none);
    assert.equal(w.sb.orders.size, 0);
    await deliver(w, event());
    assert.deepEqual(await read({ checkout: ref, status: 'failed', amount: 1, user_id: 'attacker' }),
      { paymentConfirmed: true, entitlementState: 'granted', version: 3, entitlementEnabled: true });
    assert.equal(w.sb.calls.at(-1)[1].p_user_id, 'fixture-user');
    assert.deepEqual(await read({ checkout: secondRef, status: 'success' }), none);
    assert.deepEqual(await read({ checkout: ref }, 'other-user'), none);
    w.sb.users.get('fixture-user').active = false;
    assert.deepEqual(await read({ checkout: ref }), none);
    w.sb.users.get('fixture-user').active = true;
    w.provider.refunds = [{ id: 'rf-1', status: 'succeeded' }];
    await deliver(w, refund());
    assert.deepEqual(await read({ checkout: ref }), { paymentConfirmed: false, entitlementState: 'revoked', version: 4, entitlementEnabled: true });
  });
});
test('return status rejects missing auth, invalid context and identities outside the optional E2E restriction', async () => {
  const w = world();
  await run(w, async () => {
    assert.equal((await worker.fetch(statusRequest({}, false), w.env)).status, 401);
    assert.equal((await worker.fetch(statusRequest({ checkout: 'not-a-uuid' }), w.env)).status, 400);
    w.env.WAFFO_PRODUCTION_E2E_SUB = 'fixture-user'; w.identity.user_id = 'attacker';
    assert.equal((await worker.fetch(statusRequest(), w.env)).status, 403);
    assert.equal(w.sb.calls.length, 0);
  });
});

test('legacy Production return redirects to the fixed page without forwarding provider parameters; Test return stays isolated', async () => {
  const production = await worker.fetch(new Request('https://waffopay.sunland.dev/production/done?status=success&user_id=attacker'), {});
  assert.equal(production.status, 302);
  assert.equal(production.headers.get('Location'), 'https://sunland.dev/waffo-return.html');
  assert.equal(production.headers.get('Cache-Control'), 'no-store');
  const testReturn = await worker.fetch(new Request('https://waffopay.sunland.dev/test/done'), {});
  assert.equal(testReturn.status, 200); assert.equal(testReturn.headers.get('Location'), null);
});
