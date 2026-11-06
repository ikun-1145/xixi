#!/usr/bin/env python3
"""Production initialization; execute only with separate authorization.

Requires psycopg 3, libpq TLS root configuration and a protected PGPASSFILE.
Pass the existing lookup key on stdin without a newline. Never retry an unknown commit.
"""
import hashlib
import hmac
import sys

HOST = 'db.klyrasrqgxijwrxuoevj.supabase.co'
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
    if sys.argv != [sys.argv[0], '--execute']:
        print('Not executed. Read PREFLIGHT.md and obtain separate production authorization.')
        return 2
    try:
        import psycopg
        key = sys.stdin.buffer.read(4097)
        if not 32 <= len(key) <= 4096 or b'\n' in key or b'\r' in key:
            raise ValueError('invalid key input')
        key.decode('utf-8')
        digest = hmac.new(key, b'sunland-phone-index-canary:v1\0', hashlib.sha256).hexdigest()
        del key
        with psycopg.connect(host=HOST, dbname='postgres', sslmode='verify-full', connect_timeout=10) as conn:
            # Do not send the digest unless server parameter logging is demonstrably disabled.
            settings = conn.execute("SELECT current_setting('log_statement'), current_setting('log_parameter_max_length'), current_setting('log_parameter_max_length_on_error'), current_setting('transaction_isolation')").fetchone()
            if settings != ('none', '0', '0', 'read committed'):
                conn.rollback()
                print('Stopped: database logging or isolation settings need independent review.')
                return 1
            result = initialize(conn, digest)
            if result != 'committed':
                print('Stopped: initialization preconditions did not match; transaction rolled back.')
                return 1
            # Only a boolean leaves the connection; never display the digest or parameters.
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
