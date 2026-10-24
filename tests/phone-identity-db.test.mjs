// Isolated PostgreSQL WASM fixtures. No Docker, credentials or real user data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const migrationDir = new URL('../supabase/migrations/', import.meta.url);
const migrations = (await readdir(migrationDir)).filter(name => name.endsWith('_phone_identity.sql'));
assert.equal(migrations.length, 1, 'exactly one phone identity migration must exist');
const sql = await readFile(new URL(migrations[0], migrationDir), 'utf8');
const h = n => String(n).padStart(64, '0');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('phone SQL contract restricts all new storage and RPC privileges', () => {
  for (const table of ['identities', 'auth_state', 'auth_grants', 'auth_operations', 'auth_config']) {
    assert.match(sql, new RegExp(`alter table public.sunland_phone_${table} enable row level security`));
  }
  assert.match(sql, /security invoker/g);
  assert.doesNotMatch(sql, /security definer|alter table public\.user_profiles .*enable row level security/i);
  assert.match(sql, /revoke all on function public\.sunland_phone_identity\(text, jsonb\) from public, anon, authenticated/);
  assert.doesNotMatch(sql, /set\s+(?:pro|email|identity_status)\s*=/i);
});

async function fixture() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create table public.user_profiles (
      user_id text primary key, email text, pro boolean not null default false,
      is_banned boolean not null default false, identity_status text not null default 'active',
      onboarding_version smallint default 0, onboarding_step smallint default 1,
      created_at timestamptz default now(), deletion_job_id uuid, deletion_attempt_id text,
      deletion_fencing_version bigint not null default 0, retired_at timestamptz
    );
    create table public.account_deletion_jobs (
      id uuid primary key default gen_random_uuid(), user_id text not null,
      token_hash text not null unique, status text not null default 'pending',
      expires_at timestamptz not null, lease_expires_at timestamptz, attempt_id text,
      fencing_version bigint not null default 0, data_deleted_at timestamptz,
      recovery_expires_at timestamptz, created_at timestamptz not null default now()
    );
    grant select,insert,update,delete on public.user_profiles,public.account_deletion_jobs to service_role;
  `);
  await db.exec(sql);
  await db.exec(`update public.sunland_phone_auth_config set lookup_key_id='lookup-v1',lookup_check='${h(9)}' where singleton`);
  const query = async (text, args = []) => (await db.query(text, args)).rows;
  const call = async (action, data = {}) => (await query('select public.sunland_phone_identity($1,$2::jsonb) result', [action,
    JSON.stringify({lookup_key_id:'lookup-v1',lookup_check:h(9),...data})]))[0].result;
  const login = (n, more = {}) => call('login', {phone_hash:h(n),encrypted_phone:`cipher-${n}`,last4:'1234',candidate_id:id(n),allow_create:true,operation_id:id(1000+n),request_hash:h(1000+n),...more});
  const profile = async (n, more = {}) => {
    await query('insert into public.user_profiles(user_id,email,pro) values($1,$2,$3)', [id(n), more.email ?? `person${n}@example.test`, more.pro ?? false]);
  };
  const grant = (n, purpose, more = {}) => call('grant', {user_id:id(n),session_hash:h(70),purpose,method:'email',subject:`person${n}@example.test`,proof_hash:h(2000+n),...more});
  const mutate = (n, action, more = {}) => call(action, {user_id:id(n),session_hash:h(70),proof_hash:h(2000+n),operation_id:id(3000+n),request_hash:h(3000+n),phone_hash:h(4000+n),encrypted_phone:`cipher-${n}`,last4:'5678',...more});
  return {db,query,call,login,profile,grant,mutate};
}

test('phone RPC executes transactions, permissions and lifecycle in embedded PostgreSQL', async t => {
  const f = await fixture();
  const {db,query,call,login,profile,grant,mutate} = f;
  try {
    await t.test('default canary fails closed and key changes cannot split uniqueness', async () => {
      assert.equal((await call('login', {lookup_check:h(8)})).code, 'PHONE_KEY_MISMATCH');
      await query('update sunland_phone_auth_config set lookup_check=null');
      assert.equal((await login(1)).code, 'PHONE_KEY_MISMATCH');
      await query('update sunland_phone_auth_config set lookup_check=$1', [h(9)]);
    });
    await t.test('registration creates one UUID profile with null email and login returns same identity', async () => {
      const first = await login(1);
      assert.equal(first.code,'OK'); assert.equal(first.user_id,id(1)); assert.equal(first.email,null);
      assert.equal(first.is_new_user,true); assert.deepEqual(first.onboarding,{version:0,step:1});
      const second = await login(1,{candidate_id:id(2),operation_id:id(1002),request_hash:h(1002)});
      assert.equal(second.user_id,id(1)); assert.equal(second.is_new_user,false);
      assert.equal((await query('select count(*)::integer n from user_profiles'))[0].n,1);
    });
    await t.test('operation retries are idempotent and different inputs conflict', async () => {
      const again = await login(1);
      assert.equal(again.user_id,id(1)); assert.equal(again.is_new_user,true);
      assert.equal((await login(1,{request_hash:h(8)})).code,'OPERATION_CONFLICT');
    });
    await t.test('registration requires JSON boolean true atomically; mapped login stays available', async () => {
      for (const allow_create of [undefined, null, false, 'true', 1, {}]) {
        assert.equal((await login(901,{allow_create})).code,'REGISTRATION_DISABLED');
      }
      for (const table of ['user_profiles','sunland_phone_identities','sunland_phone_auth_state','sunland_phone_auth_operations']) {
        assert.equal((await query(`select count(*)::integer n from ${table} where user_id=$1`,[id(901)]))[0].n,0);
      }
      const existing=await login(1,{allow_create:false,operation_id:id(19001),request_hash:h(19001)});
      assert.equal(existing.code,'OK');assert.equal(existing.user_id,id(1));assert.equal(existing.is_new_user,false);
    });
    await t.test('queued simultaneous registrations create one account and preserve uniqueness', async () => {
      // PGlite serializes one backend: this tests queued atomic calls, not
      // independent PostgreSQL connections or contention on live row locks.
      const results=await Promise.all(Array.from({length:8},(_,i)=>login(60,{candidate_id:id(60+i),operation_id:id(18000+i),request_hash:h(18000+i)})));
      assert.equal(results.filter(r=>r.is_new_user).length,1);
      assert.equal(new Set(results.map(r=>r.user_id)).size,1);
      assert.equal((await query('select count(*)::integer n from sunland_phone_identities where phone_hash=$1',[h(60)]))[0].n,1);
      const mapUser=results[0].user_id;
      await assert.rejects(query('insert into sunland_phone_identities(user_id,phone_hash,lookup_key_id,encrypted_phone,last4) values($1,$2,\'lookup-v1\',\'cipher-other\',\'1234\')',[mapUser,h(61)]),/duplicate key/);
      await profile(80);
      await assert.rejects(query('insert into sunland_phone_identities(user_id,phone_hash,lookup_key_id,encrypted_phone,last4) values($1,$2,\'lookup-v1\',\'cipher-other\',\'1234\')',[id(80),h(60)]),/duplicate key/);
      await assert.rejects(query('insert into sunland_phone_identities(user_id,phone_hash,lookup_key_id,encrypted_phone,last4) values($1,$2,\'lookup-v1\',\'cipher-other\',\'1234\')',[id(999),h(999)]),/foreign key/);
    });
    await t.test('binding preserves original profile and Pro, does not overwrite phones', async () => {
      await profile(10,{pro:true}); assert.equal((await grant(10,'bind')).code,'OK');
      const bound = await mutate(10,'bind'); assert.equal(bound.code,'OK'); assert.equal(bound.version,1);
      assert.equal((await query('select pro from user_profiles where user_id=$1',[id(10)]))[0].pro,true);
      assert.equal((await call('status',{user_id:id(10)})).phone.phone_hash,h(4010));
      assert.equal((await mutate(10,'bind')).code,'OK');
      await profile(11); await grant(11,'bind');
      assert.equal((await mutate(11,'bind',{phone_hash:h(4010)})).code,'PHONE_CONFLICT');
      assert.equal((await query('select consumed_by from sunland_phone_auth_grants where proof_hash=$1',[h(2011)]))[0].consumed_by,null);
    });
    await t.test('legacy NULL onboarding is completed and cached login refreshes current profile data', async () => {
      await profile(92);
      await query('update user_profiles set onboarding_version=null,onboarding_step=null where user_id=$1',[id(92)]);
      await grant(92,'bind');
      assert.equal((await mutate(92,'bind',{phone_hash:h(92)})).code,'OK');
      const first=await login(92);
      assert.deepEqual(first.onboarding,{version:1,step:3});
      assert.equal(first.email,'person92@example.test');
      const snapshot=(await query('select result from sunland_phone_auth_operations where operation_id=$1',[id(1092)]))[0].result;
      assert.equal(Object.hasOwn(snapshot,'email'),false);
      assert.equal(Object.hasOwn(snapshot,'onboarding'),false);
      const profileState=await query('select onboarding_version,onboarding_step from user_profiles where user_id=$1',[id(92)]);
      assert.deepEqual(profileState[0],{onboarding_version:null,onboarding_step:null});
      await query('update user_profiles set email=\'fresh92@example.test\',onboarding_version=0,onboarding_step=2 where user_id=$1',[id(92)]);
      const cached=await login(92);
      assert.equal(cached.email,'fresh92@example.test');
      assert.deepEqual(cached.onboarding,{version:0,step:2});
      assert.equal(cached.is_new_user,first.is_new_user);
      await query('update user_profiles set onboarding_version=1,onboarding_step=2 where user_id=$1',[id(92)]);
      await assert.rejects(login(92),/INVALID_ONBOARDING_STATE/);
      for (const [version,step] of [[0,0],[0,4],[null,3],[1,null],[-1,3]]) {
        await query('update user_profiles set onboarding_version=$1,onboarding_step=$2 where user_id=$3',[version,step,id(92)]);
        await assert.rejects(login(92,{operation_id:id(92001),request_hash:h(92001)}),/INVALID_ONBOARDING_STATE/);
      }
      await query('update user_profiles set onboarding_version=1,onboarding_step=3 where user_id=$1',[id(92)]);
      assert.deepEqual((await login(92)).onboarding,{version:1,step:3});
    });
    await t.test('queued competing binds have one winner and no partial loser writes', async () => {
      await profile(81); await profile(82);
      await grant(81,'bind'); await grant(82,'bind');
      const results=await Promise.all([mutate(81,'bind',{phone_hash:h(8080)}),mutate(82,'bind',{phone_hash:h(8080)})]);
      assert.equal(results.filter(r=>r.code==='OK').length,1);
      assert.equal(results.filter(r=>r.code==='PHONE_CONFLICT').length,1);
      const loser=results[0].code==='OK'?82:81;
      assert.equal((await call('status',{user_id:id(loser)})).phone,null);
      assert.equal((await query('select consumed_by from sunland_phone_auth_grants where proof_hash=$1',[h(2000+loser)]))[0].consumed_by,null);
    });
    await t.test('proofs reject stale versions, sessions, purposes, expiry and replay', async () => {
      assert.equal((await call('proof',{user_id:id(10),session_hash:h(70),purpose:'bind',proof_hash:h(2010)})).code,'REAUTH_INVALID');
      await grant(10,'change',{proof_hash:h(5010)});
      for (const patch of [{session_hash:h(71)},{purpose:'unbind'},{proof_hash:h(1)}]) {
        assert.equal((await call('proof',{user_id:id(10),session_hash:h(70),purpose:'change',proof_hash:h(5010),...patch})).code,'REAUTH_INVALID');
      }
      await query('update sunland_phone_auth_grants set issued_at=now()-interval \'6 minutes\',expires_at=now()-interval \'1 minute\' where proof_hash=$1',[h(5010)]);
      assert.equal((await call('proof',{user_id:id(10),session_hash:h(70),purpose:'change',proof_hash:h(5010)})).code,'REAUTH_INVALID');
    });
    await t.test('change is atomic, consumes proof and invalidates older proofs', async () => {
      await grant(10,'change',{proof_hash:h(6010)}); await grant(10,'unbind',{proof_hash:h(7010)});
      const changed=await mutate(10,'change',{proof_hash:h(6010),phone_hash:h(8010),operation_id:id(8010),request_hash:h(8010)});
      assert.equal(changed.code,'OK'); assert.equal(changed.version,2);
      assert.equal((await call('status',{user_id:id(10)})).phone.phone_hash,h(8010));
      assert.equal((await mutate(10,'unbind',{proof_hash:h(7010),operation_id:id(9010),request_hash:h(9010)})).code,'REAUTH_INVALID');
    });
    await t.test('cached login does not authenticate an account after its phone mapping changes', async () => {
      await profile(21);
      await grant(21,'bind');
      assert.equal((await mutate(21,'bind',{phone_hash:h(21)})).code,'OK');
      assert.equal((await login(21)).user_id,id(21));
      await grant(21,'change',{proof_hash:h(2121)});
      assert.equal((await mutate(21,'change',{proof_hash:h(2121),phone_hash:h(2221),operation_id:id(2221),request_hash:h(2221)})).code,'OK');
      assert.equal((await login(21)).code,'ACCOUNT_NOT_ACTIVE');
    });
    await t.test('phone-only users cannot unbind; current verified email is required', async () => {
      assert.equal((await grant(1,'unbind',{method:'phone',subject:h(1)})).code,'ALTERNATIVE_LOGIN_REQUIRED');
      await grant(10,'unbind',{proof_hash:h(10010)});
      assert.equal((await mutate(10,'unbind',{proof_hash:h(10010),operation_id:id(10010),request_hash:h(10010)})).code,'OK');
      assert.equal((await call('status',{user_id:id(10)})).phone,null);
      await grant(11,'unbind',{proof_hash:h(11011)});
      await query('update user_profiles set email=\'changed@example.test\' where user_id=$1',[id(11)]);
      assert.equal((await mutate(11,'unbind',{proof_hash:h(11011)})).code,'REAUTH_INVALID');
      await query('update user_profiles set email=\'person11@example.test\' where user_id=$1',[id(11)]);
    });
    await t.test('database exception rolls profile, mapping, proof and operation back', async () => {
      await db.exec(`create function public.reject_phone_fixture() returns trigger language plpgsql as $$begin if new.last4='9999' then raise exception 'fixture failure'; end if;return new;end;$$;
        create trigger reject_phone_fixture before insert or update on public.sunland_phone_identities for each row execute function public.reject_phone_fixture();`);
      await assert.rejects(login(55,{last4:'9999'}), /fixture failure/);
      assert.equal((await query('select count(*)::integer n from user_profiles where user_id=$1',[id(55)]))[0].n,0);
      await assert.rejects(mutate(11,'bind',{last4:'9999'}), /fixture failure/);
      assert.equal((await query('select consumed_by from sunland_phone_auth_grants where proof_hash=$1',[h(2011)]))[0].consumed_by,null);
      assert.equal((await query('select count(*)::integer n from sunland_phone_auth_operations where operation_id=$1',[id(3011)]))[0].n,0);
      assert.equal((await query('select version from sunland_phone_auth_state where user_id=$1',[id(11)]))[0].version,0);
    });
    await t.test('deleting locks phone; retiring needs successful fenced deletion and releases atomically', async () => {
      const job=id(12001), attempt='fixture_attempt_12001';
      await query('insert into account_deletion_jobs(id,user_id,token_hash,status,expires_at,lease_expires_at,recovery_expires_at,attempt_id,fencing_version) values($1,$2,$3,\'in_progress\',now()+interval \'10 minutes\',now()+interval \'90 seconds\',now()+interval \'7 days\',$4,1)',[job,id(1),h(12001),attempt]);
      await query('update user_profiles set identity_status=\'deleting\',deletion_job_id=$1,deletion_attempt_id=$2,deletion_fencing_version=1 where user_id=$3',[job,attempt,id(1)]);
      assert.equal((await login(1,{operation_id:id(13001),request_hash:h(13001)})).code,'ACCOUNT_NOT_ACTIVE');
      await assert.rejects(query('update user_profiles set identity_status=\'retired\' where user_id=$1',[id(1)]), /DELETION_CONFLICT/);
      assert.equal((await query('select identity_status from user_profiles where user_id=$1',[id(1)]))[0].identity_status,'deleting');
      await query('update account_deletion_jobs set data_deleted_at=now() where id=$1',[job]);
      await query('update user_profiles set identity_status=\'retired\' where user_id=$1',[id(1)]);
      assert.equal((await query('select count(*)::integer n from sunland_phone_identities where user_id=$1',[id(1)]))[0].n,0);
      const replacement=await login(1,{candidate_id:id(20),operation_id:id(14001),request_hash:h(14001)});
      assert.equal(replacement.user_id,id(20)); assert.notEqual(replacement.user_id,id(1));
    });
    await t.test('retirement rejects stale fence, lost lease, mismatched owner and failed cleanup', async () => {
      await login(90);
      const job=id(19090),attempt='fixture_attempt_19090';
      await query('insert into account_deletion_jobs(id,user_id,token_hash,status,expires_at,lease_expires_at,recovery_expires_at,attempt_id,fencing_version,data_deleted_at) values($1,$2,$3,\'in_progress\',now()+interval \'10 minutes\',now()+interval \'90 seconds\',now()+interval \'7 days\',$4,2,now())',[job,id(90),h(19090),attempt]);
      await query('update user_profiles set identity_status=\'deleting\',deletion_job_id=$1,deletion_attempt_id=$2,deletion_fencing_version=1 where user_id=$3',[job,attempt,id(90)]);
      const retire=()=>query('update user_profiles set identity_status=\'retired\' where user_id=$1',[id(90)]);
      await assert.rejects(retire(),/DELETION_CONFLICT/);
      await query('update user_profiles set deletion_fencing_version=2 where user_id=$1',[id(90)]);
      for (const [patch,restore] of [
        ["lease_expires_at=now()-interval '1 second'","lease_expires_at=now()+interval '90 seconds'"],
        ["recovery_expires_at=now()-interval '1 second'","recovery_expires_at=now()+interval '7 days'"],
        ["attempt_id='wrong_attempt_19090'",`attempt_id='${attempt}'`],
        ['data_deleted_at=null','data_deleted_at=now()'],
        ["status='pending'","status='in_progress'"]
      ]) {
        await query(`update account_deletion_jobs set ${patch} where id=$1`,[job]);
        await assert.rejects(retire(),/DELETION_CONFLICT/);
        assert.equal((await query('select count(*)::integer n from sunland_phone_identities where user_id=$1',[id(90)]))[0].n,1);
        await query(`update account_deletion_jobs set ${restore} where id=$1`,[job]);
      }
      await retire();
      assert.equal((await query('select count(*)::integer n from sunland_phone_identities where user_id=$1',[id(90)]))[0].n,0);
      await profile(91); // Existing email-only retirement semantics are unchanged.
      await query('update user_profiles set identity_status=\'retired\' where user_id=$1',[id(91)]);
    });
    await t.test('retirement removes prior operation snapshots even after phone was unbound', async () => {
      // A historical/pre-fix snapshot fixture verifies cleanup of existing rows.
      await profile(93); await grant(93,'bind');
      assert.equal((await mutate(93,'bind',{phone_hash:h(93)})).code,'OK');
      await login(93);
      await grant(93,'unbind',{proof_hash:h(93001)});
      assert.equal((await mutate(93,'unbind',{proof_hash:h(93001),operation_id:id(93001),request_hash:h(93001)})).code,'OK');
      await query('update sunland_phone_auth_operations set result=result||jsonb_build_object(\'email\',\'old93@example.test\') where user_id=$1',[id(93)]);
      await query('update user_profiles set identity_status=\'retired\' where user_id=$1',[id(93)]);
      assert.equal((await query('select count(*)::integer n from sunland_phone_auth_operations where user_id=$1',[id(93)]))[0].n,0);
      const retiredRelease=await query('select action,result from sunland_phone_auth_operations where user_id=$1',[id(1)]);
      assert.deepEqual(retiredRelease,[{action:'release',result:{code:'OK',released:true}}]);
    });
    await t.test('banned identities cannot login/bind but can authorize deletion', async () => {
      await query('update user_profiles set is_banned=true where user_id=$1',[id(20)]);
      assert.equal((await login(1,{operation_id:id(15001),request_hash:h(15001)})).code,'ACCOUNT_BANNED');
      assert.equal((await grant(20,'delete',{method:'phone',subject:h(1),proof_hash:h(16001)})).code,'OK');
      const authorized=await call('delete_authorize',{user_id:id(20),session_hash:h(70),proof_hash:h(16001),operation_id:id(16001),request_hash:h(16001),token_hash:h(16002)});
      assert.equal(authorized.code,'OK'); assert.equal(authorized.expires_in,600);
      assert.equal((await query('select status from account_deletion_jobs where id=$1',[authorized.deletion_job_id]))[0].status,'pending');
    });
    await t.test('invalid inputs, missing factors, duplicate binding and one-time grants fail closed', async () => {
      assert.equal((await call('unknown')).code,'INVALID_REQUEST');
      assert.equal((await call('status',{user_id:'../evil'})).code,'INVALID_REQUEST');
      assert.equal((await login(99,{candidate_id:'guest'})).code,'INVALID_REQUEST');
      assert.equal((await login(99,{phone_hash:'plaintext-phone'})).code,'INVALID_REQUEST');
      assert.equal((await grant(10,'bind',{subject:'other@example.test'})).code,'REAUTH_INVALID');
      await grant(21,'bind',{proof_hash:h(2122)});
      assert.equal((await mutate(21,'bind',{proof_hash:h(2122),operation_id:id(2122),request_hash:h(2122)})).code,'PHONE_ALREADY_BOUND');
      await grant(11,'bind',{proof_hash:h(11111)});
      const change={proof_hash:h(11111),operation_id:id(11111),request_hash:h(11111)};
      assert.equal((await mutate(11,'bind',change)).code,'OK');
      assert.equal((await mutate(11,'bind',{...change,operation_id:id(11112),request_hash:h(11112)})).code,'REAUTH_INVALID');
      assert.equal((await mutate(82,'bind',{operation_id:id(11111),request_hash:h(11111)})).code,'OPERATION_CONFLICT');
    });
    await t.test('ordinary clients cannot read tables or invoke privileged RPC', async () => {
      for (const role of ['anon','authenticated']) {
        await db.exec(`set role ${role}`);
        await assert.rejects(query('select * from public.sunland_phone_identities'), /permission denied/);
        await assert.rejects(call('status',{user_id:id(10)}), /permission denied/);
        await db.exec('reset role');
      }
      await db.exec('set role service_role');
      assert.equal((await call('status',{user_id:id(10)})).code,'OK');
      await assert.rejects(query('update sunland_phone_auth_config set lookup_key_id=\'rotated\''), /permission denied/);
      await db.exec('reset role');
      const metadata=await query("select relname,relrowsecurity from pg_class where relname in ('sunland_phone_identities','sunland_phone_auth_state','sunland_phone_auth_grants','sunland_phone_auth_operations','sunland_phone_auth_config')");
      assert.equal(metadata.length,5); assert.ok(metadata.every(r=>r.relrowsecurity));
    });
  } finally { await db.close(); }
});
