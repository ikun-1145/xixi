#!/usr/bin/env python3
"""Production initialization; execute only with separate authorization.

Requires psycopg 3, libpq TLS root configuration and a protected PGPASSFILE.
Pass the existing lookup key on stdin without a newline. Never retry an unknown commit.
"""
import hashlib
import hmac
import os
from pathlib import Path
import secrets
import stat
import sys

HOST = 'db.klyrasrqgxijwrxuoevj.supabase.co'
POOLER_HOST = 'aws-0-ap-southeast-1.pooler.supabase.com'
POOLER_USER = 'postgres.klyrasrqgxijwrxuoevj'
TABLES = ('sunland_phone_identities', 'sunland_phone_auth_state',
          'sunland_phone_auth_grants', 'sunland_phone_auth_operations')
UPDATE = '''UPDATE public.sunland_phone_auth_config
SET lookup_key_id = %s, lookup_check = %s
WHERE singleton = true AND lookup_key_id IS NULL AND lookup_check IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.sunland_phone_identities)
  AND NOT EXISTS (SELECT 1 FROM public.sunland_phone_auth_state)
  AND NOT EXISTS (SELECT 1 FROM public.sunland_phone_auth_grants)
  AND NOT EXISTS (SELECT 1 FROM public.sunland_phone_auth_operations)
RETURNING singleton'''


def secure_logging(conn):
    # LOCAL confines both changes to this transaction. Do not suppress audit logs.
    # An unprivileged operator must fail closed before sending sensitive parameters.
    conn.execute("SET LOCAL log_parameter_max_length = 0")
    conn.execute("SET LOCAL log_parameter_max_length_on_error = 0")
    settings = conn.execute("SELECT current_setting('log_parameter_max_length'), current_setting('log_parameter_max_length_on_error'), current_setting('transaction_isolation'), current_setting('auto_explain.log_parameter_max_length', true), current_setting('pgaudit.log_parameter', true)").fetchone()
    if settings[3] not in (None, '0'):
        # auto_explain can log bind parameters independently of server log limits.
        conn.execute("SET LOCAL auto_explain.log_parameter_max_length = 0")
        settings = conn.execute("SELECT current_setting('log_parameter_max_length'), current_setting('log_parameter_max_length_on_error'), current_setting('transaction_isolation'), current_setting('auto_explain.log_parameter_max_length', true), current_setting('pgaudit.log_parameter', true)").fetchone()
    if settings[:3] != ('0', '0', 'read committed') or settings[3] not in (None, '0') or settings[4] not in (None, 'off'):
        raise RuntimeError('unsafe logging or transaction isolation')


def pooler_parameters():
    # The explicitly configured passfile must be owned by this user and private.
    if any(os.environ.get(name) for name in ('PGPASSWORD', 'PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS')):
        raise ValueError('unexpected libpq environment override')
    path = os.environ.get('PGPASSFILE')
    if not path:
        raise ValueError('protected passfile required')
    info = Path(path).lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('unsafe passfile')
    return dict(host=POOLER_HOST, port=5432, user=POOLER_USER, dbname='postgres',
                sslmode='verify-full', connect_timeout=10)


def verify_pooler_identity(conn):
    info = conn.info
    if (info.host, info.port, info.user, info.dbname, info.ssl_in_use) != (POOLER_HOST, 5432, POOLER_USER, 'postgres', True):
        raise ValueError('unexpected pooler connection')
    if conn.execute("SELECT current_user = 'postgres', session_user = 'postgres', current_database() = 'postgres'").fetchone() != (True, True, True):
        raise ValueError('unexpected backend identity')


