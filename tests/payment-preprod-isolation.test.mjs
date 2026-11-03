import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paymentEgress } from '../workers/waffopay/preprod-transport.js';
import preprodWorker, { preprodReady } from '../workers/waffopay/preprod-worker.js';
import preprodMock from '../workers/waffopay/preprod-mock.js';
import { productionRpc } from '../workers/waffopay/production-rpc.js';
import { queryProductionOrder } from '../workers/waffopay/payment-proof.js';
import { PREPROD,renderPreprodConfigs,validatePreprodInput,writePreprodConfigs }
  from '../scripts/reliability/render-payment-preprod.mjs';

const accountId='a'.repeat(32);
const testD1='11111111-1111-4111-8111-111111111111';
const source={accountId,d1Id:testD1};
const fakeWebhook = generateKeyPairSync('rsa', {modulusLength:2048});
const otherWebhook = generateKeyPairSync('rsa', {modulusLength:2048});
const fakePrivate = fakeWebhook.privateKey.export({type:'pkcs8',format:'pem'});
const fakePublic = fakeWebhook.publicKey.export({type:'spki',format:'pem'});
const otherPublic = otherWebhook.publicKey.export({type:'spki',format:'pem'});
const goodEnv={
  WAFFO_PREPROD_ISOLATED:'true',
  WAFFO_ENVIRONMENT:'test',
  WAFFO_PRODUCTION_ENABLED:'true',
  WAFFO_PRODUCTION_ENTITLEMENT_ENABLED:'false',
  WAFFO_PREPROD_GATE_TOKEN:'synthetic-preprod-test-gate-only-12345678',
  WAFFO_PREPROD_SIGNING_KEY:fakePrivate,
  WAFFO_WEBHOOK_PUBLIC_KEY_PROD:fakePublic,
  WAFFO_WEBHOOK_PUBLIC_KEY_TEST:otherPublic,
  WAFFO_PREPROD_RPC_TEST_KEY:'waffo-preprod-synthetic-role-key-not-prod',
  WAFFO_PREPROD_PROVIDER:{fetch:async()=>new Response('synthetic-provider')},
  WAFFO_PREPROD_RPC:{fetch:async()=>new Response('synthetic-rpc')},
  WAFFO_PRODUCTION_LEDGER:{prepare(){throw new Error('health must not read D1')}},
  WAFFO_PROD_MERCHANT_ID:'MER_PREPROD1',
  WAFFO_PROD_STORE_ID:'STO_PREPROD1',
  WAFFO_PROD_PRODUCT_ID:'PROD_PREPROD1',
};

test('preprod renderer rejects production D1, missing UUID and unapproved input',()=>{
  assert.deepEqual(validatePreprodInput(source),source);
  assert.throws(()=>validatePreprodInput({...source,d1Id:PREPROD.liveD1}),/dedicated_preprod_d1/);
  assert.throws(()=>validatePreprodInput({...source,d1Id:'invalid'}),/dedicated_preprod_d1/);
  assert.throws(()=>validatePreprodInput({...source,prod:false}),/unexpected_preprod_configuration/);
  assert.throws(()=>validatePreprodInput({...source,accountId:'prod-account'}),/invalid_cloudflare_account/);
});

test('preprod configs have no external routes, Cron, live service or secrets',()=>{
  const config=renderPreprodConfigs(source);
  assert.match(config.worker,/name = "waffopay-preprod-isolated"/);
  assert.match(config.worker,/workers_dev = false/);
  assert.match(config.worker,/WAFFO_PREPROD_ISOLATED = "true"/);
  assert.match(config.worker,/WAFFO_PRODUCTION_ENTITLEMENT_ENABLED = "false"/);
  assert.match(config.worker,/service = "waffopay-preprod-mock"/);
  assert.match(config.worker,/database_id = "11111111-1111-4111-8111-111111111111"/);
  assert.match(config.mock,/name = "waffopay-preprod-mock"/);
  assert.match(config.mock,/workers_dev = false/);
  for(const s of Object.values(config)){
    assert.doesNotMatch(s,/\[triggers\]|\[\[routes\]\]|crons|WAFFO_IDENTITY_SERVICE/);
    assert.doesNotMatch(s,/api\.waffo\.ai|supabase\.co|waffopay\.sunland\.dev/);
    assert.doesNotMatch(s,/WAFFO_PRIVATE_KEY_PRODUCTION|WAFFO_PRODUCTION_SERVICE_ROLE_KEY/);
    assert.doesNotMatch(s,/9003f99a-bcef-4ba5-a961-33c399a01ab5/);
  }
});

