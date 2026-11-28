import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { normalizeEmail } from './input.js';

const schema = 'sunland_membership';
const partnerPattern = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const quotaFields = {
  requests_per_minute: 6000,
  requests_per_day: 2147483647,
  emails_per_day: 2147483647,
  batch_limit: 100,
};

function mint(prefix) {
  const secret = prefix + randomBytes(32).toString('base64url');
  return [secret, createHash('sha256').update(secret).digest('hex')];
}

function requireMatch(pattern, value) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error('invalid_arguments');
  return value;
}

function optExpiry(options) {
  if (options.expiresAt === undefined) return null;
  const value = requireMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, options.expiresAt);
  if (new Date(value).toISOString().replace('.000Z', 'Z') !== value || Date.parse(value) <= Date.now()) {
    throw new Error('invalid_expiry');
  }
  return value;
}

export async function runAdmin(query, command, subject, options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('invalid_arguments');
  }

  async function one(sql, params = []) {
    const { rows } = await query(sql, params);
    if (rows.length !== 1) throw new Error('no_matching_record');
    return rows[0];
  }

  if (command === 'worker-issue') {
    const [secret, hash] = mint('slw_rpc_');
    const row = await one(`insert into ${schema}.worker_credentials(secret_hash) values ($1) returning id`, [hash]);
    return { ...row, rpc_token: secret };
  }
  if (command === 'worker-revoke') {
    return one(`update ${schema}.worker_credentials set revoked_at=coalesce(revoked_at,now())
      where id=$1 returning id`, [requireMatch(uuidPattern, subject)]);
  }

  if (command === 'key-disable' || command === 'key-revoke') {
    const column = command === 'key-disable' ? 'disabled_at' : 'revoked_at';
    return one(`update ${schema}.api_keys set ${column}=coalesce(${column},now())
      where id=$1 returning id, partner_id`, [requireMatch(uuidPattern, subject)]);
  }

  if (command === 'key-issue' || command === 'key-rotate') {
    const [secret, hash] = mint('sl_live_');
    const expiry = optExpiry(options);
    const row = command === 'key-issue'
      ? await one(`insert into ${schema}.api_keys(partner_id,key_hash,expires_at)
          values ($1,$2,$3) returning id,partner_id,expires_at`,
        [requireMatch(partnerPattern, subject), hash, expiry])
      : await one(`with old_key as (
          update ${schema}.api_keys set revoked_at=now()
          where id=$1 and revoked_at is null returning partner_id
        ) insert into ${schema}.api_keys(partner_id,key_hash,expires_at)
          select partner_id,$2,$3 from old_key returning id,partner_id,expires_at`,
        [requireMatch(uuidPattern, subject), hash, expiry]);
    return { ...row, api_key: secret };
  }

  const partner = requireMatch(partnerPattern, subject);
  switch (command) {
    case 'partner-create':
      return one(`insert into ${schema}.partners(id) values ($1) returning id`, [partner]);
    case 'partner-configure': {
      const limits = Object.entries(options);
      if (limits.length === 0 || limits.some(([field, value]) =>
        !Object.hasOwn(quotaFields, field) || !Number.isInteger(value) || value < 1 || value > quotaFields[field])) {
        throw new Error('invalid_limits');
      }
      const assignments = limits.map(([field], i) => `${field}=$${i + 2}`).join(',');
      return one(`update ${schema}.partners set ${assignments} where id=$1 returning id`,
        [partner, ...limits.map(([, value]) => value)]);
    }
    case 'partner-disable':
    case 'partner-enable':
      return one(`update ${schema}.partners set enabled=$2 where id=$1 returning id`,
        [partner, command === 'partner-enable']);
    case 'consent-grant': {
      const email = normalizeEmail(options.verifiedEmail);
      if (!email || typeof options.userId !== 'string' || !options.userId) throw new Error('invalid_consent');
      return one(`insert into ${schema}.authorizations(partner_id,user_id)
        select $1,p.user_id from public.user_profiles p
        where p.user_id=$2 and lower(p.email)=$3 and p.identity_status='active'
        on conflict (partner_id,user_id) do update set granted_at=now(),revoked_at=null
        where authorizations.revoked_at is not null
        returning partner_id`, [partner, options.userId, email]);
    }
    case 'consent-revoke':
      if (typeof options.userId !== 'string' || !options.userId) throw new Error('invalid_consent');
      return one(`update ${schema}.authorizations set revoked_at=coalesce(revoked_at,now())
        where partner_id=$1 and user_id=$2 returning partner_id`, [partner, options.userId]);
    default: throw new Error('unknown_command');
  }
}

async function main() {
  const [command, subject, ...flags] = process.argv.slice(2);
  const dsn = process.env.MEMBERSHIP_ADMIN_DATABASE_URL;
  if (!command || !dsn || flags.some(flag => flag !== '--json') || flags.length > 1) {
    throw new Error('invalid_arguments');
  }
  const url = new URL(dsn);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  // pg derives TLS configuration from these URL options, which would override the explicit policy below.
  for (const param of ['ssl', 'sslmode', 'sslrootcert', 'sslcert', 'sslkey']) url.searchParams.delete(param);
  const caFile = process.env.MEMBERSHIP_ADMIN_CA_FILE;
  const options = flags.includes('--json') ? JSON.parse(readFileSync(0, 'utf8')) : {};
  const { default: pg } = await import('pg');
  const client = new pg.Client({
    connectionString: url.toString(),
    ssl: local ? false : { rejectUnauthorized: true, ca: caFile ? readFileSync(caFile, 'utf8') : undefined },
    connectionTimeoutMillis: 5000,
    statement_timeout: 8000,
  });

  try {
    await client.connect();
    const result = await runAdmin(client.query.bind(client), command, subject, options);
    process.stdout.write(JSON.stringify(result) + '\n');
  } finally {
    await client.end();
  }
}

if (import.meta.main) {
  main().catch(() => {
    // PostgreSQL errors can contain parameters. Never print them.
    process.stderr.write('操作失败。请核对命令、参数、数据库访问及记录状态。\n');
    process.exitCode = 1;
  });
}
