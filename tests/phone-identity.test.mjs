import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhoneIdentity } from '../workers/phone-auth/identity.js';
const key = Buffer.alloc(32, 7).toString('base64url');
const env = { PHONE_IDENTITY_ENABLED:'true', PHONE_IDENTITY_LOOKUP_KEY:'lookup-test-key-more-than-32-characters', PHONE_IDENTITY_LOOKUP_KEY_ID:'lookup-v1', PHONE_IDENTITY_ENCRYPTION_KEYS:JSON.stringify({v1:key}), PHONE_IDENTITY_ENCRYPTION_KEY_ID:'v1', PHONE_AUTH_HMAC_KEY:'session-test-key-more-than-32-characters' };
function fixture(overrides={}) {
  const calls=[]; let payload={code:'OK'};
  const identity=createPhoneIdentity({...env,...overrides},{rpc:async(name,args)=>{calls.push({name,...args});return {ok:true,status:200,payload};}});
  return {identity,calls,set(v){payload=v;}};
}
test('identity fails closed by default and invalid keyring',()=>{
  assert.throws(()=>createPhoneIdentity({},{}),{code:'IDENTITY_DISABLED'});
  assert.throws(()=>fixture({PHONE_IDENTITY_ENCRYPTION_KEYS:'{}'}),{code:'IDENTITY_CONFIG'});
});
test('E164 HMAC stable, domain separated, invalid input rejected',async()=>{
 const {identity:i}=fixture(); const a=await i.phoneHash('13800000000');
 assert.match(a,/^[a-f0-9]{64}$/); assert.equal(a,await i.phoneHash('+8613800000000'));
 assert.notEqual(a,await i.sessionHash('13800000000')); await assert.rejects(async()=>i.phoneHash('0013800000000'),{code:'INVALID_REQUEST'});
});
test('login sends authenticated encrypted envelope, status decrypts with matching owner and HMAC',async()=>{
 const f=fixture(); f.set({code:'OK',user_id:'returned-id',email:null,onboarding:{version:0,step:1},is_new_user:true});
 await f.identity.login({phone:'13800000000',operationId:crypto.randomUUID()});
 const d=f.calls[0].p_data; assert.equal(f.calls[0].p_action,'login'); assert.ok(!JSON.stringify(d).includes('13800000000'));
 f.set({code:'OK',user_id:d.candidate_id,email:null,version:0,phone:{phone_hash:d.phone_hash,lookup_key_id:d.lookup_key_id,encrypted_phone:d.encrypted_phone,last4:d.last4}});
 const status=await f.identity.status(d.candidate_id); assert.equal(status.masked_phone,'+86 *******0000'); assert.equal(status.phone_hash,d.phone_hash); assert.ok(!('encrypted_phone' in status));
 f.set({code:'OK',user_id:'other-owner',email:null,version:0,phone:{phone_hash:d.phone_hash,lookup_key_id:d.lookup_key_id,encrypted_phone:d.encrypted_phone,last4:d.last4}});
 await assert.rejects(f.identity.status('other-owner'),{code:'IDENTITY_UNAVAILABLE'});
});
test('key rotation reads old ciphertext but writes only current key; tamper rejected',async()=>{
 const f=fixture(); f.set({code:'OK',user_id:'returned-id',email:null,onboarding:{version:0,step:1},is_new_user:true}); await f.identity.login({phone:'13800000000',operationId:crypto.randomUUID()}); const d=f.calls[0].p_data;
 const g=fixture({PHONE_IDENTITY_ENCRYPTION_KEYS:JSON.stringify({v1:key,v2:Buffer.alloc(32,9).toString('base64url')}),PHONE_IDENTITY_ENCRYPTION_KEY_ID:'v2'});
 const row={code:'OK',user_id:d.candidate_id,email:'A@EXAMPLE.COM',version:1,phone:{phone_hash:d.phone_hash,lookup_key_id:d.lookup_key_id,encrypted_phone:d.encrypted_phone,last4:d.last4}};
 g.set(row); await g.identity.status(d.candidate_id);
 g.set({code:'OK',user_id:'returned-id',email:null,onboarding:{version:0,step:1},is_new_user:true}); await g.identity.login({phone:'13900000000',operationId:crypto.randomUUID()}); assert.equal(JSON.parse(g.calls[1].p_data.encrypted_phone).key_id,'v2');
 row.phone.last4='9999'; g.set(row); await assert.rejects(g.identity.status(d.candidate_id),{code:'IDENTITY_UNAVAILABLE'});
});
test('proof opaque token not persisted, semantic request hash stable and no raw session',async()=>{
 const f=fixture(); f.set({code:'OK',issued_at:Date.now(),expires_in:300,version:0}); const sessionHash=await f.identity.sessionHash('raw-jwt');
 const grant=await f.identity.issueGrant({userId:'u',sessionHash,purpose:'bind',method:'email',subject:'a@example.com'});
 assert.match(grant.reauth_token,/^[A-Za-z0-9_-]{43}$/); const stored=f.calls[0].p_data;
 assert.notEqual(stored.proof_hash,grant.reauth_token); assert.ok(!JSON.stringify(stored).includes('raw-jwt'));
 const data={userId:'u',sessionHash,reauthToken:grant.reauth_token,phone:'13800000000',operationId:crypto.randomUUID()};
 f.set({code:'OK',user_id:'u',version:1}); await f.identity.mutate('bind',data); await f.identity.mutate('bind',data);
 assert.equal(f.calls[1].p_data.request_hash,f.calls[2].p_data.request_hash); assert.equal(f.calls[1].p_data.proof_hash,stored.proof_hash);
});
test('RPC failures closed, known error classified and no raw diagnostic leakage',async()=>{
 const f=fixture(); f.set({code:'PHONE_CONFLICT',secret:'do not expose'}); await assert.rejects(f.identity.login({phone:'13800000000',operationId:crypto.randomUUID()}),{code:'PHONE_CONFLICT',status:409});
 f.set({code:'mysterious'}); await assert.rejects(f.identity.status('u'),{code:'IDENTITY_UNAVAILABLE'});
 const i=createPhoneIdentity(env,{rpc:async()=>{throw Error('private credential');}}); await assert.rejects(i.status('u'),e=>e.code==='IDENTITY_UNAVAILABLE'&&!e.message.includes('credential'));
});
test('deletion token matches SHA256 UTF8 contract and never sent raw to RPC',async()=>{
 const f=fixture(); f.set({code:'OK',user_id:'u',deletion_job_id:crypto.randomUUID(),expires_in:600});
 const r=await f.identity.authorizeDelete({userId:'u',sessionHash:'a'.repeat(64),reauthToken:Buffer.alloc(32,1).toString('base64url'),operationId:crypto.randomUUID()});
 assert.equal(r.ok,true); const hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(r.deletion_token))).toString('hex');
 assert.equal(hash,f.calls[0].p_data.token_hash); assert.ok(!JSON.stringify(f.calls).includes(r.deletion_token));
});
test('delete authorization retry cannot return a new unusable token for a cached old job',async()=>{
 let receipt; const i=createPhoneIdentity(env,{rpc:async(_,{p_data:d})=>{
  if(receipt && receipt !== d.request_hash) return {ok:true,payload:{code:'OPERATION_CONFLICT'}};
  receipt=d.request_hash; return {ok:true,payload:{code:'OK',user_id:'u',deletion_job_id:'6b451844-68cb-4a8d-b185-63933ac23986',expires_in:600}};
 }});
 const data={userId:'u',sessionHash:'a'.repeat(64),reauthToken:Buffer.alloc(32,1).toString('base64url'),operationId:crypto.randomUUID()};
 await i.authorizeDelete(data); await assert.rejects(i.authorizeDelete(data),{code:'OPERATION_CONFLICT'});
});
test('identity refuses impossible onboarding states rather than minting incompatible login payloads',async()=>{
 const f=fixture();for(const onboarding of [{version:1,step:1},{version:1,step:2}]){
  f.set({code:'OK',user_id:'u',email:null,onboarding,is_new_user:false});
  await assert.rejects(f.identity.login({phone:'13800000000',operationId:crypto.randomUUID()}),{code:'IDENTITY_UNAVAILABLE'});
 }
});
