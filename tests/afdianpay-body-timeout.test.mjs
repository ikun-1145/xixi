// Isolated real HTTP transport; every request is restricted to this loopback server.
// The production Worker has no provider URL override. Only the imported test copy
// substitutes its fixed endpoint and shortens its timeout for deterministic tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const productionSource = await readFile(new URL('../workers/afdianpay/worker.js',import.meta.url),'utf8');
const officialEndpoint = 'const AFDIAN_QUERY_ENDPOINT = "https://ifdian.net/api/open/query-order";';
const timeoutConstant = 'const REQUEST_TIMEOUT_MS = 8_000;';
assert.equal(productionSource.split(officialEndpoint).length,2);
assert.equal(productionSource.split(timeoutConstant).length,2);

async function withLoopback(status,fn){
 const calls=[];const sockets=new Set();const nativeFetch=globalThis.fetch;
 const server=createServer(async(request,response)=>{
  const chunks=[];for await(const chunk of request)chunks.push(chunk);
  const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):null;
  calls.push({path:request.url,body});
  if(request.url==='/provider'){
   response.writeHead(status,{'Content-Type':'application/json',...(status===429?{'Retry-After':'120'}:{})});
   response.flushHeaders();
   // No body bytes and no end: native fetch must cancel the real socket read.
   return;
  }
  let result;
  if(request.url.endsWith('/sunland_claim_pro_payment_scan'))result={acquired:true,lease_token:'11111111-1111-4111-8111-111111111111',generation:1,next_page:1};
  else if(request.url.endsWith('/sunland_get_pro_payment_backoff'))result={retry_after_seconds:0};
  else if(request.url.endsWith('/sunland_release_pro_payment_scan')||request.url.endsWith('/sunland_set_pro_payment_backoff'))result={ok:true};
  else {response.writeHead(500);response.end('unexpected test path');return;}
  response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify(result));
 });
 server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 const source=productionSource.replace(officialEndpoint,`const AFDIAN_QUERY_ENDPOINT = "${base}/provider";`).replace(timeoutConstant,'const REQUEST_TIMEOUT_MS = 80;');
 const {reconcilePage}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
 let signal;
 globalThis.fetch=(input,init)=>{
  const url=new URL(input instanceof Request?input.url:String(input));
  assert.equal(url.origin,base,'isolated transport may only access the owned loopback server');
  if(url.pathname==='/provider')signal=init.signal;
  return nativeFetch(input,init);
 };
 try{
  await fn({calls,reconcilePage,signal:()=>signal,env:{SUPABASE_URL:base,SUPABASE_KEY:'synthetic-local-only',USER_ID:'synthetic',TOKEN:'synthetic'}});
 } finally {
  globalThis.fetch=nativeFetch;
  for(const socket of sockets)socket.destroy();
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
 }
}

function assertNoPaymentWrites(calls){
 assert.equal(calls.some(call=>/process_pro_payment_scan_orders|finish_pro_payment_order_query|process_verified_pro_order|complete_pro_payment_scan|record_pro_payment_hints/.test(call.path)),false);
 assert.equal(calls.filter(call=>call.path==='/provider').length,1);
 assert.equal(calls.filter(call=>call.path.endsWith('/sunland_release_pro_payment_scan')).length,1);
}

test('native fetch aborts stalled successful HTTP body after receiving headers',()=>withLoopback(200,async({calls,reconcilePage,signal,env})=>{
 const started=performance.now();
 await assert.rejects(reconcilePage(env,'history','cron_history'),/PROVIDER_QUERY_FAILED/);
 assert.ok(performance.now()-started>=60,'response headers must not clear the body timeout');
 assert.equal(signal().aborted,true);
 assertNoPaymentWrites(calls);
}));

test('native fetch preserves 429 header backoff while discarding stalled HTTP body',()=>withLoopback(429,async({calls,reconcilePage,signal,env})=>{
 await assert.rejects(reconcilePage(env,'recent','cron_recent'),/PROVIDER_BACKOFF/);
 assert.equal(calls.find(call=>call.path.endsWith('/sunland_set_pro_payment_backoff')).body.p_retry_after_seconds,120);
 assert.equal(signal().aborted,false,'header-classified response must not wait for the timeout');
 assertNoPaymentWrites(calls);
}));
