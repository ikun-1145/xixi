// Explicit local Docker integration suite. Never accepts an external database URL.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const root = new URL('../', import.meta.url);
const image = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const label = 'dev.sunland.phone-postgres';
const runId = randomUUID();
const container = `sunland-phone-test-${runId}`;
const h = n => String(n).padStart(64, '0');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
let created = false;
let passed = 0;
const baseline = await readFile(new URL('tests/fixtures/phone-postgres-baseline.sql',root),'utf8');
const migrations = await Promise.all(['20260906010000_account_deletion.sql','20260911120000_account_deletion_finalize_order.sql','20261024003756_phone_identity.sql'].map(name => readFile(new URL(`supabase/migrations/${name}`,root),'utf8')));

function command(args, input = '') {
  const child = spawn('docker', args, {stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';
  child.stdout.on('data',chunk=>stdout+=chunk);
  child.stderr.on('data',chunk=>stderr+=chunk);
  const timer=setTimeout(()=>child.kill('SIGKILL'),120_000);
  const promise=new Promise((resolve,reject)=> {
    child.on('error',reject);
    child.on('close',code=> {
      clearTimeout(timer);
      if(code===0) resolve(stdout.trim());
      else reject(new Error(`docker ${args[0]} failed (${code}): ${stderr.trim()}`));
    });
  });
  child.stdin.on('error',()=>{});
  child.stdin.end(input);
  return promise;
}
function sql(db, text, application = 'phone-suite') {
  return command(['exec','-i','-e',`PGAPPNAME=${application}`,container,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-h','/tmp','-d',db],`set statement_timeout='15s';set lock_timeout='12s';\n${text}\n`);
}
const data = extra => ({lookup_key_id:'lookup-v1',lookup_check:h(9),...extra});
const rpc = (action, args) => `select public.sunland_phone_identity(${quote(action)},${quote(JSON.stringify(data(args)))}::jsonb)`;
const call = async (db,action,args,role='service_role')=>JSON.parse(await sql(db,`set role ${role};${rpc(action,args)};`));
const login = (n,more={})=>({allow_create:true,phone_hash:h(n),encrypted_phone:`fixture-cipher-${n}`,last4:'1234',candidate_id:id(n),operation_id:id(1000+n),request_hash:h(1000+n),...more});
const grant = (n,purpose,more={})=>({user_id:id(n),session_hash:h(70),purpose,method:'email',subject:`person${n}@example.test`,proof_hash:h(2000+n),...more});
const mutation = (n,more={})=>({user_id:id(n),session_hash:h(70),proof_hash:h(2000+n),phone_hash:h(4000+n),encrypted_phone:`fixture-cipher-${n}`,last4:'5678',operation_id:id(3000+n),request_hash:h(3000+n),...more});
async function profile(db,n,pro=false) {await sql(db,`insert into user_profiles(user_id,email,pro) values(${quote(id(n))},'person${n}@example.test',${pro});`);}
async function check(name,fn) {await fn();passed++;console.log(`ok ${passed} - ${name}`);}
const wait = ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(db,predicate,labelText) {
  const deadline=Date.now()+10_000;
  while(Date.now()<deadline) {const value=await sql(db,predicate);if(value==='t')return;await wait(30);}
  throw new Error(`did not observe ${labelText}`);
}
async function contention(db,left,right,name,afterHold='') {
  // Each docker exec starts its own psql backend. A sleeps INSIDE its open
  // transaction after the RPC so B must really wait on the advisory lock.
  const appA=`${name}-a`, appB=`${name}-b`;
  const a=sql(db,`begin;set local role service_role;${left};select pg_sleep(1.4);${afterHold};commit;`,appA);
  // Install rejection handlers immediately to avoid unhandled rejection on failure.
  a.catch(()=>{});
  await until(db,`select exists(select 1 from pg_stat_activity where application_name=${quote(appA)} and wait_event='PgSleep')`,'transaction A holding phone lock');
  const b=sql(db,`set role service_role;${right};`,appB);b.catch(()=>{});
  await until(db,`select exists(select 1 from pg_stat_activity a join pg_stat_activity b on a.pid=any(pg_blocking_pids(b.pid)) where a.application_name=${quote(appA)} and b.application_name=${quote(appB)} and b.wait_event_type='Lock' and a.pid<>b.pid)`, 'distinct backend B blocked by A');
  const [first,second]=await Promise.all([a,b]);
  console.log(`  contention evidence: ${appA} and ${appB}; distinct backend PIDs; pg_blocking_pids + wait_event_type=Lock observed`);
  return [JSON.parse(first.split('\n').find(line=>line.startsWith('{'))),JSON.parse(second)];
}
async function setup(db, upgrade) {
  await sql('postgres',`create database ${db};`);
  await sql(db,baseline);
  await sql(db,migrations[0]);
  await sql(db,migrations[1]);
  if(upgrade)await profile(db,900,true);
  await sql(db,migrations[2]);
  await sql(db,`update sunland_phone_auth_config set lookup_key_id='lookup-v1',lookup_check='${h(9)}';`);
}
async function suite(db) {
  await check('configuration canary fails closed',async()=>assert.equal((await call(db,'login',login(1,{lookup_check:h(8)}))).code,'PHONE_KEY_MISMATCH'));
  await check('register atomically creates profile and mapping; repeat login retains UUID',async()=> {
    const a=await call(db,'login',login(1));const b=await call(db,'login',login(1,{candidate_id:id(2),operation_id:id(1002),request_hash:h(1002)}));
    assert.equal(a.is_new_user,true);assert.equal(a.email,null);assert.equal(b.is_new_user,false);assert.equal(a.user_id,b.user_id);
    assert.equal(await sql(db,`select count(*) from user_profiles p join sunland_phone_identities i using(user_id) where p.user_id='${id(1)}'`),'1');
  });
  await check('independent concurrent same-phone registrations produce one identity',async()=>{
    const results=await contention(db,rpc('login',login(60)),rpc('login',login(60,{candidate_id:id(61),operation_id:id(1061),request_hash:h(1061)})),'register');
    assert.equal(new Set(results.map(v=>v.user_id)).size,1);assert.equal(results.filter(v=>v.is_new_user).length,1);
    assert.equal(await sql(db,`select count(*) from user_profiles where user_id in ('${id(60)}','${id(61)}')`),'1');
  });
  await check('unique phone/user mapping and FK reject invalid writes',async()=>{
    await profile(db,80);
    for(const [user,phone] of [[80,60],[1,81],[999,999]]) await assert.rejects(sql(db,`insert into sunland_phone_identities(user_id,phone_hash,lookup_key_id,encrypted_phone,last4) values('${id(user)}','${h(phone)}','lookup-v1','fixture-cipher','1234')`),user===999?/foreign key/:/duplicate key/);
  });
  await check('two accounts concurrently binding one phone have one winner, loser proof unconsumed',async()=>{
    for(const n of [81,82]){await profile(db,n,n===81);assert.equal((await call(db,'grant',grant(n,'bind'))).code,'OK');}
    const results=await contention(db,rpc('bind',mutation(81,{phone_hash:h(8080)})),rpc('bind',mutation(82,{phone_hash:h(8080)})),'bind');
    assert.deepEqual(results.map(r=>r.code),['OK','PHONE_CONFLICT']);
    assert.equal(await sql(db,`select consumed_by is null from sunland_phone_auth_grants where proof_hash='${h(2082)}'`),'t');
    assert.equal(await sql(db,`select pro from user_profiles where user_id='${id(81)}'`),'t');
  });
  await check('change and unbind consume recent email grant and preserve identity',async()=>{
    assert.equal((await call(db,'grant',grant(81,'change',{proof_hash:h(9081)}))).code,'OK');
    assert.equal((await call(db,'change',mutation(81,{proof_hash:h(9081),phone_hash:h(9090),operation_id:id(9081),request_hash:h(9081)}))).code,'OK');
    assert.equal((await call(db,'grant',grant(81,'unbind',{proof_hash:h(9181)}))).code,'OK');
    assert.equal((await call(db,'unbind',mutation(81,{proof_hash:h(9181),operation_id:id(9181),request_hash:h(9181)}))).code,'OK');
    assert.equal((await call(db,'status',{user_id:id(81)})).phone,null);
    assert.equal(await sql(db,`select pro from user_profiles where user_id='${id(81)}'`),'t');
    assert.equal((await call(db,'grant',grant(1,'unbind',{method:'phone',subject:h(1)}))).code,'ALTERNATIVE_LOGIN_REQUIRED');
  });
  await check('stale, wrong-session, wrong-purpose and consumed grants are denied',async()=>{
    await call(db,'grant',grant(82,'bind',{proof_hash:h(9282)}));
    for(const patch of [{session_hash:h(71)},{purpose:'change'}])assert.equal((await call(db,'proof',grant(82,'bind',{proof_hash:h(9282),...patch}))).code,'REAUTH_INVALID');
    await sql(db,`update sunland_phone_auth_grants set issued_at=now()-interval '6 minutes',expires_at=now()-interval '1 minute' where proof_hash='${h(9282)}'`);
    assert.equal((await call(db,'proof',grant(82,'bind',{proof_hash:h(9282)}))).code,'REAUTH_INVALID');
    assert.equal((await call(db,'proof',grant(81,'unbind',{proof_hash:h(9181)}))).code,'REAUTH_INVALID');
  });
  await check('grant expiry is evaluated after genuine advisory lock waits',async()=>{
    await profile(db,83);await call(db,'grant',grant(83,'bind'));
    await sql(db,`update sunland_phone_auth_grants set expires_at=clock_timestamp()+interval '800 milliseconds' where proof_hash='${h(2083)}'`);
    const results=await contention(db,`select pg_advisory_xact_lock(20261024,2);select '{"code":"LOCK_HELD"}'::jsonb`,rpc('bind',mutation(83)),'expiry');
    assert.equal(results[1].code,'REAUTH_INVALID');
    assert.equal((await call(db,'status',{user_id:id(83)})).phone,null);
  });
  await check('retirement completes while login waits on its profile without inverted-lock deadlock',async()=>{
    await call(db,'login',login(84));
    const job=id(12084),attempt='fixture_attempt_12084';
    await sql(db,`insert into account_deletion_jobs(id,user_id,token_hash,expires_at) values('${job}','${id(84)}','${h(12084)}',now()+interval '10 minutes');set role service_role;select sunland_claim_account_deletion_job('${job}','${h(12084)}','${attempt}');reset role;update account_deletion_jobs set data_deleted_at=now() where id='${job}'`);
    const results=await contention(db,`select sunland_account_delete_begin('${id(84)}','${job}','${attempt}',1)`,rpc('login',login(84,{candidate_id:id(85),operation_id:id(12085),request_hash:h(12085)})),'retire',`select sunland_account_delete_finalize('${id(84)}','${job}','${attempt}',1)`);
    assert.equal(results[1].code,'ACCOUNT_NOT_ACTIVE');
    assert.equal(await sql(db,`select identity_status from user_profiles where user_id='${id(84)}'`),'retired');
    assert.equal(await sql(db,`select count(*) from sunland_phone_identities where user_id='${id(84)}'`),'0');
  });
  await check('exceptions roll back new profile, mapping, grant and receipt',async()=>{
    await sql(db,`create function fixture_reject_phone() returns trigger language plpgsql as $$begin if new.last4='9999' then raise exception 'fixture_failure'; end if;return new;end;$$;create trigger fixture_reject before insert or update on sunland_phone_identities for each row execute function fixture_reject_phone();`);
    await assert.rejects(call(db,'login',login(55,{last4:'9999'})),/fixture_failure/);
    assert.equal(await sql(db,`select count(*) from user_profiles where user_id='${id(55)}'`),'0');
    await call(db,'grant',grant(82,'bind',{proof_hash:h(9382)}));
    await assert.rejects(call(db,'bind',mutation(82,{last4:'9999',proof_hash:h(9382)})),/fixture_failure/);
    assert.equal(await sql(db,`select consumed_by is null from sunland_phone_auth_grants where proof_hash='${h(9382)}'`),'t');
    assert.equal(await sql(db,`select count(*) from sunland_phone_auth_operations where operation_id='${id(3082)}'`),'0');
    assert.equal(await sql(db,`select version from sunland_phone_auth_state where user_id='${id(82)}'`),'0');
  });
  await check('deleting rejects login, fenced cleanup releases phone, re-register never resurrects UUID',async()=>{
    const job=id(12001),attempt='fixture_attempt_12001';
    await sql(db,`insert into account_deletion_jobs(id,user_id,token_hash,expires_at) values('${job}','${id(1)}','${h(12001)}',now()+interval '10 minutes');`);
    const claimed=JSON.parse(await sql(db,`set role service_role;select sunland_claim_account_deletion_job('${job}','${h(12001)}','${attempt}');`));assert.equal(claimed.fencing_version,1);
    const begin=`select sunland_account_delete_begin('${id(1)}','${job}','${attempt}',1)`;
    assert.equal(JSON.parse(await sql(db,`set role service_role;${begin};`)).code,'revoked');
    assert.equal((await call(db,'login',login(1,{operation_id:id(13001),request_hash:h(13001)}))).code,'ACCOUNT_NOT_ACTIVE');
    assert.equal(await sql(db,`select count(*) from sunland_phone_identities where user_id='${id(1)}'`),'1');
    const finalize=`select sunland_account_delete_finalize('${id(1)}','${job}','${attempt}',1)`;
    await assert.rejects(sql(db,`set role service_role;${finalize};`),/DELETION_CONFLICT/);
    await sql(db,`update account_deletion_jobs set data_deleted_at=now() where id='${job}';`);
    assert.equal(JSON.parse(await sql(db,`set role service_role;select sunland_account_delete_finalize('${id(1)}','${job}','${attempt}',2)`)).code,'stale_attempt');
    await sql(db,`update account_deletion_jobs set lease_expires_at=now()-interval '1 second' where id='${job}'`);
    await assert.rejects(sql(db,`set role service_role;${finalize};`),/DELETION_CONFLICT/);
    await sql(db,`update account_deletion_jobs set lease_expires_at=now()+interval '90 seconds' where id='${job}'`);
    assert.equal(JSON.parse(await sql(db,`set role service_role;${finalize};`)).code,'retired');
    assert.equal(await sql(db,`select count(*) from sunland_phone_identities where user_id='${id(1)}'`),'0');
    assert.equal(JSON.parse(await sql(db,`set role service_role;select sunland_account_delete_sanitize_profile('${id(1)}','${job}','${attempt}',1)`)).code,'sanitized');
    const replacement=await call(db,'login',login(1,{candidate_id:id(20),operation_id:id(14001),request_hash:h(14001)}));assert.equal(replacement.user_id,id(20));
    assert.equal(await sql(db,`select identity_status from user_profiles where user_id='${id(1)}'`),'retired');
  });
  await check('phone tables and RPC reject anon/authenticated; RLS remains enabled',async()=>{
    const tables=['identities','auth_state','auth_grants','auth_operations','auth_config'];
    for(const role of ['anon','authenticated']) {
      await assert.rejects(call(db,'status',{user_id:id(81)},role),/permission denied/);
      for(const name of tables)await assert.rejects(sql(db,`set role ${role};select * from sunland_phone_${name}`),/permission denied/);
      await assert.rejects(sql(db,`set role ${role};insert into sunland_phone_auth_state values('${id(80)}',0)`),/permission denied/);
    }
    assert.equal(await sql(db,`select count(*) from pg_class where relname like 'sunland_phone_%' and relkind='r' and relrowsecurity`),'5');
    await assert.rejects(sql(db,"set role service_role;update sunland_phone_auth_config set lookup_key_id='other'"),/permission denied/);
  });
  await check('custom id database JWT RLS confines profiles and cannot write identity/Pro fields',async()=>{
    const claims=quote(JSON.stringify({role:'authenticated',id:id(81),sub:id(81),aud:'authenticated'}));
    const session=`set role authenticated;set request.jwt.claims=${claims};`;
    assert.equal(await sql(db,`${session}select count(*) from user_profiles`),'1');
    assert.equal(await sql(db,`${session}select sunland_authenticated_identity_is_active('${id(81)}')`),'t');
    assert.equal(await sql(db,`${session}select sunland_authenticated_identity_is_active('${id(82)}')`),'f');
    assert.equal(await sql(db,`${session}select count(*) from user_profiles where user_id='${id(82)}'`),'0');
    await sql(db,`${session}update user_profiles set name='safe fixture' where user_id='${id(81)}'`);
    assert.equal(await sql(db,`select name from user_profiles where user_id='${id(81)}'`),'safe fixture');
    for(const patch of ["pro=true","email='other@example.test'","user_id='other'","identity_status='active'"])await assert.rejects(sql(db,`${session}update user_profiles set ${patch} where user_id='${id(81)}'`),/permission denied/);
    // sub does not substitute for the application's id claim.
    assert.equal(await sql(db,`set role authenticated;set request.jwt.claims='{"role":"authenticated","sub":"${id(81)}"}';select count(*) from user_profiles`),'0');
  });
}

try {
  await command(['info','--format','{{.ServerVersion}}']).then(version=>console.log(`Docker Engine ${version}`));
  await command(['image','inspect',image,'--format','{{.Id}}']).then(digest=>console.log(`local image ${digest}`));
  await command(['run','--detach','--rm','--name',container,'--label',`${label}=${runId}`,'--network','none','--read-only','--cpus','2','--memory','1g','--pids-limit','128','--user','100:101','--tmpfs','/tmp:rw,nosuid,size=768m,mode=1777','--entrypoint','bash',image,'-c',"initdb -D /tmp/phone-pg -A trust --no-locale >/dev/null && exec postgres -D /tmp/phone-pg -k /tmp -c listen_addresses='' -c max_connections=20 -c shared_buffers=32MB"]);
  created=true;
  for(let i=0;i<100;i++){try{await sql('postgres','select 1');break;}catch(error){if(i===99)throw error;await wait(100);}}
  console.log(`PostgreSQL ${await sql('postgres','show server_version')}; isolated container ${container}`);
  await sql('postgres','create role anon;create role authenticated;create role service_role bypassrls;');
  await check('fresh empty database accepts reviewed baseline + original deletion migrations + phone migration',()=>setup('phone_fresh',false));
  await check('existing audited profile upgrades without loss of email, UUID or Pro',async()=>{
    await setup('phone_upgrade',true);
    assert.equal(await sql('phone_upgrade',`select email||':'||pro::text from user_profiles where user_id='${id(900)}'`),'person900@example.test:true');
    await call('phone_upgrade','grant',grant(900,'bind'));
    assert.equal((await call('phone_upgrade','bind',mutation(900))).code,'OK');
  });
  await suite('phone_fresh');
  console.log(`PASS ${passed}/${passed} actual PostgreSQL checks; no production network, no SMS`);
} finally {
  if(created){
    const actual=await command(['inspect',container,'--format',`{{index .Config.Labels "${label}"}}`]);
    assert.equal(actual,runId,'refuse to remove a container not owned by this run');
    await command(['rm','--force',container]);
    console.log('cleanup: removed only owned isolated container; tmpfs database discarded');
  }
}
