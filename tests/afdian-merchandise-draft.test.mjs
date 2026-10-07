import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { canonicalAfdianProof, MERCHANDISE } from '../workers/afdianpay/merchandise-backend/worker-proof.DRAFT.mjs';
const raw = patch => ({out_trade_no:'draft-test-order',status:2,product_type:1,
  plan_id:MERCHANDISE.planId,total_amount:'15.00',custom_order_id:'11111111-1111-4111-8111-111111111111',
  sku_detail:[{sku_id:MERCHANDISE.skuId,count:1,name:'untrusted name',pic:'https://irrelevant.test'}],...patch});

test('merchandise companion carries immutable official SKU and strips raw personal/display fields',()=>{
  const order=canonicalAfdianProof(raw({address_phone:'synthetic phone',user_id:'provider-user',provider:'waffo'}));
  assert.equal(order.provider,'afdian'); assert.equal(order.amount_cents,1500);
  assert.deepEqual(order.sku_detail,[{sku_id:MERCHANDISE.skuId,count:1}]);
  assert.equal(order.address_phone,undefined); assert.equal(order.user_id,undefined);
});
for (const sku of [undefined,null,{},[],[null],[{sku_id:'bad',count:1}],
  [{sku_id:MERCHANDISE.skuId,count:'1'}],[{sku_id:MERCHANDISE.skuId,count:0}],
  [{sku_id:MERCHANDISE.skuId,count:1},{sku_id:MERCHANDISE.skuId,count:1}]]) {
  test(`merchandise rejects malformed SKU ${JSON.stringify(sku)}`,()=>assert.throws(()=>canonicalAfdianProof(raw({sku_detail:sku})),/INVALID_PRODUCT/));
}
test('existing sponsorship normalization remains compatible',()=>{
  const value=canonicalAfdianProof(raw({plan_id:'4c2527fc6c7411f1bbe45254001e7c00',product_type:0,total_amount:'10.00',sku_detail:undefined}));
  assert.equal(value.product_type,0); assert.equal(value.amount_cents,1000); assert.deepEqual(value.sku_detail,[]);
});
test('draft preserves deployed RPCs and reuses unified activation after proof',()=>{
  const sql=readFileSync(new URL('../workers/afdianpay/merchandise-backend/schema.DRAFT.sql',import.meta.url),'utf8');
  assert.doesNotMatch(sql,/create(?: or replace)? function public\.(sunland_activate_pro_from_payment|sunland_delete_account_business_data|sunland_waffo_)/i);
  assert.doesNotMatch(sql,/set pro\s*=\s*(true|false)|insert into public.user_profiles/i);
  assert.match(sql,/v_activation := public.sunland_activate_pro_from_payment\(v_user_id, v_order_id\)/);
  assert.match(sql,/AFDIAN_PROTECTED_RPC_CHANGED/);
  assert.match(sql,/v_cents <> 1500/);
  assert.match(sql,/v_existing.verified_product is distinct from v_product/);
});
