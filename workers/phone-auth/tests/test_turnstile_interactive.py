import importlib.util
import io
import os
from pathlib import Path
import re
import subprocess
import threading
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import urllib.error
import urllib.request

spec = importlib.util.spec_from_file_location('interactive', Path(__file__).resolve().parents[1] / 'operations' / 'turnstile-interactive.py')
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)


class Tests(unittest.TestCase):
    def test_browser_bridge_rejects_other_origins_and_keeps_token_out_of_output(self):
        output, received = io.StringIO(), []
        with patch('sys.stdout', output):
            thread = threading.Thread(target=lambda: received.append(client.receive_browser_token()), daemon=True)
            thread.start()
            deadline = time.monotonic() + 5
            match = None
            while time.monotonic() < deadline and not match:
                match = re.search(r'http://127\.0\.0\.1:\d+/[A-Za-z0-9_-]+', output.getvalue())
                time.sleep(0.01)
            self.assertIsNotNone(match)
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            wrong = urllib.request.Request(match.group(), data=b'synthetic-token', method='POST',
                                           headers={'Origin': 'https://attacker.invalid'})
            with self.assertRaises(urllib.error.HTTPError) as error:
                opener.open(wrong, timeout=2)
            self.assertEqual(error.exception.code, 403)
            error.exception.close()
            preflight = urllib.request.Request(match.group(), method='OPTIONS', headers={'Origin': client.ORIGIN})
            with opener.open(preflight, timeout=2) as response:
                self.assertEqual(response.headers.get('Access-Control-Allow-Private-Network'), 'true')
            valid = urllib.request.Request(match.group(), data=b'synthetic-token', method='POST',
                                           headers={'Origin': client.ORIGIN})
            with opener.open(valid, timeout=2) as response:
                self.assertEqual(response.status, 204)
            thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(received, [b'synthetic-token'])
        self.assertNotIn('synthetic-token', output.getvalue())

    def test_sensitive_inputs_use_pipes_not_arguments(self):
        def fake_run(command, *, pass_fds, capture_output, timeout):
            self.assertNotIn('synthetic-token', command)
            self.assertNotIn('a' * 32, command)
            self.assertEqual(os.read(pass_fds[0], 512), b'a' * 32)
            self.assertEqual(os.read(pass_fds[1], 2048), b'synthetic-token')
            return SimpleNamespace(returncode=0, stdout=b'verified\n')
        with patch.object(client.subprocess, 'run', side_effect=fake_run):
            self.assertTrue(client.invoke(b'a' * 32, b'synthetic-token'))

    def test_sequence_sends_once_each_and_only_after_success(self):
        with patch.object(client.getpass, 'getpass', side_effect=['a' * 32, 'synthetic-token']), \
             patch.object(client, 'invoke', side_effect=[True, True, True]) as invoke, patch('sys.stdout', new_callable=io.StringIO):
            self.assertEqual(client.main([]), 0)
        self.assertEqual(invoke.call_args_list[0].args, (b'a' * 32, b'synthetic-token'))
        self.assertEqual(invoke.call_args_list[1].kwargs, {'replay': True})
        self.assertEqual(invoke.call_args_list[2].args[1], client.INVALID_TOKEN)
        self.assertEqual(invoke.call_count, 3)

    def test_failure_or_unknown_stops_without_retry_or_secret_output(self):
        for outcome in ([False], [True, False], [True, subprocess.TimeoutExpired('synthetic-secret', 1)]):
            output = io.StringIO()
            with patch.object(client.getpass, 'getpass', side_effect=['a' * 32, 'synthetic-token']), \
                 patch.object(client, 'invoke', side_effect=outcome) as invoke, patch('sys.stdout', output):
                self.assertEqual(client.main([]), 1)
            self.assertEqual(invoke.call_count, len(outcome))
            self.assertNotIn('synthetic', output.getvalue())
            self.assertNotIn('a' * 32, output.getvalue())

    def test_invalid_input_makes_no_request(self):
        with patch.object(client.getpass, 'getpass', side_effect=['short', 'synthetic-token']), \
             patch.object(client, 'invoke') as invoke, patch('sys.stdout', new_callable=io.StringIO):
            self.assertEqual(client.main([]), 1)
        invoke.assert_not_called()

    def test_admin_only_uses_one_invalid_token_and_no_real_token(self):
        with patch.object(client.getpass, 'getpass', return_value='a' * 32) as prompt, \
             patch.object(client, 'invoke', return_value=True) as invoke, patch('sys.stdout', new_callable=io.StringIO):
            self.assertEqual(client.main(['--admin-only']), 0)
        prompt.assert_called_once()
        invoke.assert_called_once_with(b'a' * 32, client.INVALID_TOKEN, replay=True)

    def test_browser_mode_does_not_prompt_for_token(self):
        with patch.object(client.getpass, 'getpass', return_value='a' * 32) as prompt, \
             patch.object(client, 'receive_browser_token', return_value=b'synthetic-token'), \
             patch.object(client, 'invoke', side_effect=[True, True, True]), patch('sys.stdout', new_callable=io.StringIO):
            self.assertEqual(client.main(['--browser']), 0)
        prompt.assert_called_once()


if __name__ == '__main__':
    unittest.main()
