// Official query-only API + verified webhook display amounts. No client data is proof.
import { signApiRequest, fetchWithTimeout, validateWaffoAmounts } from './worker.js';

export class ProofError extends Error {
  constructor(code, permanent = false) { super(code); this.code = code; this.permanent = permanent; }
}
const requireProof = (condition, code) => { if (!condition) throw new ProofError(code, true); };
const fifteen = value => typeof value === 'string' && /^15(?:\.0{1,2})?$/.test(value);
export function validateProductionRelationship(data, event, intent, env) {
  const reported = event.order;
  const order = data?.onetimeOrder;
  const merchant = data?.merchant;
  requireProof(event.mode === 'prod', 'proof_environment');
  requireProof(intent?.mode === 'prod' && intent.user_id && intent.currency === 'CNY' && intent.amount_minor === 1500,
    'proof_intent');
  requireProof(event.storeId === env.WAFFO_PROD_STORE_ID && intent.store_id === event.storeId
    && order?.store?.id === event.storeId, 'proof_store');
  requireProof(merchant?.id === env.WAFFO_PROD_MERCHANT_ID && Array.isArray(merchant.storeMerchants)
    && merchant.storeMerchants.some(binding => binding.store?.id === event.storeId), 'proof_merchant');
  requireProof(order?.onetimeProduct?.id === env.WAFFO_PROD_PRODUCT_ID
    && intent.product_id === order.onetimeProduct.id
    && (!reported.productId || reported.productId === order.onetimeProduct.id), 'proof_product');
  requireProof(order.testMode === false, 'proof_test_mode');
  requireProof(order.id === reported.orderId && /^ORD_[A-Za-z0-9]+$/.test(order.id), 'proof_order');
  requireProof(order.orderMerchantExternalId === intent.payment_reference
    && reported.reference === intent.payment_reference, 'proof_binding');
  requireProof(order.currency === 'CNY' && reported.currency === 'CNY', 'proof_currency');
  return { order_id: order.id, payment_id: reported.paymentId, payment_reference: intent.payment_reference,
    user_id: intent.user_id, store_id: event.storeId, product_id: order.onetimeProduct.id,
    currency: 'CNY', amount_minor: 1500 };
}

export function validateProductionProof(data, event, intent, env) {
  requireProof(event.eventType === 'order.completed', 'proof_environment');
  const proof = validateProductionRelationship(data, event, intent, env);
  const reported = event.order;
  const order = data.onetimeOrder;
  requireProof(order.status === 'completed' && reported.orderStatus === 'completed'
    && reported.paymentStatus === 'succeeded', 'proof_status');
  requireProof(reported.paymentId === event.eventId && /^PAY_[A-Za-z0-9]+$/.test(event.eventId)
    && Array.isArray(order.payments), 'proof_payment');
  const matching = order.payments.filter(payment => payment.id === reported.paymentId);
  requireProof(matching.length === 1 && matching[0].status === 'succeeded', 'proof_payment_status');
  // Unknown or pending refund states fail closed; no guessed refundStatus enum.
  requireProof(Array.isArray(matching[0].refunds)
    && matching[0].refunds.every(refund => refund.status === 'failed'), 'proof_refund');
  requireProof(fifteen(reported.chargedAmount) && fifteen(reported.listPrice?.total)
    && validateWaffoAmounts(reported).valid, 'proof_amount');
  return proof;
}

export function validateProductionRefund(data, event, intent, env) {
  requireProof(['refund.succeeded', 'refund.failed'].includes(event.eventType), 'proof_refund_event');
  const proof = validateProductionRelationship(data, event, intent, env);
  const payments = data.onetimeOrder.payments;
  requireProof(Array.isArray(payments), 'proof_payment');
  const matching = payments.flatMap(payment => Array.isArray(payment.refunds)
    ? payment.refunds.filter(refund => refund.id === event.eventId).map(refund => ({ payment, refund })) : []);
  requireProof(matching.length === 1 && /^[A-Za-z0-9_-]{1,128}$/.test(event.eventId), 'proof_refund_binding');
  const {payment, refund} = matching[0];
  requireProof(refund.status === (event.eventType === 'refund.succeeded' ? 'succeeded' : 'failed')
    && (!event.order.paymentId || event.order.paymentId === payment.id)
    && /^PAY_[A-Za-z0-9]+$/.test(payment.id), 'proof_refund_status');
  return {...proof, payment_id: payment.id, refund_status: refund.status};
}

export async function queryProductionOrder(env, event, intent) {
  if (!env.WAFFO_PRIVATE_KEY_PRODUCTION || env.WAFFO_PRIVATE_KEY_PRODUCTION.replace(/\s/g, '')
    === String(env.WAFFO_PRIVATE_KEY_TEST || '').replace(/\s/g, '')) throw new ProofError('proof_key_unavailable');
  // Production introspection defines these IDs as String!, unlike the guide's ID! examples.
  const body = JSON.stringify({ query: `query PaymentProof($id: String!, $merchant: String!) {
    merchant(id: $merchant) { id storeMerchants { store { id } } }
    onetimeOrder(id: $id) { id store { id } onetimeProduct { id } testMode currency status
      orderMerchantExternalId payments { id status refunds { id status } } }
  }`, variables: { id: event.order.orderId, merchant: env.WAFFO_PROD_MERCHANT_ID } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  try {
    const signature = await signApiRequest(env.WAFFO_PRIVATE_KEY_PRODUCTION, 'POST', '/v1/graphql', timestamp, body);
    const response = await fetchWithTimeout('https://api.waffo.ai/v1/graphql', {
      method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json',
        'X-Merchant-Id': env.WAFFO_PROD_MERCHANT_ID, 'X-Timestamp': timestamp, 'X-Signature': signature }, body,
    });
    if (!response.ok) throw new ProofError('proof_http');
    const result = await response.json();
    if (!result || typeof result !== 'object' || Array.isArray(result) || result.errors?.length
      || (result.errors !== undefined && !Array.isArray(result.errors)) || !result.data) throw new ProofError('proof_response');
    validateProductionRelationship(result.data, event, intent, env);
    return result.data;
  } catch (error) {
    if (error instanceof ProofError) throw error;
    throw new ProofError('proof_unavailable');
  }
}

export async function verifyProductionProof(env, event, intent) {
  return validateProductionProof(await queryProductionOrder(env,event,intent),event,intent,env);
}
export async function verifyProductionRefund(env,event,intent) {
  return validateProductionRefund(await queryProductionOrder(env,event,intent),event,intent,env);
}
