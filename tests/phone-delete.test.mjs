import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {normalizeUserId} from '../ai/user-identity.js';
import {vaultPrefix} from '../ai/history-vault.js';

const source=(await readFile(new URL('../ai/account-delete.js',import.meta.url),'utf8')).replace(/^import .*\n/gm,'').replaceAll('export ','');
const phoneSource=await readFile(new URL('../p/js/phone-auth.js',import.meta.url),'utf8');
const jwt=claims=>`h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const flush=()=>new Promise(resolve=>setImmediate(resolve));

async function deletionFixture(t) {
  const {window}=new JSDOM('<button id="openAccountDeleteBtn">delete</button><dialog id="accountDeleteDialog"><button id="accountDeleteCloseBtn">close</button><div id="accountDeleteBody"></div></dialog>', {url:'https://sunland.dev/ai_settings.html',runScripts:'outside-only'});
  t.after(()=>window.close());
  const storage=window.localStorage;
  storage.setItem('token',jwt({id:'user-a',email:'owner@example.test'}));
  storage.setItem('lang','ja');
  Object.assign(window,{normalizeUserId,vaultPrefix,SunlandDatabaseToken:{get:async()=>jwt({id:'user-a',email:'owner@example.test'})}});
  const click=async id=>{window.document.getElementById(id).click();await flush();};
  const input=(id,value)=>{const element=window.document.getElementById(id);element.value=value;element.dispatchEvent(new window.Event('input'));};
  window.eval(source.replace('await import("./verified-identity.js")','await Promise.reject()'));
  window.initAccountDelete();await flush();
  await click('openAccountDeleteBtn');await click('accountDeleteContinueBtn');
  return {window,storage,click,input};
}

test('email deletion preserves its authorization and execute contracts, and requires explicit confirmation',async t=>{
  const {window,storage,click,input}=await deletionFixture(t);
  const calls=[];
  const token=storage.getItem('token');
  window.fetch=async(_url,init)=>{
    assert.equal(init.headers['x-sunland-token'],token);
    const body=JSON.parse(init.body);calls.push(body);
    return Response.json(body.action==='authorize'?{deletion_job_id:'job-a',deletion_token:'delete-a'}:{ok:true,user_id:'user-a'});
  };
  input('accountDeleteCodeInput','12345');await click('accountDeleteVerifyBtn');assert.equal(calls.length,0);
  input('accountDeleteCodeInput','123456');await click('accountDeleteVerifyBtn');
  assert.equal(window.document.getElementById('accountDeleteFinalBtn').disabled,true);
  input('accountDeleteConfirmInput','删除我的账号');await click('accountDeleteFinalBtn');
  assert.deepEqual(calls,[{action:'authorize',email:'owner@example.test',code:'123456'},
    {action:'execute',deletion_job_id:'job-a',deletion_token:'delete-a',confirmation:'删除我的账号'}]);
  assert.equal(storage.getItem('token'),null);assert.equal(storage.getItem('lang'),'ja');
});

test('a late execute response cannot clear or render success in a different account session',async t=>{
  const {window,storage,click,input}=await deletionFixture(t);
  let finish;
  window.fetch=async(_url,init)=>JSON.parse(init.body).action==='authorize'
    ? Response.json({deletion_job_id:'job-a',deletion_token:'delete-a'}) : new Promise(resolve=>{finish=resolve;});
  input('accountDeleteCodeInput','123456');await click('accountDeleteVerifyBtn');
  input('accountDeleteConfirmInput','删除我的账号');await click('accountDeleteFinalBtn');
  storage.setItem('token','session-b');storage.setItem('user','{"id":"user-b"}');
  finish(Response.json({ok:true,user_id:'user-a'}));await flush();
  assert.equal(storage.getItem('token'),'session-b');assert.equal(JSON.parse(storage.getItem('user')).id,'user-b');
  assert.equal(window.document.getElementById('accountDeleteResultMessage'),null);
});

test('account switch during asynchronous diagnostics cleanup preserves the new account session',async t=>{
  const {window,storage}=await deletionFixture(t);
  let finish;
  const cleanup=window.clearAccountLocalStorage('user-a',{clearDiagnostics:()=>new Promise(resolve=>{finish=resolve;}),expectedToken:storage.getItem('token')});
  storage.setItem('token','session-b');storage.setItem('user','{"id":"user-b"}');finish();
  await assert.rejects(cleanup,error=>error.code==='SESSION_CHANGED');
  assert.equal(storage.getItem('token'),'session-b');assert.equal(JSON.parse(storage.getItem('user')).id,'user-b');
});

function apiHarness(t,response){
  const {window}=new JSDOM('',{url:'https://sunland.dev',runScripts:'outside-only'});
  t.after(()=>window.close());window.AbortController=AbortController;window.eval(phoneSource);
  const calls=[];
  const client=window.SunlandPhoneAuth.createClient({getToken:()=>jwt({id:'user-a'}),fetchImpl:async(url,init)=>{calls.push({url,init,body:JSON.parse(init.body)});return Response.json(response);}});
  return {client,calls};
}
const validProof='A'.repeat(43),validAuthorization={ok:true,deletion_job_id:'76ded2a7-dc8d-4cc1-a338-c914c3292530',deletion_token:validProof,expires_in:600};
test('shared client preserves identity and deletion authorization request contracts',async t=>{
  const identity=apiHarness(t,{user_id:'user-a',email:null,identity_status:'active',is_banned:true});
  assert.equal((await identity.client.deletionIdentity()).is_banned,true);
  assert.equal(identity.calls[0].url,'https://api.sunland.dev/v1/account-delete/identity');assert.deepEqual(identity.calls[0].body,{});
  assert.equal(identity.calls[0].init.method,'POST');assert.equal(identity.calls[0].init.credentials,'omit');assert.match(identity.calls[0].init.headers.Authorization,/^Bearer /);
  const authorization=apiHarness(t,validAuthorization);await authorization.client.authorizeDelete(validProof);
  assert.equal(authorization.calls[0].url,'https://api.sunland.dev/v1/phone/delete-authorize');assert.equal(authorization.calls[0].body.reauth_token,validProof);
  assert.match(authorization.calls[0].body.operation_id,/^[a-f0-9-]{36}$/);assert.deepEqual(Object.keys(authorization.calls[0].body).sort(),['operation_id','reauth_token']);
});
test('shared client rejects cross-account, retiring and malformed identity responses',async t=>{
  for(const response of [{user_id:'other',email:null,identity_status:'active',is_banned:false},{user_id:'user-a',email:null,identity_status:'deleted',is_banned:false},{user_id:'user-a',email:{private:'secret'},identity_status:'active',is_banned:false}]){
    await assert.rejects(apiHarness(t,response).client.deletionIdentity(),error=>error.code==='UNAUTHORIZED');
  }
});
test('shared client rejects invalid delete proof locally and malformed grants remotely',async t=>{
  const invalid=apiHarness(t,validAuthorization);await assert.rejects(invalid.client.authorizeDelete('invalid'),error=>error.code==='INVALID_REQUEST');assert.equal(invalid.calls.length,0);
  for(const response of [{...validAuthorization,expires_in:0},{...validAuthorization,deletion_token:'bad'},{...validAuthorization,deletion_job_id:'user-a'}]){
    await assert.rejects(apiHarness(t,response).client.authorizeDelete(validProof),error=>error.code==='SERVICE_UNAVAILABLE');
  }
});
