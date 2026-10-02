import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWaffoEvent } from '../workers/waffopay/worker.js';
import { validateProductionProof, validateProductionRefund, ProofError } from '../workers/waffopay/payment-proof.js';
import { productionRpc } from '../workers/waffopay/production-rpc.js';

const ref = '11111111-1111-4111-8111-111111111111';
const secondRef = '22222222-2222-4222-8222-222222222222';
const intent = { payment_reference: ref, mode: 'prod', user_id: 'fixture-user', store_id: 'STO_prod', product_id: 'PROD_prod', currency: 'CNY', amount_minor: 1500 };
function envelope() { return { id: 'delivery1', eventId: 'PAY_one', eventType: 'order.completed', mode: 'prod', storeId: 'STO_prod', timestamp: Date.now(),
  data: { orderMerchantExternalId: ref, orderId: 'ORD_one', paymentId: 'PAY_one', orderStatus: 'completed', paymentStatus: 'succeeded',
    currency: 'CNY', chargedAmount: '15.00', listPrice: { subtotal: '15.00', total: '15.00', taxAmount: '0.00' } } }; }
// Refund webhooks may omit paymentId; only order binding fields are guaranteed.
function refundEnvelope(eventId = 'rf-1', eventType = 'refund.succeeded') { return { id: 'delivery-refund', eventId, eventType, mode: 'prod', storeId: 'STO_prod',
  timestamp: Date.now(), data: { orderMerchantExternalId: ref, orderId: 'ORD_one', currency: 'CNY' } }; }
function data(body = envelope(), refunds = []) { return { merchant: { id: 'MER_synthetic', storeMerchants: [{ store: { id: 'STO_prod' } }] },
  onetimeOrder: { id: body.data.orderId, store: { id: 'STO_prod' }, onetimeProduct: { id: 'PROD_prod' }, testMode: false,
    currency: 'CNY', status: 'completed', orderMerchantExternalId: body.data.orderMerchantExternalId,
    payments: [{ id: body.data.paymentId || 'PAY_one', status: 'succeeded', refunds }] } }; }
const configuration = { WAFFO_PROD_MERCHANT_ID: 'MER_synthetic', WAFFO_PROD_STORE_ID: 'STO_prod', WAFFO_PROD_PRODUCT_ID: 'PROD_prod' };
// A TypeError also "throws"; only a permanent ProofError proves the validator rejected it.
const rejected = error => error instanceof ProofError && error.permanent === true;