test('renderer emits only private local configs and refuses overwrite',()=>{
  const dir=mkdtempSync(join(tmpdir(),'payment-preprod-'));
  try {
    const output=join(dir,'.preprod-generated');
    assert.equal(writePreprodConfigs(source,output),2);
    assert.ok(existsSync(join(output,'worker.toml')));
    assert.ok(existsSync(join(output,'mock.toml')));
    assert.match(readFileSync(join(output,'worker.toml'),'utf8'),/WAFFO_PREPROD_ISOLATED = "true"/);
    assert.throws(()=>writePreprodConfigs(source,output),/refusing_to_overwrite/);
    assert.throws(()=>writePreprodConfigs(source,join(dir,'production')),/gitignored/);
  } finally { rmSync(dir,{force:true,recursive:true}); }
});

test('isolated egress always uses private service bindings and synthetic hosts',async()=>{
  const calls=[];
  const env={
    WAFFO_PREPROD_ISOLATED:'true',
    WAFFO_PREPROD_PROVIDER:{fetch:async(url,init)=>{calls.push({url,init});return new Response('provider mock')}},
    WAFFO_PREPROD_RPC:{fetch:async(url,init)=>{calls.push({url,init});return new Response('rpc mock')}},
  };
  const p=paymentEgress(env,'provider','https://api.waffo.ai/v1/graphql');
  const r=paymentEgress(env,'rpc','https://liveproject.supabase.co/rest/v1/rpc/sunland_waffo_apply_event');
  await p.fetchImpl(p.url,{method:'POST'});
  await r.fetchImpl(r.url,{method:'POST'});
  assert.equal(calls.length,2);
  assert.equal(calls[0].url,'https://waffo-provider.preprod.invalid/v1/graphql');
  assert.equal(calls[1].url,'https://waffo-rpc.preprod.invalid/rest/v1/rpc/sunland_waffo_apply_event');
  assert.ok(calls.every(x=>!x.url.includes('supabase.co')&&!x.url.includes('api.waffo.ai')));
  assert.throws(()=>paymentEgress({WAFFO_PREPROD_ISOLATED:'true'},'provider','https://api.waffo.ai/v1/graphql'),/binding_missing/);
  assert.throws(()=>paymentEgress({WAFFO_PREPROD_ISOLATED:'true'},'rpc','https://liveproject.supabase.co/rest/v1/rpc/x'),/binding_missing/);
  assert.throws(()=>paymentEgress(env,'unknown','whatever'),/unknown_egress/);
});

test('preprod RPC uses a synthetic secret and service binding, never a live role key',async()=>{
  const calls=[];
  const payload={version:1,paymentConfirmed:true,entitlementState:'pending'};
  const env={
    WAFFO_PREPROD_ISOLATED:'true',
    WAFFO_PREPROD_RPC_TEST_KEY:'synthetic-rpc-key',
    WAFFO_PRODUCTION_SERVICE_ROLE_KEY:'SHOULD_NOT_BE_PASSED',
    WAFFO_PREPROD_RPC:{fetch:async(url,init)=>{
      calls.push({url,auth:init.headers.apikey});
      return Response.json(payload);
    }},
  };
  const result=await productionRpc(env,'sunland_waffo_apply_event',{p_event:{fake:true}});
  assert.deepEqual(result,payload);
  assert.deepEqual(calls,[{
    url:'https://waffo-rpc.preprod.invalid/rest/v1/rpc/sunland_waffo_apply_event',
    auth:'synthetic-rpc-key'
  }]);
});

