import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPhoneAuthWorker } from '../scripts/build-phone-auth-worker.mjs';
test('actual existing Worker bundles with phone wrapper and public DO export without source edits',async()=>{
 const result=await buildPhoneAuthWorker();
 assert.ok(result.code.includes('PhoneAuthCoordinator'));
 const worker=await import('data:text/javascript;base64,'+Buffer.from(result.code).toString('base64'));
 assert.equal(typeof worker.default.fetch,'function'); assert.equal(typeof worker.PhoneAuthCoordinator,'function');
 const response=await worker.default.fetch(new Request('https://api.sunland.dev/v1/phone/status',{method:'POST',body:'{}',headers:{'Content-Type':'application/json'}}),{},{});
 assert.equal(response.status,503); assert.equal((await response.json()).code,'IDENTITY_DISABLED');
 assert.ok(Object.keys(result.provenance.files).includes('src/email-otp.js'));
});
test('build refuses unreviewed original source before compilation',async()=>{
 const {mkdtemp,mkdir,writeFile,rm,readFile}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');const {join,dirname}=await import('node:path');
 const root=await mkdtemp(join(tmpdir(),'sunland-phone-build-'));
 try{
  const pinned=JSON.parse(await readFile(new URL('../workers/phone-auth/source-provenance.json',import.meta.url),'utf8'));
  const name=Object.keys(pinned.files)[0];await mkdir(dirname(join(root,name)),{recursive:true});await writeFile(join(root,name),'unreviewed changed source');
  await assert.rejects(buildPhoneAuthWorker({workerRoot:root}),/Unreviewed original Worker source changed/);
 }finally{await rm(root,{recursive:true,force:true});}
});