test('trusted proof validates signed money and server product, store, merchant, mode and order/payment binding', () => {
  assert.deepEqual(validateProductionProof(data(), normalizeWaffoEvent(envelope()), intent, configuration), {
    order_id: 'ORD_one', payment_id: 'PAY_one', payment_reference: ref, user_id: 'fixture-user', store_id: 'STO_prod',
    product_id: 'PROD_prod', currency: 'CNY', amount_minor: 1500 });
});
const invalidProofs = [
  ['actual product', d => { d.onetimeOrder.onetimeProduct.id = 'PROD_wrong'; }],
  ['actual store', d => { d.onetimeOrder.store.id = 'STO_wrong'; }],
  ['merchant', d => { d.merchant.id = 'MER_wrong'; }],
  ['merchant store relationship', d => { d.merchant.storeMerchants = []; }],
  ['Test order', d => { d.onetimeOrder.testMode = true; }],
  ['missing mode', d => { delete d.onetimeOrder.testMode; }],
  ['currency', d => { d.onetimeOrder.currency = 'USD'; }],
  ['pending order', d => { d.onetimeOrder.status = 'pending'; }],
  ['cancelled order', d => { d.onetimeOrder.status = 'cancelled'; }],
  ['unknown order', d => { d.onetimeOrder = null; }],
  ['external intent', d => { d.onetimeOrder.orderMerchantExternalId = secondRef; }],
  ['order id', d => { d.onetimeOrder.id = 'ORD_wrong'; }],
  ['payment id', d => { d.onetimeOrder.payments[0].id = 'PAY_wrong'; }],
  ['pending payment', d => { d.onetimeOrder.payments[0].status = 'pending'; }],
  ['missing payments', d => { delete d.onetimeOrder.payments; }],
  ['missing refund details', d => { delete d.onetimeOrder.payments[0].refunds; }],
  ['successful refund', d => { d.onetimeOrder.payments[0].refunds = [{ id: 'rf-1', status: 'succeeded' }]; }],
  ['pending refund', d => { d.onetimeOrder.payments[0].refunds = [{ id: 'rf-1', status: 'pending' }]; }],
];
for (const [label, mutate] of invalidProofs) test(`proof rejects ${label}`, () => {
  const proof = data(); mutate(proof);
  assert.throws(() => validateProductionProof(proof, normalizeWaffoEvent(envelope()), intent, configuration), rejected);
});
for (const [label, mutate] of [
  ['charged amount below price', b => { b.data.chargedAmount = '14.99'; }],
  ['charged amount above price', b => { b.data.chargedAmount = '15.01'; }],
  ['missing charged amount', b => { delete b.data.chargedAmount; b.data.amount = '15.00'; }],
  ['numeric charged amount', b => { b.data.chargedAmount = 15; }],
  ['wrong due total', b => { b.data.listPrice.total = '16.00'; }],
  ['invalid arithmetic', b => { b.data.listPrice.taxAmount = '1.00'; }],
  ['webhook currency', b => { b.data.currency = 'USD'; }],
  ['webhook state', b => { b.data.paymentStatus = 'failed'; }],
  ['webhook order state', b => { b.data.orderStatus = 'pending'; }],
  ['webhook product', b => { b.data.productId = 'PROD_wrong'; }],
  ['Test webhook', b => { b.mode = 'test'; }],
  ['different event id', b => { b.eventId = 'PAY_other'; }],
]) test(`proof rejects ${label}`, () => {
  const body = envelope(); mutate(body);
  assert.throws(() => validateProductionProof(data(body), normalizeWaffoEvent(body), intent, configuration), rejected);
});
for (const [label, value] of [['user binding', ''], ['intent product', 'PROD_wrong'], ['intent price', 1000]]) test(`proof rejects ${label}`, () => {
  const changed = { ...intent, [label === 'user binding' ? 'user_id' : label === 'intent product' ? 'product_id' : 'amount_minor']: value };
  assert.throws(() => validateProductionProof(data(), normalizeWaffoEvent(envelope()), changed, configuration), rejected);
});
test('completion proof rejects refund events and refund proof rejects completion events', () => {
  const refund = normalizeWaffoEvent(refundEnvelope());
  assert.throws(() => validateProductionProof(data(), refund, intent, configuration), rejected);
  assert.throws(() => validateProductionRefund(data(), normalizeWaffoEvent(envelope()), intent, configuration), rejected);
  // Type checks must hold even when every other field would satisfy the other validator.
  assert.throws(() => validateProductionProof(data(), normalizeWaffoEvent({ ...envelope(), eventType: 'refund.succeeded' }), intent, configuration), rejected);
  assert.throws(() => validateProductionRefund(data(envelope(), [{ id: 'PAY_one', status: 'failed' }]), normalizeWaffoEvent(envelope()), intent, configuration), rejected);
});

test('refund proof binds the Waffo refund record and its payment without a webhook paymentId', () => {
  const proof = data(envelope(), [{ id: 'rf-1', status: 'succeeded' }]);
  assert.deepEqual(validateProductionRefund(proof, normalizeWaffoEvent(refundEnvelope()), intent, configuration), {
    order_id: 'ORD_one', payment_id: 'PAY_one', payment_reference: ref, user_id: 'fixture-user', store_id: 'STO_prod',
    product_id: 'PROD_prod', currency: 'CNY', amount_minor: 1500, refund_status: 'succeeded' });
  const failed = data(envelope(), [{ id: 'rf-2', status: 'failed' }]);
  assert.equal(validateProductionRefund(failed, normalizeWaffoEvent(refundEnvelope('rf-2', 'refund.failed')), intent, configuration).refund_status, 'failed');
});
for (const [label, mutate, eventId = 'rf-1', change = () => {}] of [
  ['unknown refund id', d => { d.onetimeOrder.payments[0].refunds = [{ id: 'rf-other', status: 'succeeded' }]; }],
  ['duplicated refund id', d => { d.onetimeOrder.payments.push({ id: 'PAY_two', status: 'succeeded', refunds: [{ id: 'rf-1', status: 'succeeded' }] }); }],
  ['unsafe refund id', d => { d.onetimeOrder.payments[0].refunds = [{ id: 'bad id', status: 'succeeded' }]; }, 'bad id'],
  ['refund status', d => { d.onetimeOrder.payments[0].refunds[0].status = 'failed'; }],
  ['refund on another reported payment', () => {}, 'rf-1', b => { b.data.paymentId = 'PAY_other'; }],
  ['non-payment refund parent', d => { d.onetimeOrder.payments[0].id = 'ORD_fake'; }],
  ['missing payments', d => { d.onetimeOrder.payments = null; }],
  ['Test order refund', d => { d.onetimeOrder.testMode = true; }],
  ['other intent refund', d => { d.onetimeOrder.orderMerchantExternalId = secondRef; }],
]) test(`refund proof rejects ${label}`, () => {
  const body = refundEnvelope(eventId); change(body);
  const proof = data(envelope(), [{ id: 'rf-1', status: 'succeeded' }]); mutate(proof);
  assert.throws(() => validateProductionRefund(proof, normalizeWaffoEvent(body), intent, configuration), rejected);
});

