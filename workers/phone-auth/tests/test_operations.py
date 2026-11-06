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
    def test_uncertain_commit_is_not_retried(self):
        conn = Connection([(True,)], fail_commit=True)
        with self.assertRaises(RuntimeError): db.initialize(conn, 'a' * 64)
        self.assertEqual(conn.commits, 1)
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
    def test_do_accepts_only_canary_zero_ledger(self):
        class Input:
            buffer = io.BytesIO(b'synthetic-token-not-a-real-secret-0000')
        class Response:
            status = 200
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, limit):
                return json.dumps({'success':True,'schema':1,'enabled':True,'mode':'canary',
                    'test_reserved':0,'total_micros':0,'day_count':0,'day_micros':0}).encode()
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

if __name__ == '__main__': unittest.main()