test('preprod entrypoint rejects missing gates, inherited real secrets, and all other routes',async()=>{
  assert.equal(preprodReady(goodEnv),true);
  for(const key of ['WAFFO_PRIVATE_KEY_PRODUCTION','WAFFO_PRODUCTION_SERVICE_ROLE_KEY',
    'SUPABASE_ANON_KEY','WAFFO_IDENTITY_SERVICE']){
    assert.equal(preprodReady({...goodEnv,[key]:key==='WAFFO_IDENTITY_SERVICE'?{fetch:()=>{}}:'LIVE_SECRET'}),false);
  }
  assert.equal(preprodReady({...goodEnv,WAFFO_PRODUCTION_ENTITLEMENT_ENABLED:'true'}),false);
  assert.equal(preprodReady({...goodEnv,WAFFO_PREPROD_ISOLATED:'false'}),false);
  assert.equal(preprodReady({...goodEnv,WAFFO_WEBHOOK_PUBLIC_KEY_PROD:undefined}),false);
  assert.equal(preprodReady({...goodEnv,WAFFO_WEBHOOK_PUBLIC_KEY_TEST:fakePublic}),false);
  assert.equal(preprodReady({...goodEnv,WAFFO_PREPROD_SIGNING_KEY:'not-a-private-key'}),false);
  assert.equal(preprodReady({...goodEnv,WAFFO_PREPROD_RPC_TEST_KEY:'a-real-secret-role'}),false);
  assert.equal((await preprodWorker.fetch(new Request('https://preprod.invalid/__preprod/health'),{})).status,503);
  assert.equal((await preprodWorker.fetch(new Request('https://preprod.invalid/__preprod/health'),goodEnv)).status,403);
  const headers={'X-Preprod-Test-Token':goodEnv.WAFFO_PREPROD_GATE_TOKEN};
  const res=await preprodWorker.fetch(new Request('https://preprod.invalid/__preprod/health',{headers}),goodEnv);
  assert.equal(res.status,200);
  assert.equal((await res.json()).entitlements,false);
  const checkout=await preprodWorker.fetch(new Request('https://preprod.invalid/checkout/waffo',{method:'POST',headers}),goodEnv);
  assert.equal(checkout.status,404);
  assert.equal(typeof preprodWorker.scheduled,'undefined');
});

test('mock Worker recognizes only fixed synthetic provider and entitlement RPC',async()=>{
  const get=await preprodMock.fetch(new Request('https://waffo-provider.preprod.invalid/v1/graphql',{method:'POST',body:JSON.stringify({
    variables:{id:'ORD_PREPROD1',merchant:'MER_PREPROD1'}
  })}));
  assert.equal(get.status,200);
  assert.equal((await get.json()).data.onetimeOrder.onetimeProduct.id,'PROD_PREPROD1');
  const r=await preprodMock.fetch(new Request('https://waffo-rpc.preprod.invalid/rest/v1/rpc/sunland_waffo_apply_event',{method:'POST',body:JSON.stringify({
    p_event:{payment_reference:'11111111-1111-4111-8111-111111111111',entitlement_enabled:false}
  })}));
  assert.equal(r.status,200);
  assert.equal((await r.json()).entitlementState,'pending');
  const invalid=await preprodMock.fetch(new Request('https://api.waffo.ai/v1/graphql',{method:'POST',body:'{}'}));
  assert.equal(invalid.status,404);
});


test('preprod proof fetch signs with synthetic key and only invokes internal mock',async()=>{
  const keys=generateKeyPairSync('rsa',{modulusLength:2048});
  const signingKey=keys.privateKey.export({type:'pkcs8',format:'pem'});
  const uuid='11111111-1111-4111-8111-111111111111';
  const actualCalls=[];
  const env={
    WAFFO_PREPROD_ISOLATED:'true',
    WAFFO_PREPROD_SIGNING_KEY:signingKey,
    WAFFO_PREPROD_TEST_SIGNING_KEY:'not-the-same-key',
    WAFFO_PROD_MERCHANT_ID:'MER_PREPROD1',
    WAFFO_PROD_STORE_ID:'STO_PREPROD1',
    WAFFO_PROD_PRODUCT_ID:'PROD_PREPROD1',
    WAFFO_PREPROD_PROVIDER:{fetch:async(url,init)=>{
      actualCalls.push({url,auth:init.headers['X-Signature']});
      return preprodMock.fetch(new Request(url,init));
    }},
  };
  const event={
    mode:'prod',storeId:'STO_PREPROD1',
    order:{orderId:'ORD_PREPROD1',reference:uuid,
      productId:'PROD_PREPROD1',currency:'CNY',paymentId:'PAY_PREPROD1'}
  };
  const intent={
    mode:'prod',user_id:'synthetic-user',currency:'CNY',amount_minor:1500,
    store_id:'STO_PREPROD1',product_id:'PROD_PREPROD1',payment_reference:uuid
  };
  const result=await queryProductionOrder(env,event,intent);
  assert.equal(result.onetimeOrder.id,'ORD_PREPROD1');
  assert.equal(actualCalls.length,1);
  assert.equal(actualCalls[0].url,'https://waffo-provider.preprod.invalid/v1/graphql');
  assert.ok(typeof actualCalls[0].auth==='string'&&actualCalls[0].auth.length>50);
  const unavailable={...env,WAFFO_PREPROD_PROVIDER:null};
  await assert.rejects(queryProductionOrder(unavailable,event,intent),/proof_unavailable/);
});

