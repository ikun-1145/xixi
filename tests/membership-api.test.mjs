import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { runAdmin } from '../workers/sunland-membership-api/admin.mjs';
import { createWorker } from '../workers/sunland-membership-api/worker.js';

const baseMigration = await readFile(new URL('../supabase/migrations/20261128131000_sunland_membership_api.sql', import.meta.url), 'utf8');
const directMigration = await readFile(
  new URL('../supabase/migrations/20261128143000_sunland_membership_direct_query.sql', import.meta.url), 'utf8',
);
const env = {
  SUPABASE_URL: 'https://database.example.invalid',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic',
};
const fixture = `
create role anon;
create role authenticated;
create role service_role;
create table public.user_profiles (
  user_id text primary key, email text, pro boolean not null default false,
  identity_status text not null default 'active', is_banned boolean not null default false
);
create unique index user_profiles_email_unique_idx on public.user_profiles(lower(email))
  where email is not null and identity_status is distinct from 'retired';
insert into public.user_profiles(user_id,email,pro,identity_status,is_banned) values
  ('paid','Paid@example.test',true,'active',false),
  ('legacy','legacy@example.test',true,'active',false),
  ('basic','basic@example.test',false,'active',false),
  ('expired','expired@example.test',false,'active',false),
  ('unauthorized','unauthorized@example.test',true,'active',false),
  ('revoked','revoked@example.test',true,'active',false),
  ('banned','banned@example.test',true,'active',true),
  ('deleting','deleting@example.test',true,'deleting',false),
  ('retired','retired@example.test',true,'retired',false),
  ('old-owner','reuse@example.test',true,'retired',false),
  ('new-owner','reuse@example.test',true,'active',false);
`;
const db = new PGlite();
const admin = (command, subject, options = {}) => runAdmin(db.query.bind(db), command, subject, options);
const approve = partner => admin('direct-query-enable', partner, { approvalRef: 'QA-123' });
const logs = [];
let partnerA;
let partnerB;
let upgradePartner;
const digest = key => createHash('sha256').update(key).digest('hex');
const rpc = (token, hash, emails, size) => db.query(
  'select public.sunland_membership_check($1,$2,$3,$4) as result', [token, hash, emails, size],
);
const worker = createWorker({
  log: entry => logs.push(entry),
  async fetchRpc(url, { method, body, headers, redirect }) {
    assert.equal(url.pathname, '/rest/v1/rpc/sunland_membership_check');
    assert.equal(method, 'POST');
    assert.equal(redirect, 'manual');
    assert.equal(headers.apikey, env.SUPABASE_PUBLISHABLE_KEY);
    const { p_worker_token, p_hash, p_emails, p_count } = JSON.parse(body);
    const { rows } = await rpc(p_worker_token, p_hash, p_emails, p_count);
    return Response.json(rows[0].result);
  },
});

function request(path, body, key = partnerA.api_key, overrides = {}, target = worker, config = env) {
  return target.fetch(new Request('https://worker.example.test' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify(body),
    ...overrides,
  }), config);
}

const verify = (email, key) => request('/v1/membership/verify', { email }, key);
const batch = (emails, key) => request('/v1/membership/batch', { emails }, key);

before(async () => {
  await db.exec(fixture);
  await db.exec(baseMigration);
  env.MEMBERSHIP_RPC_TOKEN = (await admin('worker-issue')).rpc_token;
  await admin('partner-create', 'partner-a');
  await admin('partner-create', 'partner-b');
  await admin('partner-create', 'upgrade-partner');
  upgradePartner = await admin('key-issue', 'upgrade-partner');
  partnerA = await admin('key-issue', 'partner-a', { expiresAt: '2099-12-01T00:00:00Z' });
  partnerB = await admin('key-issue', 'partner-b');
  for (const userId of ['paid', 'legacy', 'basic', 'expired', 'revoked', 'banned']) {
    await admin('consent-grant', 'partner-a', { userId, verifiedEmail: userId + '@example.test' });
  }
  await admin('consent-revoke', 'partner-a', { userId: 'revoked' });
  await db.exec(`
    insert into sunland_membership.authorizations(partner_id,user_id)
    values ('partner-a','old-owner'),('partner-a','deleting'),('upgrade-partner','paid')
  `);
  await db.exec(directMigration);
  await approve('partner-a');
});

