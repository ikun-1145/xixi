// Owned, synthetic PostgreSQL 16 / PostgREST 14.14 fixture. Never loads production credentials.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
export const quote = value => `'${String(value).replaceAll("'", "''")}'`;
export function command(args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let errors = '';
    child.stdout.on('data', c => { output += c; }); child.stderr.on('data', c => { errors += c; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(errors.trim() || `Docker exited ${code}`)));
    child.stdin.end(input);
  });
}
export async function startLocalStack({ rest = false, admission = true } = {}) {
  if (process.env.AFDIAN_DOCKER_PG !== 'true') throw new Error('Set AFDIAN_DOCKER_PG=true to authorize owned synthetic local containers');
  const owner = randomUUID(); const label = `afdian-test-owner=${owner}`;
  const stack = { owner, containers: [], network: null };
  stack.close = async () => {
    if(stack.proxy){for(const socket of stack.sockets)socket.destroy();await new Promise(resolve=>stack.proxy.close(resolve));}
    for (const container of stack.containers.reverse()) {
      assert.equal(await command(['inspect', '--format', '{{index .Config.Labels "afdian-test-owner"}}', container]), owner);
      await command(['rm', '-f', container]);
    }
    if (stack.network) {
      assert.equal(await command(['network', 'inspect', '--format', '{{index .Labels "afdian-test-owner"}}', stack.network]), owner);
      await command(['network', 'rm', stack.network]);
    }
  };
  try {
    if (rest) stack.network = await command(['network', 'create', '--internal', '--label', label, `afdian-test-${owner}`]);
    stack.pg = await command(['run', '-d', '--name', `afdian-pg-${owner}`, '--label', label,
      '--network', stack.network || 'none', ...(rest ? ['--network-alias', 'db'] : []),
      '--tmpfs', '/var/lib/postgresql/data:rw', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
      'public.ecr.aws/docker/library/postgres:16-alpine']);
    stack.containers.push(stack.pg);
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { await command(['exec', stack.pg, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); ready = true; break; }
      catch { await delay(100); }
    }
    assert.ok(ready, 'Owned PostgreSQL did not become ready');
    stack.sql = statement => command(['exec', '-i', stack.pg, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1'],
      `set statement_timeout='15s'; set lock_timeout='10s'; ${statement}`);
    stack.result = async statement => JSON.parse((await stack.sql(statement)).split('\n').filter(Boolean).at(-1));
  const base = await read('supabase/migrations/20260905014430_pro_payment_activation_reliability.sql');
  await stack.sql(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema extensions; create function extensions.gen_random_uuid() returns uuid language sql as $$select gen_random_uuid()$$;
    create schema auth; create function auth.jwt() returns jsonb language sql as $$select '{}'::jsonb$$;
    create table public.user_profiles(user_id text primary key,pro boolean default false,
      identity_status text default 'active',is_banned boolean default false,updated_at timestamptz default now());
    create table public.pro_activations(id uuid default gen_random_uuid(),user_id text,source text,order_id text unique,
      activated_at timestamptz default now(),created_at timestamptz default now());
    grant select,insert,update on public.user_profiles,public.pro_activations to service_role;
    ${base.slice(base.indexOf('create table'), base.indexOf('create or replace function'))}
    ${await read('tests/fixtures/waffo-legacy-payment-rpc.sql')}
    ${await read('workers/afdianpay/merchandise-backend/live-rpc-baseline.sql')}
    ${await read('workers/afdianpay/merchandise-backend/live-deletion-baseline.sql')}
    create trigger pro_payment_orders_serialize_insert before insert on public.pro_payment_orders
      for each row execute function public.sunland_serialize_pro_payment_order_insert();
    begin;
    ${await read('supabase/migrations/20261002071010_waffo_production_entitlement_sources.sql')}
    commit;
    ${await read('supabase/migrations/20261005122300_afdian_merchandise_verified_reconciliation.sql')}
    ${admission ? await read('supabase/migrations/20261011030000_afdian_scan_admission.sql') : ''}`);
    const additional = await command(['exec', stack.pg, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-A', '-t', '-q', '-c', 'select version();']);
    assert.match(additional, /PostgreSQL 16\./); stack.version = additional;
    if (rest) {
      const secret = `synthetic-local-only-${owner}-jwt-secret`;
      stack.token = (role, id) => {
        const encode = x => Buffer.from(JSON.stringify(x)).toString('base64url');
        const text = encode({alg:'HS256',typ:'JWT'}) + '.' + encode({role,id,exp:Math.floor(Date.now()/1000)+3600});
        return text + '.' + createHmac('sha256', secret).update(text).digest('base64url');
      };
      stack.service = stack.token('service_role');
      await stack.sql(`create role authenticator login noinherit; grant anon,authenticated,service_role to authenticator;
        grant usage on schema public to anon,authenticated,service_role;
        grant usage on schema extensions to service_role;`);
      stack.rest = await command(['run', '-d', '--name', `afdian-rest-${owner}`, '--label', label,
        '--network', stack.network, '--network-alias', 'rest',
        '-e', 'PGRST_DB_URI=postgres://authenticator@db:5432/postgres', '-e', 'PGRST_DB_SCHEMAS=public',
        '-e', 'PGRST_DB_ANON_ROLE=anon', '-e', `PGRST_JWT_SECRET=${secret}`,
        'public.ecr.aws/supabase/postgrest:v14.14']);
      stack.containers.push(stack.rest);
      // Docker internal networks deliberately have no host-published ports. Relay real
      // HTTP bytes via nc inside our owned PG container; PostgREST still owns HTTP/SQL.
      stack.sockets=new Set();
      stack.proxy=createServer(socket=>{
        stack.sockets.add(socket);
        const relay=spawn('docker',['exec','-i',stack.pg,'nc','rest','3000'],{stdio:['pipe','pipe','pipe']});
        socket.pipe(relay.stdin);relay.stdout.pipe(socket);
        relay.on('error',()=>socket.destroy());relay.stdin.on('error',()=>socket.destroy());
        relay.on('close',()=>socket.end());socket.on('error',()=>{});
        socket.on('close',()=>{stack.sockets.delete(socket);relay.kill();});
      });
      await new Promise((resolve,reject)=>{stack.proxy.once('error',reject);stack.proxy.listen(0,'127.0.0.1',resolve);});
      stack.endpoint=`http://127.0.0.1:${stack.proxy.address().port}`;
      stack.api = async (path, method='GET', body=null, auth=stack.service) => {
        const response = await fetch(`${stack.endpoint}/${path}`, {method,headers:{Authorization:`Bearer ${auth}`,'Content-Type':'application/json',Prefer:'return=representation'},...(body ? {body:JSON.stringify(body)} : {})});
        const data = await response.json().catch(() => null);
        assert.ok(response.ok, JSON.stringify({status:response.status,data})); return data;
      };
      let restReady = false;
      for (let i=0;i<100;i++) {
        try { const response=await fetch(stack.endpoint); if(response.ok){restReady=true;break;} } catch {}
        await delay(100);
      }
      assert.ok(restReady,'Owned PostgREST did not become ready');
    }
    return stack;
  } catch(error) { await stack.close(); throw error; }
}
