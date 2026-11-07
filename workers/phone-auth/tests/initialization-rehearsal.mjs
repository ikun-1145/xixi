// Explicit local-only rehearsal: requires an existing PGlite installation.
// No network, production credentials, or production data are used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

if (!process.env.PHONE_PREFLIGHT_PACKAGE_ROOT) throw Error('Set PHONE_PREFLIGHT_PACKAGE_ROOT to a local package with @electric-sql/pglite');
const require = createRequire(resolve(process.env.PHONE_PREFLIGHT_PACKAGE_ROOT, 'package.json'));
const { PGlite } = require('@electric-sql/pglite');

test('initialization commits once and refuses existing identities or partially configured keys', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create table sunland_phone_auth_config(singleton boolean primary key check(singleton), lookup_key_id text, lookup_check text);
      insert into sunland_phone_auth_config values(true,null,null);
      create table sunland_phone_identities(user_id text primary key, encrypted_phone text not null);
      create table sunland_phone_auth_state(id text primary key);
      create table sunland_phone_auth_grants(id text primary key);
      create table sunland_phone_auth_operations(id text primary key);`);
    async function initialize(keyId, check) {
      await db.exec('begin');
      try {
        await db.exec('select pg_advisory_xact_lock(20261024,2); lock table sunland_phone_identities, sunland_phone_auth_state, sunland_phone_auth_grants, sunland_phone_auth_operations in share row exclusive mode');
        const result = await db.query(`update sunland_phone_auth_config set lookup_key_id=$1,lookup_check=$2
          where singleton=true and lookup_key_id is null and lookup_check is null
          and not exists (select 1 from sunland_phone_identities)
          and not exists (select 1 from sunland_phone_auth_state)
          and not exists (select 1 from sunland_phone_auth_grants)
          and not exists (select 1 from sunland_phone_auth_operations) returning singleton`, [keyId, check]);
        if (result.rows.length !== 1) { await db.exec('rollback'); return false; }
        await db.exec('commit'); return true;
      } catch (error) { await db.exec('rollback'); throw error; }
    }
    const check = 'a'.repeat(64); // Synthetic test data only.
    assert.equal(await initialize('v1', check), true);
    assert.equal(await initialize('v1', check), false);
    await db.exec("update sunland_phone_auth_config set lookup_key_id=null,lookup_check=null; insert into sunland_phone_identities values('synthetic','cipher')");
    assert.equal(await initialize('v1', check), false);
    let rows = (await db.query('select lookup_key_id,lookup_check from sunland_phone_auth_config')).rows;
    assert.deepEqual(rows, [{ lookup_key_id: null, lookup_check: null }]);
    await db.exec('delete from sunland_phone_identities');
    for (const table of ['sunland_phone_auth_state', 'sunland_phone_auth_grants', 'sunland_phone_auth_operations']) {
      await db.exec(`insert into ${table} values ('synthetic')`);
      assert.equal(await initialize('v1', check), false);
      await db.exec(`delete from ${table}`);
    }
    await db.exec("update sunland_phone_auth_config set lookup_key_id='old'");
    assert.equal(await initialize('v1', check), false);
    rows = (await db.query('select lookup_key_id,lookup_check from sunland_phone_auth_config')).rows;
    assert.deepEqual(rows, [{ lookup_key_id: 'old', lookup_check: null }]);
  } finally { await db.close(); }
});
