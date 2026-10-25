// Synthetic local-only reproduction of the production postgres/public default ACL.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
try {
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    alter default privileges for role postgres in schema public
      grant select,insert,update,delete on tables to anon,authenticated;
    alter default privileges for role postgres in schema public
      grant all on tables to service_role;
    create table public.user_profiles(user_id text primary key);
  `);
  const source = await readFile(new URL('../supabase/migrations/20261024003756_phone_identity.sql', import.meta.url),'utf8');
  const cut = source.indexOf('create function public.sunland_phone_identity(');
  assert.ok(cut > 0, 'reviewed phone table/ACL boundary must exist');
  await db.exec(source.slice(0,cut) + '\ncommit;');
  const business = ['identities','auth_state','auth_grants','auth_operations'];
  const tables = ['auth_config',...business].map(name=>`public.sunland_phone_${name}`);
  let checks = 0;
  for (const table of tables) {
    for (const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) {
      for (const role of ['anon','authenticated','service_role']) {
        const result = await db.query('select has_table_privilege($1,$2,$3) as allowed',[role,table,privilege]);
        const expected = role === 'service_role' && (table.endsWith('auth_config') ? privilege === 'SELECT' : ['SELECT','INSERT','UPDATE','DELETE'].includes(privilege));
        assert.equal(result.rows[0].allowed,expected,`${role} ${privilege} ${table}`);
        checks++;
      }
    }
  }
  await db.exec('set role service_role');
  await assert.rejects(db.exec("update public.sunland_phone_auth_config set lookup_key_id='synthetic-only'"),/permission denied/);
  await db.exec('reset role');
  console.log(`PASS ${checks} effective table privilege checks plus runtime config UPDATE rejection; synthetic local data only`);
} finally {
  await db.close();
}
