import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeAndValidateProviderOrder } from '../workers/afdianpay/worker.js';
// Initial baseline failed through the actual scheduled RPC call; red/green evidence retained in report.
test('a real custom_order_id UUID is an intent, never a legacy user', () => {
 const order=normalizeAndValidateProviderOrder({out_trade_no:'uuid-regression-1',status:2,product_type:0,plan_id:'4c2527fc6c7411f1bbe45254001e7c00',total_amount:'10.00',custom_order_id:'11111111-1111-4111-8111-111111111111'});
 assert.equal(order.binding_source,'intent');
});