after(() => db.close());

test('升级后默认关闭，管理员以审批编号为单个合作方开启，可随时关闭', async () => {
  assert.equal((await verify('paid@example.test', upgradePartner.api_key)).status, 403);
  assert.equal((await verify('paid@example.test', partnerB.api_key)).status, 403);
  await assert.rejects(admin('direct-query-enable', 'upgrade-partner'), /invalid_arguments/);
  await assert.rejects(db.exec(
    "update sunland_membership.partners set direct_query_enabled=true where id='upgrade-partner'",
  ), { code: '23514' });
  const approval = await approve('upgrade-partner');
  assert.equal(approval.direct_query_enabled, true);
  assert.equal(approval.direct_query_approval_ref, 'QA-123');
  assert.ok(approval.direct_query_approved_at);
  assert.equal((await verify('paid@example.test', upgradePartner.api_key)).status, 200);
  assert.equal((await batch(['paid@example.test'], partnerB.api_key)).status, 403);
  await admin('direct-query-disable', 'upgrade-partner');
  await admin('partner-enable', 'upgrade-partner');
  const denied = await verify('paid@example.test', upgradePartner.api_key);
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, 'access_disabled');
  assert.deepEqual((await db.query(
    "select daily_requests,daily_emails from sunland_membership.partners where id='upgrade-partner'",
  )).rows, [{ daily_requests: 1, daily_emails: 1 }]);
});

test('直接查询无授权记录或曾撤回授权的 Pro，只返回权威布尔值', async () => {
  assert.deepEqual(await (await verify(' PAID@Example.test ')).json(), { success: true, is_pro: true });
  assert.deepEqual(await (await verify('legacy@example.test')).json(), { success: true, is_pro: true });
  assert.deepEqual(await (await verify('unauthorized@example.test')).json(), { success: true, is_pro: true });
  assert.deepEqual(await (await verify('revoked@example.test')).json(), { success: true, is_pro: true });
  assert.deepEqual(await (await verify('reuse@example.test')).json(), { success: true, is_pro: true });
  for (const email of ['basic', 'expired', 'missing', 'banned', 'deleting', 'retired']) {
    assert.deepEqual(await (await verify(email + '@example.test')).json(), { success: true, is_pro: false });
  }
  await db.exec("update public.user_profiles set pro=false where user_id='paid'");
  assert.deepEqual(await (await verify('paid@example.test')).json(), { success: true, is_pro: false });
  await db.exec("update public.user_profiles set pro=true where user_id='paid'");
});

test('批量上限、规范去重、重复同步及授权记录保留', async () => {
  const emails = ['paid@example.test', ' PAID@EXAMPLE.TEST ',
    ...Array.from({ length: 98 }, (_, i) => `synthetic-${i}@example.test`)];
  const full = await (await batch([...emails.slice(1), 'last@example.test'])).json();
  assert.equal(full.results.length, 100);
  const first = await (await batch(emails)).json();
  assert.equal(first.results.length, 99);
  assert.deepEqual(first.results[0], { email: 'paid@example.test', is_pro: true });
  assert.ok(first.results.slice(1).every(item => item.is_pro === false));
  assert.deepEqual(await (await batch(emails)).json(), first);
  await admin('consent-revoke', 'partner-a', { userId: 'paid' });
  const { rows: [consent] } = await db.query(
    "select revoked_at from sunland_membership.authorizations where partner_id='partner-a' and user_id='paid'",
  );
  assert.ok(consent.revoked_at);
  assert.deepEqual(await (await verify('paid@example.test')).json(), { success: true, is_pro: true });
  await admin('consent-grant', 'partner-a', { userId: 'paid', verifiedEmail: 'paid@example.test' });
  assert.ok(logs.some(entry => entry.outcome === '200_anomalous_access'));
});

