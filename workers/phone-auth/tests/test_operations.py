import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'operations' / (name + '.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

db = load('initialize-db')
do = load('initialize-do')

class Connection:
    def __init__(self, rows, fail_commit=False):
        self.rows, self.fail_commit = rows, fail_commit
        self.executed = []
        self.commits = self.rollbacks = 0
    def execute(self, query, params=None):
        self.executed.append((query, params))
        return self
    def fetchall(self): return self.rows
    def rollback(self): self.rollbacks += 1
    def commit(self):
        self.commits += 1
        if self.fail_commit: raise RuntimeError('synthetic disconnect')

class OperationsTests(unittest.TestCase):
    def test_database_commits_exactly_one_and_rolls_back_zero_or_multiple(self):
        for rows, expected in [([(True,)], 'committed'), ([], 'rejected'), ([(True,), (True,)], 'rejected')]:
            conn = Connection(rows)
            self.assertEqual(db.initialize(conn, 'a' * 64), expected)
            self.assertEqual(conn.commits, int(expected == 'committed'))
            self.assertEqual(conn.rollbacks, int(expected == 'rejected'))
            self.assertIn('pg_advisory_xact_lock(20261024, 2)', conn.executed[2][0])
            self.assertEqual(conn.executed[-1][1], ('v1', 'a' * 64))
    def test_logging_guard_uses_transaction_local_limits_and_rejects_unsafe_extensions(self):
        class Settings(Connection):
            def fetchone(self): return self.rows
        safe = Settings(('0', '0', 'read committed', None, 'off'))
        db.secure_logging(safe)
        self.assertEqual([q for q, _ in safe.executed[:2]], [
            'SET LOCAL log_parameter_max_length = 0', 'SET LOCAL log_parameter_max_length_on_error = 0'])
        class AutoExplain(Settings):
            def execute(self, query, params=None):
                super().execute(query, params)
                if query == 'SET LOCAL auto_explain.log_parameter_max_length = 0':
                    self.rows = ('0', '0', 'read committed', '0', None)
                return self
        extension = AutoExplain(('0', '0', 'read committed', '-1', None))
        db.secure_logging(extension)
        self.assertIn('SET LOCAL auto_explain.log_parameter_max_length = 0', [q for q, _ in extension.executed])
        for row in [('0','0','repeatable read',None,None), ('0','0','read committed','-1',None), ('0','0','read committed',None,'on')]:
            with self.assertRaises(RuntimeError): db.secure_logging(Settings(row))
    def test_pooler_target_is_explicit_tls_and_private_passfile_only(self):
        import os, tempfile
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as directory:
            passfile = Path(directory) / 'passfile'
            passfile.write_text('synthetic')
            passfile.chmod(0o600)
            with patch.dict(os.environ, {'PGPASSFILE': str(passfile)}, clear=True):
                params = db.pooler_parameters()
                self.assertEqual(params, {'host': db.POOLER_HOST, 'port': 5432, 'user': db.POOLER_USER,
                                          'dbname': 'postgres', 'sslmode': 'verify-full', 'connect_timeout': 10})
                for variable in ('PGPASSWORD', 'PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS'):
                    with patch.dict(os.environ, {variable: 'synthetic'}):
                        with self.assertRaises(ValueError): db.pooler_parameters()
                passfile.chmod(0o644)
                with self.assertRaises(ValueError): db.pooler_parameters()
        class Identity:
            info = SimpleNamespace(host=db.POOLER_HOST, port=5432, user=db.POOLER_USER, dbname='postgres')
            pgconn = SimpleNamespace(ssl_in_use=True)
            def execute(self, query): return self
            def fetchone(self): return (True, True, True)
        valid = Identity()
        db.verify_pooler_identity(valid)
        for field, value in [('host', 'wrong.example'), ('port', 6543), ('user', 'wrong'), ('dbname', 'wrong')]:
            candidate = Identity()
            candidate.info = SimpleNamespace(**vars(valid.info))
            setattr(candidate.info, field, value)
            with self.assertRaises(ValueError): db.verify_pooler_identity(candidate)
        candidate = Identity()
        candidate.pgconn = SimpleNamespace(ssl_in_use=False)
        with self.assertRaises(ValueError): db.verify_pooler_identity(candidate)
        class BadIdentity(Identity):
            def fetchone(self): return (True, False, True)
        with self.assertRaises(ValueError): db.verify_pooler_identity(BadIdentity())
    def test_invalid_mode_never_connects_or_reads_lookup_key(self):
        with patch.object(db.sys, 'argv', ['initialize-db.py', '--session-pooler']):
            self.assertEqual(db.main(), 2)
    def test_uncertain_commit_is_not_retried(self):
        conn = Connection([(True,)], fail_commit=True)
        with self.assertRaises(RuntimeError): db.initialize(conn, 'a' * 64)
        self.assertEqual(conn.commits, 1)
    def test_database_existing_configuration_is_read_only_idempotent(self):
        class Existing(Connection):
            def __init__(self, match):
                super().__init__([])
                self.match = match
            def execute(self, query, params=None):
                super().execute(query, params)
                self.rows = self.match if query.startswith('SELECT lookup_key_id = ') else []
                return self
        for match, expected in [([(True,)], 'already_initialized'), ([(False,)], 'rejected'),
                                ([(None,)], 'rejected'), ([], 'rejected')]:
            conn = Existing(match)
            self.assertEqual(db.initialize(conn, 'a' * 64), expected)
            self.assertEqual(conn.rollbacks, 1)
            self.assertEqual(conn.commits, 0)
            self.assertIn('FOR UPDATE', conn.executed[-1][0])
            self.assertEqual(conn.executed[-1][1], ('v1', 'a' * 64))
    def test_documented_sql_matches_parameterized_sql(self):
        import re
        text = (ROOT / 'PREFLIGHT.md').read_text()
        sql = re.search(r'```sql\n(.*?)\n```', text, re.S).group(1).strip().rstrip(';')
        norm = lambda s: ' '.join(s.replace('$1', '%s').replace('$2', '%s').split()).lower()
        self.assertEqual(norm(sql), norm(db.UPDATE))
    def test_do_requires_explicit_execute_and_never_follows_redirect(self):
        with patch.object(do.sys, 'argv', ['initialize-do.py']), patch.object(do.urllib.request, 'build_opener', side_effect=AssertionError('network forbidden')):
            self.assertEqual(do.main(), 2)
        self.assertIsNone(do.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://example.invalid'))
    def test_do_accepts_compatible_canary_ledger_without_requiring_zero_counters(self):
        class Input:
            buffer = io.BytesIO(b'synthetic-token-not-a-real-secret-0000')
        class Response:
            status = 200
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, limit):
                return json.dumps({'success':True,'state':'ready','schema':1,'enabled':True,'mode':'canary',
                    'test_reserved':1,'total_micros':5,'day_count':1,'day_micros':5}).encode()
        class Opener:
            def open(self, request, timeout):
                self.url = request.full_url
                self.timeout = timeout
                return Response()
        opener = Opener()
        with patch.object(do.sys, 'argv', ['initialize-do.py', '--execute', 'initialize']), patch.object(do.sys, 'stdin', Input()), patch.object(do.urllib.request, 'build_opener', return_value=opener):
            self.assertEqual(do.main(), 0)
        self.assertEqual(opener.url, 'https://api.sunland.dev/v1/phone/_admin/initialize')
        self.assertEqual(opener.timeout, 10)
    def test_do_sanitizes_failure_without_retry(self):
        class Input:
            buffer = io.BytesIO(b'synthetic-token-not-a-real-secret-0000')
        class Opener:
            count = 0
            def open(self, *args, **kwargs):
                self.count += 1
                raise OSError('sensitive mock transport text')
        opener = Opener()
        out = io.StringIO()
        with patch.object(do.sys, 'argv', ['initialize-do.py', '--execute', 'initialize']), patch.object(do.sys, 'stdin', Input()), patch.object(do.sys, 'stdout', out), patch.object(do.urllib.request, 'build_opener', return_value=opener):
            self.assertEqual(do.main(), 1)
        self.assertEqual(opener.count, 1)
        self.assertNotIn('sensitive', out.getvalue())
        self.assertIn('Do not retry', out.getvalue())

    def test_do_status_reports_uninitialized_without_claiming_success(self):
        class Input:
            buffer = io.BytesIO(b'synthetic-token-not-a-real-secret-0000')
        class Response:
            status = 200
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, limit): return b'{"success":true,"state":"uninitialized"}'
        class Opener:
            def open(self, request, timeout): return Response()
        out = io.StringIO()
        with patch.object(do.sys, 'argv', ['initialize-do.py', '--execute', 'status']), patch.object(do.sys, 'stdin', Input()), patch.object(do.sys, 'stdout', out), patch.object(do.urllib.request, 'build_opener', return_value=Opener()):
            self.assertEqual(do.main(), 1)
        self.assertIn('uninitialized', out.getvalue())

if __name__ == '__main__': unittest.main()