def probe_session_locks(first, second):
    # Synthetic advisory key, read-only transactions and ACCESS SHARE only.
    # The production initializer's stronger locks are tested in isolated PG17.
    key = secrets.randbits(63)
    try:
        for conn in (first, second):
            conn.execute('SET TRANSACTION READ ONLY')
            conn.execute("SET LOCAL lock_timeout = '250ms'")
            secure_logging(conn)
        pid = first.execute('SELECT pg_backend_pid()').fetchone()[0]
        if first.execute('SELECT pg_try_advisory_xact_lock(%s)', (key,)).fetchone() != (True,):
            raise RuntimeError('test lock unavailable')
        if second.execute('SELECT pg_try_advisory_xact_lock(%s)', (key,)).fetchone() != (False,):
            raise RuntimeError('advisory lock is not shared')
        first.execute('LOCK TABLE ' + ', '.join('public.' + t for t in TABLES) + ' IN ACCESS SHARE MODE NOWAIT')
        locked = first.execute("SELECT count(DISTINCT relation) FROM pg_locks WHERE pid = pg_backend_pid() AND granted AND mode = 'AccessShareLock' AND relation IN ('public.sunland_phone_identities'::regclass, 'public.sunland_phone_auth_state'::regclass, 'public.sunland_phone_auth_grants'::regclass, 'public.sunland_phone_auth_operations'::regclass)").fetchone()
        if locked != (4,):
            raise RuntimeError('table locks unavailable')
        first.rollback()
        if second.execute('SELECT pg_try_advisory_xact_lock(%s)', (key,)).fetchone() != (True,):
            raise RuntimeError('test lock did not release')
        second.rollback()
        if first.execute('SELECT pg_backend_pid()').fetchone() != (pid,):
            raise RuntimeError('backend session changed')
        first.rollback()
    finally:
        first.rollback()
        second.rollback()


def initialize(conn, digest):
    conn.execute("SET LOCAL lock_timeout = '10s'")
    conn.execute("SET LOCAL statement_timeout = '20s'")
    conn.execute('SELECT pg_advisory_xact_lock(20261024, 2)')
    conn.execute('LOCK TABLE ' + ', '.join('public.' + t for t in TABLES) + ' IN SHARE ROW EXCLUSIVE MODE')
    rows = conn.execute(UPDATE, ('v1', digest)).fetchall()
    if rows != [(True,)]:
        conn.rollback()
        return 'rejected'
    # An exception during commit is ambiguous; caller must never retry automatically.
    conn.commit()
    return 'committed'


def main():
    modes = {
        ('--execute',): 'direct',
        ('--execute', '--session-pooler'): 'pooler',
        ('--check-session-pooler',): 'check',
    }
    mode = modes.get(tuple(sys.argv[1:]))
    if not mode:
        print('Not executed. Read PREFLIGHT.md and obtain separate production authorization.')
        return 2
    try:
        import psycopg
        params = pooler_parameters() if mode in ('pooler', 'check') else dict(host=HOST, dbname='postgres', sslmode='verify-full', connect_timeout=10)
        with psycopg.connect(**params) as conn:
            if mode in ('pooler', 'check'):
                # Identity checks happen before any lookup key is read.
                verify_pooler_identity(conn)
                conn.rollback()
                with psycopg.connect(**params) as other:
                    verify_pooler_identity(other)
                    other.rollback()
                    probe_session_locks(conn, other)
                if mode == 'check':
                    print('Session Pooler TLS, identity, logging, advisory and access-share locks verified.')
                    return 0
            secure_logging(conn)
            key = sys.stdin.buffer.read(4097)
            if not 32 <= len(key) <= 4096 or b'\n' in key or b'\r' in key:
                raise ValueError('invalid key input')
            key.decode('utf-8')
            digest = hmac.new(key, b'sunland-phone-index-canary:v1\0', hashlib.sha256).hexdigest()
            del key
            result = initialize(conn, digest)
            if result != 'committed':
                print('Stopped: initialization preconditions did not match; transaction rolled back.')
                return 1
            secure_logging(conn)
            match = conn.execute('SELECT lookup_key_id = %s AND lookup_check = %s FROM public.sunland_phone_auth_config WHERE singleton', ('v1', digest)).fetchone()
            if match != (True,):
                print('Commit completed; verification inconclusive. Stop and investigate without retrying.')
                return 1
            print('Database initialization committed and matching configuration verified.')
            return 0
    except Exception:
        print('Stopped: operation failed or outcome may be unknown. Do not retry; verify state separately.')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
