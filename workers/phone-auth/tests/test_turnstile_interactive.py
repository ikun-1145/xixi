import importlib.util
import io
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('interactive', Path(__file__).resolve().parents[1] / 'operations' / 'turnstile-interactive.py')
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)


class Tests(unittest.TestCase):
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


if __name__ == '__main__':
    unittest.main()
