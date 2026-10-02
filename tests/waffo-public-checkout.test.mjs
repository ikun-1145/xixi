import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
const source = readFileSync(new URL('../ai/pro-payment.js', import.meta.url), 'utf8');
function load({ disabled=false, invalidUrl=false, switchAccount=false, responseMode='prod', stall=false }={}) {
  const storage = new Map([['token','fixture-token']]), calls=[], opened=[];
  let expire, resolve;
  const window = { crypto:webcrypto, localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
    setTimeout:fn=>{expire=fn;return 1;},clearTimeout(){},addEventListener(){},removeEventListener(){},
    open(){const popup={location:{replace:url=>popup.url=url},close(){popup.closed=true;}};opened.push(popup);return popup;},
    fetch:async(url,options)=>{ calls.push({url,options});
      if(url.includes('/account/identity'))return {ok:true,json:async()=>({user_id:'fixture-user',identity_status:'active'})};
      if(stall)return new Promise(r=>{resolve=r;});
      if(switchAccount)storage.set('token','another-credential');
      return {ok:true,json:async()=>({mode:responseMode,checkoutUrl:invalidUrl?'https://afdian.net/order':'https://checkout.waffo.ai/fixture'})};
    }};
  vm.runInNewContext(disabled?source.replace('const WAFFO_ENABLED = true;','const WAFFO_ENABLED = false;'):source,
    {window,URL,Date,AbortController,atob});
  return {api:window.SunlandProPayment,calls,opened,storage,expire:()=>expire(),finish:()=>resolve({ok:true,json:async()=>({mode:'prod',checkoutUrl:'https://checkout.waffo.ai/fixture'})})};
}
test('public purchase uses server identity and Production only, never legacy RPC or Test checkout',async()=>{
 const h=load(); await h.api.beginCheckout({supabase:{rpc(){throw Error('legacy must not be used');}}});
 assert.equal(h.api.PUBLIC_CHECKOUT_ENABLED,true);assert.equal(h.api.WAFFO_ENABLED,true);
 assert.equal(h.calls.length,2);assert.equal(h.calls[1].url,'https://waffopay.sunland.dev/checkout/waffo/production');
 assert.match(h.calls[1].options.headers['Idempotency-Key'],/^[a-f0-9-]{36}$/);
 assert.deepEqual(JSON.parse(h.calls[1].options.body),{language:'zh',darkMode:false});
 assert.equal(h.opened[0].url,'https://checkout.waffo.ai/fixture');
 const key=h.calls[1].options.headers['Idempotency-Key'];await h.api.createWaffoCheckout();
 assert.equal(h.calls[3].options.headers['Idempotency-Key'],key);
});
test('disabled Waffo fails closed without Afdian fallback',async()=>{
 const h=load({disabled:true});await assert.rejects(()=>h.api.beginCheckout(),/审核/);
 assert.equal(h.calls.length,0);assert.equal(h.opened.length,0);
});
for(const options of [{invalidUrl:true},{switchAccount:true},{responseMode:'test'}])test('public checkout rejects unsafe URL, changed identity or Test response '+JSON.stringify(options),async()=>{
 const h=load(options);await assert.rejects(()=>h.api.createWaffoCheckout());assert.equal(h.opened[0].url,undefined);assert.equal(h.opened[0].closed,true);
});
test('late checkout after timeout cannot navigate or grant Pro',async()=>{
 const h=load({stall:true});const request=h.api.createWaffoCheckout();while(h.calls.length<2)await Promise.resolve();
 h.expire();await assert.rejects(()=>request);h.finish();await Promise.resolve();assert.equal(h.opened[0].url,undefined);assert.equal(h.api.getState().state,'UNKNOWN');
});
