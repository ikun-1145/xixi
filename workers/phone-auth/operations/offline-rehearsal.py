#!/usr/bin/env python3
"""Rebuild a Supabase archive in a disposable, encrypted, offline container."""
import argparse
import hashlib
import json
import importlib.util
import os
from pathlib import Path
import secrets
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import re

IMAGE = 'supabase/postgres:17.4.1.054_arm64'
IMAGE_ID = 'sha256:17444ce49edc197aedcd4569e5c582d119fdf2b4dd06b51510f916fd05b1e97c'
DIAGNOSTIC = None


def run(args, *, data=None, timeout=90, check=True):
    result = subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=timeout, check=False)
    if check and result.returncode:
        if DIAGNOSTIC:
            DIAGNOSTIC.write_bytes(result.stderr)
        stage = next((item for item in ('psql', 'pg_dumpall', 'pg_restore', 'image', 'run', 'create', 'cp', 'restart') if item in args), 'other')
        raise RuntimeError('command failed at ' + stage + '; see protected diagnostic')
    return result


def main():
    global DIAGNOSTIC
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, help='mounted encrypted backup volume')
    parser.add_argument('--storage-key', required=True, help='existing 32-byte backup key file')
    args = parser.parse_args()
    root = Path(args.root).resolve(strict=True)
    key = Path(args.storage_key).resolve(strict=True)
    if not key.is_file() or key.stat().st_size != 32 or stat.S_IMODE(key.stat().st_mode) != 0o600:
        raise ValueError('protected 32-byte storage backup key required')
    import plistlib
    images = plistlib.loads(run(['hdiutil', 'info', '-plist']).stdout)['images']
    if not any(i.get('image-encrypted') is True and any(e.get('mount-point') == str(root)
               for e in i.get('system-entities', [])) for i in images):
        raise ValueError('backup volume is not a verified encrypted mount')
    if b'(encrypted)' not in run(['sysctl', '-n', 'vm.swapusage']).stdout:
        raise ValueError('host swap encryption cannot be verified')
    os.umask(0o077)
    DIAGNOSTIC = root / ('diagnostic-' + secrets.token_hex(8) + '.log')
    manifest = json.loads((root / 'offline-recovery-tools-20261112/manifest.json').read_text())
    required = ('backup/native17-full.dump', 'backup/native17-roles2.sql', 'backup/production-database-acl.json',
                'storage-independent-3e04b9e0/storage.tar.aesgcm',
                'storage-independent-3e04b9e0/storage.tar.aesgcm.source.json',
                'storage-independent-3e04b9e0/inventory.json', 'offline-recovery-tools-20261112/aead-file.mjs',
                'offline-recovery-tools-20261112/storage_verify.py', 'offline-recovery-tools-20261112/extension-owner.sql')
    for relative in required:
        expected = manifest['files'][relative]
        path = (root / relative).resolve(strict=True)
        if root not in path.parents or not path.is_file():
            raise ValueError('unsafe manifest path')
        digest = hashlib.sha256()
        with path.open('rb') as source:
            for chunk in iter(lambda: source.read(1048576), b''):
                digest.update(chunk)
        if digest.hexdigest() != expected:
            raise ValueError('backup integrity mismatch')
    if run(['docker', 'image', 'inspect', IMAGE, '--format', '{{.Id}}']).stdout.decode().strip() != IMAGE_ID:
        raise ValueError('required preloaded official image does not match')
    os.umask(0o077)
    work = Path(tempfile.mkdtemp(prefix='phone-rehearsal-', dir=root))
    container = 'phone-rehearsal-' + secrets.token_hex(8)
    template = container + '-template'
    ownership = secrets.token_hex(16)
    passed = False
    try:
        for folder in ('data', 'tmp', 'run', 'custom'):
            (work / folder).mkdir(mode=0o700)
        (work / 'password').write_text(secrets.token_urlsafe(32))
        (work / 'passwd').write_text(f'restore:x:{os.getuid()}:{os.getgid()}:restore:/secure:/bin/sh\n')
        (work / 'pg_hba.conf').write_text('local all all scram-sha-256\n')
        run(['docker', 'create', '--name', template, '--label', 'dev.sunland.rehearsal=' + ownership,
             '--network', 'none', IMAGE])
        run(['docker', 'cp', template + ':/etc/postgresql-custom/.', str(work / 'custom')])
        run(['docker', 'rm', template])
        cmd = ['docker', 'run', '-d', '--name', container, '--label', 'dev.sunland.rehearsal=' + ownership,
               '--network', 'none',
               '--memory', '1024m', '--memory-swap', '1024m', '--read-only',
               '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--log-driver', 'none',
               '--user', f'{os.getuid()}:{os.getgid()}',
               '--mount', f'type=bind,src={work},dst=/secure',
               '--mount', f'type=bind,src={work / "data"},dst=/var/lib/postgresql/data',
               '--mount', f'type=bind,src={work / "custom"},dst=/etc/postgresql-custom',
               '--mount', f'type=bind,src={work / "passwd"},dst=/etc/passwd,readonly',
               '--mount', f'type=bind,src={work / "tmp"},dst=/tmp',
               '--mount', f'type=bind,src={work / "run"},dst=/var/run/postgresql',
               '-e', 'POSTGRES_USER=supabase_admin', '-e', 'POSTGRES_DB=postgres',
               '-e', 'POSTGRES_PASSWORD_FILE=/secure/password', '-e', 'POSTGRES_HOST=/var/run/postgresql',
               '-e', 'PGDATA=/var/lib/postgresql/data', '-e', 'TMPDIR=/secure/tmp',
               '-e', 'POSTGRES_INITDB_ARGS=--allow-group-access --locale-provider=icu --encoding=UTF-8 --icu-locale=en_US.UTF-8',
               IMAGE, 'postgres', '-D', '/var/lib/postgresql/data', '-c', 'config_file=/etc/postgresql/postgresql.conf',
               '-c', 'hba_file=/secure/pg_hba.conf', '-c', 'cron.launch_active_jobs=off',
               '-c', 'pg_net.database_name=xixi_offline_disabled', '-c', 'logging_collector=off']
        run(cmd)
        deadline = time.monotonic() + 150
        while time.monotonic() < deadline:
            if run(['docker', 'exec', container, 'pg_isready', '-h', '/var/run/postgresql'], check=False).returncode == 0:
                break
            if run(['docker', 'inspect', '--format', '{{.State.Running}}', container]).stdout.strip() != b'true':
                raise RuntimeError('isolated database exited during bootstrap')
            time.sleep(1)
        else:
            raise RuntimeError('isolated database bootstrap timed out')
        if run(['docker', 'exec', container, 'cat', '/sys/fs/cgroup/memory.swap.max']).stdout.strip() != b'0':
            raise RuntimeError('container swap is not disabled')
        info = json.loads(run(['docker', 'inspect', container]).stdout)[0]
        if info['HostConfig']['NetworkMode'] != 'none' or info['HostConfig']['LogConfig']['Type'] != 'none':
            raise RuntimeError('container isolation does not match')
        # pg_isready can succeed on the temporary server used by the image's
        # bootstrap scripts; wait for that server to shut down before proceeding.
        time.sleep(12)
        password = (work / 'password').read_text().strip()
        (work / 'pgpass').write_text('*:5432:*:supabase_admin:' + password.replace('\\', '\\\\').replace(':', '\\:') + '\n')
        common = ['docker', 'exec', '-i', '-e', 'PGPASSFILE=/secure/pgpass', container]

        def psql(sql, db='postgres'):
            return run(common + ['psql', '-h', '/var/run/postgresql', '-U', 'supabase_admin',
                                 '-d', db, '-v', 'ON_ERROR_STOP=1', '-Atq'], data=sql.encode()).stdout.decode()

        role_dump = (root / 'backup/native17-roles2.sql').read_text()
        if len(re.findall(r'^CREATE ROLE ', role_dump, re.M)) != 19:
            raise RuntimeError('role count differs from reviewed backup')
        existing = set(psql('SELECT rolname FROM pg_roles;').splitlines())
        lines = role_dump.splitlines()
        meta = [line.split() for line in lines if line.startswith('\\')]
        if len(meta) != 2 or meta[0][0] != '\\restrict' or meta[1][0] != '\\unrestrict' or meta[0][1:] != meta[1][1:]:
            raise ValueError('unexpected role dump psql commands')
        for index, line in enumerate(lines):
            if line.startswith('\\'):
                # PostgreSQL 17.4 psql predates the 17.11 restriction marker.
                # The authenticated dump is accepted only with this exact pair.
                lines[index] = '-- validated restriction marker'
                continue
            match = re.fullmatch(r'CREATE ROLE ([a-z_][a-z_0-9]*);', line)
            if match and match.group(1) in existing:
                lines[index] = '-- Existing official bootstrap role: ' + match.group(1)
        psql('BEGIN;\n' + '\n'.join(lines) + '\nCOMMIT;')
        actual_roles = run(common + ['pg_dumpall', '-h', '/var/run/postgresql', '-U', 'supabase_admin',
                                     '--roles-only', '--no-role-passwords']).stdout.decode()
        statements = lambda text: {x.strip() for x in text.splitlines() if x.startswith(('CREATE ROLE ', 'ALTER ROLE ', 'GRANT '))}
        if statements(role_dump) != statements(actual_roles):
            raise RuntimeError('role definitions or memberships differ from backup')
        psql('CREATE DATABASE xixi_restore_target WITH TEMPLATE template0 OWNER postgres;')
        acl = json.loads((root / 'backup/production-database-acl.json').read_text())
        grants = acl['grants']
        if acl['owner'] != 'postgres' or not acl['explicit_acl'] or not all(
                row[0] == 'postgres' and row[2] in ('CONNECT', 'CREATE', 'TEMPORARY') and not row[3]
                and (row[1] == 'PUBLIC' or re.fullmatch('[a-z_][a-z_0-9]*', row[1])) for row in grants):
            raise ValueError('unsupported database ACL baseline')
        quote = lambda name: 'PUBLIC' if name == 'PUBLIC' else '"' + name + '"'
        statements_acl = ['BEGIN', 'SET ROLE postgres']
        statements_acl += ['REVOKE ALL ON DATABASE xixi_restore_target FROM ' + quote(name)
                           for name in sorted({row[1] for row in grants})]
        statements_acl += ['GRANT ' + row[2] + ' ON DATABASE xixi_restore_target TO ' + quote(row[1]) for row in grants]
        psql(';\n'.join(statements_acl + ['COMMIT']) + ';')
        acl_query = """SELECT g.rolname,coalesce(r.rolname,'PUBLIC'),x.privilege_type,x.is_grantable
            FROM pg_database d CROSS JOIN LATERAL aclexplode(d.datacl) x
            LEFT JOIN pg_roles r ON r.oid=x.grantee JOIN pg_roles g ON g.oid=x.grantor
            WHERE d.datname='xixi_restore_target';"""
        actual_acl = {tuple(line.split('|')) for line in psql(acl_query).splitlines()}
        expected_acl = {(row[0], row[1], row[2], 't' if row[3] else 'f') for row in grants}
        if actual_acl != expected_acl:
            raise RuntimeError('database ACL differs from stored baseline')
        psql("ALTER SYSTEM SET cron.database_name = 'xixi_restore_target';")
        run(['docker', 'restart', container], timeout=60)
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if run(['docker', 'exec', container, 'pg_isready', '-h', '/var/run/postgresql'], check=False).returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError('database restart timed out')
        archive = (root / 'backup/native17-full.dump').read_bytes()
        toc = run(common + ['pg_restore', '--list'], data=archive, timeout=60).stdout.decode().splitlines()
        events = [line for line in toc if ' EVENT TRIGGER ' in line]
        if len(events) != 7 or 'ensure_rls postgres' not in events[0] or not all(x.endswith('supabase_admin') for x in events[1:]):
            raise RuntimeError('archive event trigger list differs from reviewed baseline')
        for filename, select_events in (('restore-main.list', False), ('restore-events.list', True)):
            (work / filename).write_text('\n'.join(line if ((line in events) == select_events) else ';' + line
                                                    for line in toc) + '\n')
        for name in ('restore-main.list', 'restore-events.list'):
            args_restore = common + ['pg_restore', '-h', '/var/run/postgresql', '-U', 'supabase_admin',
                                     '-d', 'xixi_restore_target', '--no-password', '--single-transaction',
                                     '--exit-on-error', '--use-list=/secure/' + name]
            if name == 'restore-events.list':
                args_restore.append('--use-set-session-authorization')
            result = run(args_restore, data=archive, timeout=240, check=False)
            if result.returncode:
                DIAGNOSTIC.write_bytes(result.stderr)
                raise RuntimeError('strict database restore failed; see protected diagnostic')
        psql((root / 'offline-recovery-tools-20261112/extension-owner.sql').read_text(), 'xixi_restore_target')
        db = 'xixi_restore_target'
        failures = []
        restore = common + ['pg_restore']
        source_schema = run(restore + ['--schema-only', '-f', '-'], data=archive, timeout=120).stdout.decode()
        target_schema = run(common + ['pg_dump', '-h', '/var/run/postgresql', '-U', 'supabase_admin',
                                       '-d', db, '--schema-only'], timeout=120).stdout.decode()
        acl_lines = lambda text: {x.strip() for x in text.splitlines()
                                  if x.startswith(('GRANT ', 'REVOKE ', 'ALTER DEFAULT PRIVILEGES '))}
        if acl_lines(source_schema) != acl_lines(target_schema):
            source_only = acl_lines(source_schema) - acl_lines(target_schema)
            target_only = acl_lines(target_schema) - acl_lines(source_schema)
            subjects = ('FUNCTION extensions.pg_stat_statements_reset(',
                        'TABLE extensions.pg_stat_statements ', 'TABLE extensions.pg_stat_statements_info ')
            if len(source_only) != 3 or len(target_only) != 7 or any(
                    not any(subject in line for subject in subjects) for line in source_only | target_only):
                failures.append('unexpected schema ACL statements differ')
            else:
                # pg_dump reports extension initial privileges relative to the role
                # that installed the extension. Reconstruct the three objects from
                # the same image under the archived owner and replay their ACLs.
                psql('CREATE DATABASE xixi_acl_reference WITH TEMPLATE template0 OWNER postgres;')
                reference_sql = 'CREATE SCHEMA extensions; CREATE EXTENSION pg_stat_statements WITH SCHEMA extensions;\n'
                owner_lines = (root / 'offline-recovery-tools-20261112/extension-owner.sql').read_text().splitlines()
                reference_owners = [line for line in owner_lines if any(subject in line for subject in
                    ('FUNCTION extensions.pg_stat_statements_reset(', 'VIEW extensions.pg_stat_statements ',
                     'VIEW extensions.pg_stat_statements_info '))]
                if len(reference_owners) != 3:
                    raise RuntimeError('extension owner reference is incomplete')
                reference_sql += '\n'.join(reference_owners) + '\n'
                reference_sql += '\n'.join(line for line in source_schema.splitlines()
                                            if line.startswith(('GRANT ', 'REVOKE '))
                                            and any(subject in line for subject in subjects))
                psql(reference_sql, 'xixi_acl_reference')
                canonical = """WITH objects AS (
                  SELECT c.relname AS name,c.oid,'r'::text AS kind,c.relowner AS owner,
                    coalesce(c.relacl,acldefault('r',c.relowner)) AS acl
                  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                  WHERE n.nspname='extensions' AND c.relname IN ('pg_stat_statements','pg_stat_statements_info')
                  UNION ALL SELECT p.proname,p.oid,'f',p.proowner,coalesce(p.proacl,acldefault('f',p.proowner))
                  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='extensions' AND p.proname='pg_stat_statements_reset')
                SELECT name,kind,pg_get_userbyid(owner),
                  ARRAY(SELECT concat_ws(':',coalesce((SELECT rolname FROM pg_roles WHERE oid=x.grantor),'PUBLIC'),
                    coalesce((SELECT rolname FROM pg_roles WHERE oid=x.grantee),'PUBLIC'),x.privilege_type,x.is_grantable)
                    FROM aclexplode(acl) x ORDER BY 1),
                  ARRAY(SELECT CASE WHEN kind='f' THEN has_function_privilege(r.rolname,objects.oid,'EXECUTE')
                    ELSE has_table_privilege(r.rolname,objects.oid,'SELECT') END
                    FROM pg_roles r WHERE r.rolname !~ '^pg_' ORDER BY r.rolname)
                FROM objects ORDER BY name;"""
                reconstructed = psql(canonical, 'xixi_acl_reference').splitlines()
                if len(reconstructed) != 3 or psql(canonical, db).splitlines() != reconstructed:
                    failures.append('extension ACL effective privileges differ from reconstructed baseline')
        for label, pattern in (
                ('policies', r'^CREATE POLICY .*?;'),
                ('row security', r'^ALTER TABLE [^\n;]+ (?:ENABLE|FORCE) ROW LEVEL SECURITY;'),
                ('triggers', r'^CREATE (?:EVENT )?TRIGGER .*?;')):
            a = set(re.findall(pattern, source_schema, re.M | re.S))
            b = set(re.findall(pattern, target_schema, re.M | re.S))
            if label == 'policies':
                # pg_dump orders policy roles by local OID, which changes across clusters.
                def normalize_roles(statement):
                    match = re.search(r'\bTO ([A-Za-z_][A-Za-z_0-9]*(?:, [A-Za-z_][A-Za-z_0-9]*)*)(?= (?:USING|WITH CHECK)|;)', statement)
                    if not match:
                        return statement
                    return statement[:match.start(1)] + ', '.join(sorted(match.group(1).split(', '))) + statement[match.end(1):]
                a = {normalize_roles(x) for x in a}
                b = {normalize_roles(x) for x in b}
            if a != b:
                (root / ('schema-diff-' + label.replace(' ', '-') + '-' + secrets.token_hex(8) + '.json')).write_text(
                    json.dumps({'source_only': sorted(a - b), 'target_only': sorted(b - a)}))
                failures.append(label + ' differ from backup')
        source_data = run(restore + ['--data-only', '-f', '-'], data=archive, timeout=120).stdout
        pattern = re.compile(rb'^COPY ((?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z_0-9$]*)\.(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z_0-9$]*)) \(.*\) FROM stdin;$')
        counts, name = {}, None
        for line in source_data.splitlines():
            if name is None and line.startswith(b'COPY '):
                match = pattern.match(line)
                if not match:
                    raise RuntimeError('unsupported archive COPY statement')
                name = match.group(1).decode()
                if name in counts:
                    raise RuntimeError('duplicate archive table')
                counts[name] = 0
            elif name is not None and line == b'\\.':
                name = None
            elif name is not None:
                counts[name] += 1
        if name is not None or len(counts) != 121:
            raise RuntimeError('incomplete archive data')
        sql = '\n'.join("SELECT " + str(i) + " || '|' || count(*) FROM " + table + ';'
                        for i, table in enumerate(counts))
        actual = {int(row.split('|')[0]): int(row.split('|')[1]) for row in psql(sql, db).splitlines()}
        if len(actual) != len(counts) or any(actual.get(i) != value for i, value in enumerate(counts.values())):
            raise RuntimeError('restored row counts differ from backup')
        expected_extensions = {'plpgsql=1.0', 'pg_cron=1.6', 'pg_net=0.14.0', 'pg_stat_statements=1.11',
                               'pgcrypto=1.3', 'supabase_vault=0.3.1', 'uuid-ossp=1.1'}
        if set(psql("SELECT extname || '=' || extversion FROM pg_extension;", db).splitlines()) != expected_extensions:
            raise RuntimeError('extension versions differ from backup')
        if psql("SELECT count(*) FROM pg_event_trigger;", db).strip() != '7':
            raise RuntimeError('event trigger count differs from backup')
        if psql("SELECT count(*) FROM pg_trigger WHERE tgrelid='public.user_profiles'::regclass AND NOT tgisinternal;", db).strip() != '6':
            raise RuntimeError('user profile trigger count differs from backup')
        helper = root / 'offline-recovery-tools-20261112'
        storage = root / 'storage-independent-3e04b9e0'
        tar = work / 'storage.tar'
        run(['node', str(helper / 'aead-file.mjs'), 'decrypt', str(key),
             str(storage / 'storage.tar.aesgcm'), str(tar)], timeout=120)
        run(['python3', str(helper / 'storage_verify.py'), str(tar), str(work / 'storage-result.json'),
             str(storage / 'inventory.json'), str(work / 'files')], timeout=120)
        storage_result = json.loads((work / 'storage-result.json').read_text())
        if not storage_result['passed'] or not storage_result['extracted_and_rehashed'] or storage_result['objects'] != 78:
            raise RuntimeError('storage restore verification failed')
        identities = json.loads(psql("SELECT coalesce(json_agg(json_build_array(bucket_id,name,(metadata->>'size')::bigint) ORDER BY bucket_id,name),'[]'::json)::text FROM storage.objects;", db))
        digest = hashlib.sha256(json.dumps(sorted(identities), separators=(',', ':')).encode()).hexdigest()
        if digest != storage_result['object_identity_sha256']:
            raise RuntimeError('storage and database identities differ')
        spec = importlib.util.spec_from_file_location('phone_initializer', Path(__file__).with_name('initialize-db.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        empty = psql('SELECT ' + ' AND '.join('(SELECT count(*) = 0 FROM public.' + t + ')' for t in module.TABLES) + ';', db).strip()
        if empty != 't':
            raise RuntimeError('phone identity tables are not empty; synthetic initialization refused')
        update = module.UPDATE.replace('%s', "'v1'", 1).replace('%s', "'" + 'a' * 64 + "'", 1)
        locks = 'SELECT pg_advisory_xact_lock(20261024, 2); LOCK TABLE ' + ', '.join('public.' + t for t in module.TABLES) + ' IN SHARE ROW EXCLUSIVE MODE;'
        first = psql('BEGIN; ' + locks + ' ' + update + '; COMMIT;', db).splitlines()
        second = psql('BEGIN; ' + locks + ' ' + update + '; ROLLBACK;', db).splitlines()
        if [x for x in first if x] != ['t'] or [x for x in second if x]:
            raise RuntimeError('synthetic initialization or repeat protection failed')
        if failures:
            print('INCOMPLETE:', '; '.join(failures), '; independently checked:', len(counts),
                  'tables, 78 storage objects and synthetic initialization.')
            return 1
        passed = True
        return 0
    finally:
        for name in (container, template):
            found = run(['docker', 'inspect', '--format', '{{ index .Config.Labels "dev.sunland.rehearsal" }}', name], check=False)
            if found.returncode:
                if run(['docker', 'info'], check=False).returncode:
                    raise RuntimeError('container state unknown; encrypted work directory retained')
                continue
            if found.stdout.decode().strip() != ownership:
                continue  # Never remove a container created by someone else.
            removed = run(['docker', 'rm', '-f', name], check=False)
            if removed.returncode:
                raise RuntimeError('container cleanup failed; encrypted work directory retained')
        shutil.rmtree(work)
        if passed:
            report = {'result': 'pass', 'tables': len(counts), 'storage_objects': 78,
                      'roles': 19, 'extensions': 7, 'event_triggers': 7,
                      'user_profile_triggers': 6, 'synthetic_initialization': True,
                      'database_and_storage_same_snapshot': False, 'vault_root_key_verified': False,
                      'isolated_storage_service_upload_verified': False, 'cleanup': True}
            (root / ('rehearsal-result-' + secrets.token_hex(8) + '.json')).write_text(json.dumps(report, indent=2) + '\n')
            print('PASS: roles, ACL, RLS, triggers, extensions,', len(counts),
                  'tables, 78 storage objects and synthetic initialization verified; isolated resources removed.')


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as exc:
        print('Stopped:', type(exc).__name__, str(exc), file=sys.stderr)
        sys.exit(1)