test('路由、请求格式、邮箱及流式请求体大小检查', async () => {
  for (const input of [[], [null], ['a..b@example.test'], ['a@-example.test'], ['K@example.test'],
    Array(101).fill('paid@example.test')]) {
    assert.equal((await batch(input)).status, 400);
  }
  assert.equal((await request('/v1/membership/verify', { phone: '+12345678900' })).status, 400);
  assert.equal((await request('/v1/membership/verify', {}, undefined, { body: '{' })).status, 400);
  assert.equal((await request('/v1/membership/verify', {}, undefined, { body: null })).status, 400);
  assert.equal((await request('/v1/membership/verify', { email: 'x'.repeat(33000) })).status, 413);
  const tooBig = await request('/v1/membership/verify', {}, undefined, {
    headers: { 'Content-Length': '40000', Authorization: 'Bearer ' + partnerA.api_key },
  });
  assert.equal(tooBig.status, 413);
  const health = await worker.fetch(new Request('https://worker.example.test/health'), {});
  assert.deepEqual(await health.json(), { status: 'ok' });
  assert.equal(health.headers.get('cdn-cache-control'), 'no-store');
  const wrongMethod = await request('/health', {});
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'GET');
  assert.equal((await request('/unknown', {})).status, 404);
});

test('无效、到期、禁用、吊销和原子轮换的密钥', async () => {
  assert.equal((await verify('paid@example.test', 'invalid')).status, 401);
  assert.equal((await verify('paid@example.test', 'sl_live_' + 'x'.repeat(43))).status, 401);
  await db.query(`insert into sunland_membership.api_keys(partner_id,key_hash,created_at,expires_at)
    values ('partner-b',$1,now()-interval '2 hours',now()-interval '1 hour')`, [digest('sl_live_' + 'y'.repeat(43))]);
  assert.equal((await verify('paid@example.test', 'sl_live_' + 'y'.repeat(43))).status, 401);
  await approve('partner-b');
  const key = await admin('key-issue', 'partner-b');
  await admin('key-disable', key.id);
  assert.equal((await verify('paid@example.test', key.api_key)).status, 403);
  const replacement = await admin('key-rotate', key.id);
  assert.equal((await verify('paid@example.test', key.api_key)).status, 401);
  assert.equal((await verify('paid@example.test', replacement.api_key)).status, 200);
  await admin('key-revoke', replacement.id);
  assert.equal((await verify('paid@example.test', replacement.api_key)).status, 401);
  await admin('partner-disable', 'partner-b');
  assert.equal((await verify('paid@example.test', partnerB.api_key)).status, 403);
  await admin('partner-enable', 'partner-b');
  assert.equal((await verify('paid@example.test', partnerB.api_key)).status, 200);
});

test('原子滚动分钟及每日配额对同一合作方的多把密钥生效', async () => {
  for (const [id, limits, size, allowed] of [
    ['minute', { requests_per_minute: 3 }, 1, 3],
    ['daily', { requests_per_day: 2 }, 1, 2],
    ['emails', { emails_per_day: 5 }, 2, 2],
  ]) {
    await admin('partner-create', id);
    await approve(id);
    await admin('partner-configure', id, limits);
    const keys = await Promise.all([admin('key-issue', id), admin('key-issue', id)]);
    const responses = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      batch(Array(size).fill('paid@example.test'), keys[i % 2].api_key)));
    assert.equal(responses.filter(response => response.status === 200).length, allowed);
    for (const response of responses.filter(response => response.status !== 200)) {
      assert.equal(response.status, 429);
      assert.ok(Number(response.headers.get('retry-after')) > 0);
      if (id === 'minute') assert.ok(Number(response.headers.get('retry-after')) <= 60);
    }
  }
  await admin('partner-configure', 'daily', { batch_limit: 1 });
  const key = await admin('key-issue', 'daily');
  assert.equal((await batch(['a@example.test', 'b@example.test'], key.api_key)).status, 400);
  await db.exec(`update sunland_membership.partners set quota_day=quota_day-1 where id='daily'`);
  assert.equal((await verify('paid@example.test', key.api_key)).status, 200);
  await db.exec(`update sunland_membership.partners set recent_requests =
    array[now()-interval '61 seconds'] where id='minute'`);
  const rolled = await admin('key-issue', 'minute');
  assert.equal((await verify('paid@example.test', rolled.api_key)).status, 200);
});

