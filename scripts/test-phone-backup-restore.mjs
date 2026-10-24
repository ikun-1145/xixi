// Free, local recovery rehearsal only. No production URL or credentials accepted.
import {execFileSync} from 'node:child_process';
import {readFileSync,mkdtempSync,writeFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,randomBytes,createCipheriv,createDecipheriv,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const run=randomUUID(),name='sunland-backup-test-'+run,label='dev.sunland.phone-backup';
const image='public.ecr.aws/supabase/postgres:17.6.1.143';
const directory=mkdtempSync(join(tmpdir(),'sunland-backup-'));let created=false;
const command=(args,input)=>execFileSync('docker',args,{input,maxBuffer:16*1024*1024,timeout:30000,stdio:['pipe','pipe','pipe']});
const sql=(db,query)=>command(['exec','-i',name,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-h','/tmp','-d',db],query).toString().trim();
try {
 command(['image','inspect',image]);
 command(['run','--detach','--rm','--name',name,'--label',label+'='+run,'--network','none','--read-only','--memory','1g','--cpus','2','--pids-limit','128','--user','100:101','--tmpfs','/tmp:rw,nosuid,size=768m,mode=1777','--entrypoint','bash',image,'-c',"initdb -D /tmp/backup-pg -A trust --no-locale >/dev/null && exec postgres -D /tmp/backup-pg -k /tmp -c listen_addresses='' -c shared_buffers=32MB"]);created=true;
 for(let i=0;i<100;i++){try{sql('postgres','select 1');break;}catch(error){if(i===99)throw error;await new Promise(r=>setTimeout(r,100));}}
 sql('postgres','create role anon;create role authenticated;create role service_role bypassrls;create database backup_source;create database backup_restored;');
 const baseline=readFileSync(new URL('../tests/fixtures/phone-postgres-baseline.sql',import.meta.url),'utf8');sql('backup_source',baseline);
 for(const file of ['20260906010000_account_deletion.sql','20260911120000_account_deletion_finalize_order.sql','20261024003756_phone_identity.sql'])sql('backup_source',readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
 sql('backup_source',"insert into user_profiles(user_id,email,pro) values('backup-fixture','backup@example.invalid',true);");
 const dump=command(['exec',name,'pg_dump','-U','postgres','-h','/tmp','-d','backup_source','--format=custom','--no-owner']);
 const roles=command(['exec',name,'pg_dumpall','-U','postgres','-h','/tmp','--roles-only','--no-role-passwords']);
 assert.ok(dump.subarray(0,5).equals(Buffer.from('PGDMP')));assert.ok(roles.includes(Buffer.from('CREATE ROLE service_role')));
 const key=randomBytes(32),iv=randomBytes(12),aad=Buffer.from('sunland-local-recovery-rehearsal:v1');
 const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad);
 const encrypted=Buffer.concat([cipher.update(dump),cipher.final()]),tag=cipher.getAuthTag();
 const path=join(directory,'synthetic-postgres.dump.aesgcm');writeFileSync(path,encrypted,{mode:0o600});assert.equal(statSync(path).mode&0o777,0o600);
 assert.ok(!encrypted.includes(Buffer.from('backup@example.invalid')));
 const decrypt=bytes=>{const d=createDecipheriv('aes-256-gcm',key,iv);d.setAAD(aad);d.setAuthTag(tag);return Buffer.concat([d.update(bytes),d.final()]);};
 const bad=Buffer.from(encrypted);bad[0]^=1;assert.throws(()=>decrypt(bad));
 const recovered=decrypt(readFileSync(path));assert.equal(createHash('sha256').update(recovered).digest('hex'),createHash('sha256').update(dump).digest('hex'));
 command(['exec','-i',name,'pg_restore','-U','postgres','-h','/tmp','--no-owner','--exit-on-error','-d','backup_restored'],recovered);
 assert.equal(sql('backup_restored',"select user_id||':'||pro from user_profiles where user_id='backup-fixture'"),'backup-fixture:true');
 assert.equal(sql('backup_restored',"select count(*) from pg_class where relname like 'sunland_phone_%' and relkind='r' and relrowsecurity"),'5');
 assert.equal(sql('backup_restored',"select has_function_privilege('authenticated','public.sunland_phone_identity(text,jsonb)','execute')"),'f');
 assert.equal(sql('backup_restored',"select count(*) from pg_trigger where tgname='sunland_phone_identity_lifecycle'"),'1');
 console.log('PASS local recovery: custom-format pg_dump + role export + AES-256-GCM/tamper rejection + separate empty database pg_restore + profile/Pro/RLS/RPC/trigger checks');
 console.log('LIMIT: synthetic data, same cluster roles already present; not a production backup, full schema restore, Storage object backup or off-site retention verification.');
}finally {
 if(created){const actual=command(['inspect',name,'--format','{{index .Config.Labels "'+label+'"}}']).toString().trim();assert.equal(actual,run);command(['rm','--force',name]);}
 rmSync(directory,{recursive:true,force:true});console.log('cleanup: only this test container and its encrypted synthetic files removed; no production network');
}
