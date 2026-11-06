#!/usr/bin/env python3
"""Isolated Docker, actual phone migration, stub non-phone tables, synthetic data only.

Set PHONE_IDENTITY_MIGRATION to the reviewed 20261024003756_phone_identity.sql.
Requires psycopg 3, Docker, and a local postgres:16-alpine image.
"""
import importlib.util
import os
from pathlib import Path
import subprocess
import threading
import time
import uuid
import psycopg

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('phone_init', root / 'operations/initialize-db.py')
op = importlib.util.module_from_spec(spec)
spec.loader.exec_module(op)
migration = Path(os.environ['PHONE_IDENTITY_MIGRATION']).read_text()
assert 'create table public.sunland_phone_auth_config' in migration
name = 'phone-full-schema-' + uuid.uuid4().hex[:12]
image = 'public.ecr.aws/docker/library/postgres:16-alpine'
password = 'synthetic-isolated-database-only'

def run(args):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=30).stdout.strip()

def connect():
    return psycopg.connect(host='127.0.0.1', port=port, dbname='postgres', user='postgres', password=password, connect_timeout=2)

try:
    run(['docker','run','-d','--rm','--name',name,'--network','bridge','-p','127.0.0.1::5432',
         '--tmpfs','/var/lib/postgresql/data:rw,size=256m','-e','POSTGRES_PASSWORD='+password,image,'postgres','-c','fsync=off'])
    port = int(run(['docker','port',name,'5432/tcp']).rsplit(':',1)[1])
    for _ in range(160):
        try:
            conn = connect()
            break
        except psycopg.OperationalError:
            time.sleep(.25)
    else: raise RuntimeError('isolated database unavailable')
    with conn:
        conn.execute('create role anon; create role authenticated; create role service_role')
        # Columns and constraints match production catalog as of 2026-11-06;
        # unrelated triggers and their dependencies remain deliberately absent.
        conn.execute("create schema extensions; create extension pgcrypto with schema extensions")
        conn.execute('''create table public.user_profiles(
           user_id text primary key, avatar_url text, avatar_path text, updated_at timestamptz default now(),
           name text, pro boolean not null default false, email text, created_at timestamptz default now(),
           is_banned boolean not null default false, ban_reason text, identity_status text not null default 'active',
           deletion_job_id uuid, deletion_attempt_id text, deletion_fencing_version bigint not null default 0,
           deletion_started_at timestamptz, retired_at timestamptz, profile_sanitized_at timestamptz,
           onboarding_version smallint not null default 0, onboarding_step smallint not null default 1,
           check (identity_status in ('active','deleting','retired')),
           check ((onboarding_version=0 and onboarding_step between 1 and 3) or (onboarding_version=1 and onboarding_step=3)));
           create table public.account_deletion_jobs(
           id uuid primary key default extensions.gen_random_uuid(), user_id text not null, token_hash text not null unique,
           status text not null default 'pending', claimed_at timestamptz, lease_expires_at timestamptz,
           attempt_id text, fencing_version bigint not null default 0, expires_at timestamptz not null,
           recovery_expires_at timestamptz, legacy_avatar_path text, external_revoked_at timestamptz,
           data_deleted_at timestamptz, completed_at timestamptz, created_at timestamptz not null default now(),
           identity_retired_at timestamptz, profile_sanitized_at timestamptz,
           check (status in ('pending','in_progress','completed')),
           check (user_id ~ '^[A-Za-z0-9][A-Za-z0-9@._+-]{0,127}$'))''')
        conn.commit()
        conn.execute(migration)
        # Actual privilege configuration and phone schema, no customer profile schema assumed.
        assert conn.execute("select count(*) from pg_tables where schemaname='public' and tablename like 'sunland_phone_%' and rowsecurity").fetchone()[0] == 5
        conn.execute("insert into public.user_profiles(user_id) values ('synthetic')")
        conn.commit()
        # Real two-connection race: one commit, one rejected; no overwrites.
        barrier = threading.Barrier(2); outcomes = []; failures = []
        def do_init(value):
            try:
                with connect() as c:
                    op.secure_logging(c); barrier.wait(timeout=10)
                    outcomes.append(op.initialize(c, value * 64))
            except Exception as exc: failures.append(type(exc).__name__)
        a = threading.Thread(target=do_init,args=('a',)); b = threading.Thread(target=do_init,args=('b',))
        a.start(); b.start(); a.join(25); b.join(25)
        assert not a.is_alive() and not b.is_alive() and not failures, failures
        assert sorted(outcomes) == ['committed','rejected']
        saved = conn.execute('select lookup_key_id,lookup_check from public.sunland_phone_auth_config').fetchone()
        assert saved[0] == 'v1' and saved[1] in ('a'*64,'b'*64)
        assert op.initialize(conn, 'c'*64) == 'rejected'
        assert conn.execute('select lookup_key_id,lookup_check from public.sunland_phone_auth_config').fetchone() == saved
        conn.rollback()
        # Each actual phone table must block initialization when already populated.
        conn.execute('update public.sunland_phone_auth_config set lookup_key_id=null,lookup_check=null')
        conn.commit()
        inserts = [
          "insert into public.sunland_phone_identities(user_id,phone_hash,lookup_key_id,encrypted_phone,last4) values ('synthetic',repeat('a',64),'v1','synthetic-cipher','0000')",
          "insert into public.sunland_phone_auth_state(user_id) values ('synthetic')",
          "insert into public.sunland_phone_auth_grants(proof_hash,user_id,session_hash,version,purpose,method,subject_fingerprint,expires_at) values (repeat('b',64),'synthetic',repeat('c',64),0,'bind','email',repeat('d',64),now()+interval '1 minute')",
          "insert into public.sunland_phone_auth_operations(operation_id,request_hash,user_id,action,result) values (gen_random_uuid(),repeat('e',64),'synthetic','login','{}'::jsonb)",
        ]
        for table, insert in zip(op.TABLES, inserts):
            conn.execute(insert); conn.commit(); op.secure_logging(conn)
            assert op.initialize(conn,'d'*64) == 'rejected', table
            assert conn.execute('select lookup_key_id is null and lookup_check is null from public.sunland_phone_auth_config').fetchone() == (True,)
            conn.execute('delete from public.' + table); conn.commit()
        # The real RPC must block on the same advisory lock and then observe committed configuration.
        conn.execute('update public.sunland_phone_auth_config set lookup_key_id=null,lookup_check=null')
        conn.commit()
        conn.execute('select pg_advisory_xact_lock(20261024,2)')
        result=[]; started=threading.Event()
        def rpc():
            try:
                with connect() as c:
                    started.set()
                    row=c.execute("select public.sunland_phone_identity('status', jsonb_build_object('user_id','synthetic','lookup_key_id','v1','lookup_check',%s::text))",('d'*64,)).fetchone()[0]
                    result.append(row.get('code'))
            except Exception as exc: failures.append(type(exc).__name__)
        t=threading.Thread(target=rpc);t.start();assert started.wait(10)
        time.sleep(.25); assert t.is_alive(), 'RPC did not wait for advisory lock'
        op.secure_logging(conn); assert op.initialize(conn, 'd'*64)=='committed'
        t.join(15); assert not t.is_alive() and not failures and result==['OK'], (failures,result)
        # LOCAL settings must reset after commit; protect verification in a fresh transaction.
        op.secure_logging(conn)
        assert conn.execute("select current_setting('log_parameter_max_length'), current_setting('log_parameter_max_length_on_error')").fetchone()==('0','0')
        conn.rollback()
        # PostgreSQL forbids unprivileged settings: guard must stop before writes.
        conn.execute('create role unprivileged');conn.commit();conn.execute('set role unprivileged')
        try:
            op.secure_logging(conn)
            raise AssertionError('unprivileged role unexpectedly changed logging')
        except psycopg.errors.InsufficientPrivilege:
            conn.rollback()
    print('PASS actual phone migration: 5 RLS tables; psycopg concurrent initialization, no overwrite, RPC lock, local logging and denied privilege')
finally:
    subprocess.run(['docker','rm','-f',name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
