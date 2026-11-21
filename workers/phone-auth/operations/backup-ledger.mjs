// Local operator tool. No production mutations. Secrets and exported records
// are kept in memory; only authenticated ciphertext is written to the share.
import { randomBytes, randomUUID, createCipheriv, createDecipheriv, scryptSync, timingSafeEqual } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, writeFile, stat, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const destination = '/Volumes/Sunland-Backups';
const tokenPath = join(homedir(), 'Library/Application Support/xixi-phone-auth/mount-ffc31773-beae-46d8-9949-98dc80ed018c/admin-token-rotation-candidate/PHONE_AUTH_ADMIN_TOKEN');
const require = createRequire('/Users/liuxize/sunland_ai_app/worker/package.json');
const {Miniflare, convertV4MiniflareOptions} = require('miniflare');
const service = `xixi-phone-ledger-backup-${randomUUID()}`;
const account = process.env.USER;
let runtime, device, ramdir, secret;
const run = (command, args, input) => {
  const r = spawnSync(command, args, {input, encoding:'utf8', timeout:30000, maxBuffer:1024*1024});
  if (r.status !== 0) throw Error('local protected operation failed');
  return r.stdout;
};
try {
  if (!process.stdin.isTTY || !/^[A-Za-z0-9_.-]+$/.test(account || '') || !(await stat(destination)).isDirectory()) throw Error('protected destination unavailable');
  const info = await stat(tokenPath);
  if (info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw Error('administrator credential permissions invalid');
  const token = (await readFile(tokenPath,'utf8')).trim();
  const response = await fetch('https://api.sunland.dev/v1/phone/_admin/export-ledger', {
    method:'POST', redirect:'error', headers:{Authorization:`Bearer ${token}`, 'Content-Type':'application/json', 'User-Agent':'sunland-phone-auth-verifier/1.0'}, body:'{}', signal:AbortSignal.timeout(30000),
  });
  if (!response.ok) throw Error(`export returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 8*1024*1024) throw Error('export exceeds safe limit');
  const snapshot = JSON.parse(bytes.toString('utf8'));
  if (snapshot.format !== 'sunland-phone-ledger-v1' || typeof snapshot.bookmark!=='string' || !snapshot.bookmark ||
      typeof snapshot.keyId!=='string' || !snapshot.keyId || !snapshot.policy || typeof snapshot.policy!=='object' ||
      !snapshot.release || typeof snapshot.release!=='object' || !Array.isArray(snapshot.records) ||
      !snapshot.records.some(x=>Array.isArray(x) && x[0]==='account') ||
      !(snapshot.alarm === null || Number.isSafeInteger(snapshot.alarm))) throw Error('incomplete export');
  const names = snapshot.records.map(x=>x[0]);
  if (names.some(x=>typeof x!=='string') || new Set(names).size!==names.length) throw Error('invalid keys');
  secret = randomBytes(32).toString('base64url');
  // security interactive mode receives the generated password on stdin, not argv.
  run('/usr/bin/security',['-i'],`add-generic-password -a ${account} -s ${service} -w ${secret}\n`);
  const recovered = run('/usr/bin/security',['find-generic-password','-a',account,'-s',service,'-w']).trim();
  if (recovered.length !== secret.length || !timingSafeEqual(Buffer.from(recovered),Buffer.from(secret))) throw Error('keychain recovery failed');
  const salt=randomBytes(16), iv=randomBytes(12), key=scryptSync(secret,salt,32), cipher=createCipheriv('aes-256-gcm',key,iv);
  const encrypted=Buffer.concat([cipher.update(bytes),cipher.final()]), tag=cipher.getAuthTag();
  const filename=join(destination,`${service}.enc`);
  await writeFile(filename,Buffer.concat([Buffer.from('SUNLAND-LEDGER-1\n'),salt,iv,tag,encrypted]),{flag:'wx',mode:0o600});
  const archive=await readFile(filename), prefix=Buffer.from('SUNLAND-LEDGER-1\n');
  assert.ok(archive.subarray(0,prefix.length).equals(prefix));
  let offset=prefix.length;const savedSalt=archive.subarray(offset,offset+=16),savedIv=archive.subarray(offset,offset+=12),savedTag=archive.subarray(offset,offset+=16);
  const decipher=createDecipheriv('aes-256-gcm',scryptSync(recovered,savedSalt,32),savedIv);decipher.setAuthTag(savedTag);
  const restored=Buffer.concat([decipher.update(archive.subarray(offset)),decipher.final()]);assert.ok(restored.equals(bytes));
  // Create isolated volatile storage; never restore production data onto disk.
  device=run('/usr/bin/hdiutil',['attach','-nomount','ram://65536']).trim().split(/\s+/)[0];
  if (!/^\/dev\/disk\d+$/.test(device)) throw Error('unexpected memory disk');
  const label='PhoneLedger'+randomBytes(5).toString('hex');
  run('/usr/sbin/diskutil',['erasevolume','HFS+',label,device]);
  ramdir=await mkdtemp(`/Volumes/${label}/restore-`);
  const script=`export class Restore { constructor(state){this.s=state.storage} async alarm(){} async fetch(r){let x=await r.json();if(x.op==='load'){await this.s.transaction(async t=>{for(const [k,v] of x.records) await t.put(k,v);if(x.alarm!==null)await t.setAlarm(x.alarm)});return Response.json({ok:true})}let records=[],cursor;do{let page=[...(await this.s.list({limit:1000,...(cursor?{startAfter:cursor}:{})})).entries()];records.push(...page);if(page.length<1000)break;cursor=page.at(-1)[0]}while(records.length<=10000);if(records.length>10000)throw Error('restore limit');return Response.json({records,alarm:await this.s.getAlarm()})} } export default {fetch(){return new Response('',{status:404})}}`;
  const options={name:'ledger-restore',script,modules:true,compatibilityDate:'2026-03-21',host:'127.0.0.1',port:0,cf:false,durableObjects:{RESTORE:{className:'Restore',useSQLite:true}},resourcePersistencePath:ramdir,outboundService:()=>{throw Error('network disabled')}};
  runtime=new Miniflare(convertV4MiniflareOptions(options));
  let stub=(await runtime.getDurableObjectNamespace('RESTORE')).getByName('isolated-ledger');
  const post=async x=>{const r=await stub.fetch('https://local.invalid/',{method:'POST',body:JSON.stringify(x)});if(!r.ok)throw Error('isolated restore failed');return r.json()};
  await post({op:'load',records:snapshot.records,alarm:snapshot.alarm});
  await runtime.dispose();
  runtime=new Miniflare(convertV4MiniflareOptions(options));
  stub=(await runtime.getDurableObjectNamespace('RESTORE')).getByName('isolated-ledger');
  const checked=await post({op:'read'});
  const sorted=records=>[...records].sort((a,b)=>a[0].localeCompare(b[0]));
  const actual=Buffer.from(JSON.stringify(sorted(checked.records))), expected=Buffer.from(JSON.stringify(sorted(snapshot.records)));
  if (actual.length!==expected.length || !timingSafeEqual(actual,expected) || checked.alarm!==snapshot.alarm) throw Error('isolated restoration mismatch');
  console.log(JSON.stringify({encrypted_backup:filename,keychain_service:service,records_restored:checked.records.length,isolated_workerd_restore:true,archive_recovered:true,bookmark_present:typeof snapshot.bookmark==='string'}));
} catch (e) {
  console.error('Backup not verified; no sensitive details were printed.'); process.exitCode=1;
} finally {
  if (runtime) await runtime.dispose();
  if (ramdir) await rm(ramdir,{recursive:true,force:true});
  if (device) try {execFileSync('/usr/bin/hdiutil',['detach',device],{stdio:'ignore',timeout:30000});} catch {console.error('Memory disk cleanup requires attention');process.exitCode=1;}
  secret=undefined;
}