function rpcEnv(key = 'synthetic-service-role') { return { WAFFO_PRODUCTION_SERVICE_ROLE_KEY: key, SUPABASE_ANON_KEY: 'synthetic-anon' }; }
async function withFetch(handler, run) {
  const previous = globalThis.fetch; globalThis.fetch = handler;
  try { return await run(); } finally { globalThis.fetch = previous; }
}
const ok = { status: 'granted', paymentConfirmed: true, entitlementState: 'granted', version: 3 };
test('production RPC sends the separate service credential only to the allowlisted Supabase RPC', async () => {
  const seen = [];
  await withFetch(async (url, init) => { seen.push([url, init]); return Response.json(ok); }, async () => {
    assert.deepEqual(await productionRpc(rpcEnv(), 'sunland_waffo_apply_event', { p_event: { x: 1 } }), ok);
    await productionRpc(rpcEnv('sb_secret_synthetic'), 'sunland_waffo_status', {});
  });
  assert.equal(seen[0][0], 'https://klyrasrqgxijwrxuoevj.supabase.co/rest/v1/rpc/sunland_waffo_apply_event');
  assert.equal(seen[0][1].method, 'POST');
  assert.equal(seen[0][1].headers.apikey, 'synthetic-service-role');
  assert.equal(seen[0][1].headers.Authorization, 'Bearer synthetic-service-role');
  assert.equal(seen[0][1].headers['Content-Profile'], 'public');
  assert.deepEqual(JSON.parse(seen[0][1].body), { p_event: { x: 1 } });
  // Modern secret keys are gateway keys, never JWT bearer tokens.
  assert.equal(seen[1][1].headers.apikey, 'sb_secret_synthetic');
  assert.equal(seen[1][1].headers.Authorization, undefined);
});
for (const [label, env, name] of [
  ['missing service credential', { SUPABASE_ANON_KEY: 'synthetic-anon' }, 'sunland_waffo_apply_event'],
  ['anon key reused as service credential', { WAFFO_PRODUCTION_SERVICE_ROLE_KEY: 'synthetic-anon', SUPABASE_ANON_KEY: 'synthetic-anon' }, 'sunland_waffo_apply_event'],
  ['non-allowlisted RPC', rpcEnv(), 'sunland_activate_pro_from_payment'],
]) test(`production RPC rejects ${label} before any network call`, async () => {
  let calls = 0;
  await withFetch(async () => { calls++; return Response.json(ok); }, () =>
    assert.rejects(productionRpc(env, name, {}), { code: 'entitlement_configuration' }));
  assert.equal(calls, 0);
});
for (const payload of [[ok], [], null, { status: 'activated' }, { ...ok, version: -1 }, { ...ok, version: '3' },
  { ...ok, paymentConfirmed: 'true' }, { ...ok, entitlementState: 'refunded' }, { ...ok, paymentConfirmed: false }]) {
  test(`unrecognized RPC response is never trusted (${JSON.stringify(payload)})`, async () => {
    await withFetch(async () => Response.json(payload), () =>
      assert.rejects(productionRpc(rpcEnv(), 'sunland_waffo_apply_event', {}), { code: 'entitlement_response' }));
  });
}
test('production RPC maps HTTP and network failures to retryable codes without leaking text', async () => {
  for (const [response, code] of [[Response.json({}, { status: 409 }), 'entitlement_conflict'],
    [Response.json({ message: 'PRIVATE' }, { status: 400 }), 'entitlement_http'], [Response.json({}, { status: 503 }), 'entitlement_http']]) {
    await withFetch(async () => response, () => assert.rejects(productionRpc(rpcEnv(), 'sunland_waffo_status', {}),
      error => error.code === code && error.permanent === false && !error.message.includes('PRIVATE')));
  }
  await withFetch(async () => { throw new Error('PRIVATE'); }, () => assert.rejects(productionRpc(rpcEnv(), 'sunland_waffo_status', {}),
    error => error.code === 'entitlement_unavailable' && !error.message.includes('PRIVATE')));
});