test('数据库 credential 的范围、撤销、索引及敏感字段', async () => {
  const key = await admin('worker-issue');
  const call = token => rpc(token, digest(partnerA.api_key), ['paid@example.test'], 1);
  await db.exec('set role anon');
  await assert.rejects(db.query('select * from sunland_membership.api_keys'), { code: '42501' });
  await assert.rejects(db.query('select * from public.user_profiles'), { code: '42501' });
  assert.equal((await call('slw_rpc_' + 'z'.repeat(43))).rows[0].result.status, 503);
  assert.equal((await call(key.rpc_token)).rows[0].result.status, 200);
  await db.exec('reset role');
  await db.exec('set role authenticated');
  await assert.rejects(call(key.rpc_token), { code: '42501' });
  await db.exec('reset role');
  await admin('worker-revoke', key.id);
  assert.equal((await call(key.rpc_token)).rows[0].result.status, 503);

  await db.exec(`insert into public.user_profiles(user_id,email)
    select 'u'||n, 'u'||n||'@example.test' from generate_series(1,15000) n; analyze public.user_profiles`);
  const query = directMigration.match(/from unnest\(p_emails\) with ordinality[\s\S]+?profile on true/)[0]
    .replace('p_emails', '$1::text[]');
  const { rows } = await db.query('explain (format text) select profile.is_pro ' + query,
    [Array.from({ length: 100 }, (_, i) => `u${i}@example.test`)]);
  const plan = rows.map(item => item['QUERY PLAN']).join('\n');
  assert.match(plan, /Index Scan using user_profiles_email_unique_idx/);
  assert.doesNotMatch(plan, /Seq Scan on user_profiles/);

  const logged = JSON.stringify(logs);
  for (const secret of ['paid@example.test', env.MEMBERSHIP_RPC_TOKEN, partnerA.api_key, digest(partnerA.api_key)]) {
    assert.ok(!logged.includes(secret));
  }
  assert.deepEqual(Object.keys(logs[0]).sort(),
    ['count', 'duration_ms', 'outcome', 'partner', 'request_id', 'time']);
  const row = await db.query('select key_hash from sunland_membership.api_keys where id=$1', [partnerA.id]);
  assert.equal(row.rows[0].key_hash, digest(partnerA.api_key));
});

test('上游 HTTP 错误映射及 Worker 查询时限', async () => {
  const fail = createWorker({ log() {}, fetchRpc: async () => new Response('private database error', { status: 500 }) });
  const redirect = createWorker({ log() {}, fetchRpc: async () => Response.redirect('https://wrong.example.test') });
  const corrupt = createWorker({ log() {}, fetchRpc: async () => Response.json({ status: 200 }) });
  const slow = createWorker({ log() {}, fetchRpc: async (_url, { signal }) =>
    new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  for (const [target, status] of [[fail, 503], [redirect, 503], [corrupt, 500], [slow, 503]]) {
    const response = await request('/v1/membership/verify', { email: 'paid@example.test' }, undefined, {}, target);
    assert.equal(response.status, status);
    const payload = await response.json();
    assert.equal(payload.success, false);
    assert.equal(payload.request_id, response.headers.get('x-request-id'));
    assert.doesNotMatch(JSON.stringify(payload), /is_pro|private database error|paid@/);
  }
  assert.equal((await request('/v1/membership/verify', { email: 'paid@example.test' }, undefined, {},
    worker, {})).status, 500);
  assert.equal((await request('/v1/membership/verify', { email: 'paid@example.test' }, undefined, {},
    worker, { ...env, SUPABASE_PUBLISHABLE_KEY: 'sb_secret_synthetic' })).status, 500);
});
