import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('client', Path(__file__).resolve().parents[1] / 'operations' / 'turnstile-probe.py')
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)

class Response:
    def __init__(self, status, body, headers=None):
        self.status, self.body, self.headers = status, body, {'Cache-Control':'no-store'} if headers is None else headers
    def read(self, limit): return self.body[:limit]
    def __enter__(self): return self
    def __exit__(self, *args): pass

class Opener:
    def __init__(self, status, body, headers=None): self.status, self.body, self.headers, self.calls = status, body, headers, 0
    def open(self, req, timeout):
        self.calls += 1
        assert req.full_url == client.URL and timeout == 10 and req.method == 'POST'
        assert req.get_header('User-agent') == 'sunland-phone-auth-probe/1.0'
        assert json.loads(req.data) == {'token':'synthetic-token'}
        return Response(self.status, self.body, self.headers)

class Tests(unittest.TestCase):
    def run_client(self, status=200, body=b'{"ok":true}', extra=(), side_effect=None, headers=None):
        inputs={3:[b'synthetic-admin-token-with-at-least-32-chars', b''],4:[b'synthetic-token', b'']}
        def read(fd, size): return inputs[fd].pop(0)
        opener=Opener(status,body,headers);out=io.StringIO()
        if side_effect:
            def bad(*args, **kwargs): opener.calls+=1;raise side_effect
            opener.open=bad
        argv=['turnstile-probe.py','--admin-fd','3','--token-fd','4',*extra]
        with patch('sys.argv',argv),patch('sys.stdout',out),patch.object(client.os,'read',side_effect=read),patch.object(client.urllib.request,'build_opener',return_value=opener):
            result=client.main()
        return result,out.getvalue(),opener.calls
    def test_success_and_separate_expected_replay(self):
        self.assertEqual(self.run_client(),(0,'verified\n',1))
        self.assertEqual(self.run_client(403,b'{"ok":false}',('--expect-replay',)),(0,'rejected\n',1))
    def test_never_retry_or_leak_on_unknown_or_bad_reply(self):
        for status,body in [(302,b'{"ok":true}'),(500,b'synthetic-secret'),(200,b'synthetic-secret'),(200,b'x'*1025)]:
            self.assertEqual(self.run_client(status,body),(1,'failed\n',1))
        self.assertEqual(self.run_client(side_effect=OSError('synthetic-secret')),(1,'failed\n',1))
    def test_replay_requires_failure_response(self):
        self.assertEqual(self.run_client(200,b'{"ok":true}',('--expect-replay',)),(1,'failed\n',1))
    def test_rejects_response_without_worker_no_store_marker(self):
        self.assertEqual(self.run_client(403,b'{"ok":false}',('--expect-replay',),headers={}), (1,'failed\n',1))
    def test_safe_failure_categories_do_not_expose_response(self):
        options = ('--expect-replay', '--safe-details')
        self.assertEqual(self.run_client(200,b'{"ok":true}',options), (1,'failed:unexpected_acceptance\n',1))
        self.assertEqual(self.run_client(503,b'{"ok":false}',options), (1,'failed:service_error\n',1))
        self.assertEqual(self.run_client(200,b'synthetic-secret',options), (1,'failed:invalid_response\n',1))
    def test_no_redirect(self):
        self.assertIsNone(client.NoRedirect().redirect_request(None,None,302,'',{},'https://bad.invalid'))

if __name__=='__main__': unittest.main()
