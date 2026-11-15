import importlib.util
from pathlib import Path
import plistlib
import tempfile
import unittest
from unittest import mock

SCRIPT = Path(__file__).parents[1] / 'operations/offline-rehearsal.py'
spec = importlib.util.spec_from_file_location('offline_rehearsal', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RehearsalSafetyTests(unittest.TestCase):
    def test_missing_backup_key_rejected_before_docker(self):
        with tempfile.TemporaryDirectory() as root, mock.patch.object(module, 'run') as run:
            with mock.patch('sys.argv', ['offline-rehearsal', '--root', root, '--storage-key', root + '/missing']):
                with self.assertRaises(FileNotFoundError):
                    module.main()
            run.assert_not_called()

    def test_unencrypted_volume_rejected_before_container_creation(self):
        with tempfile.TemporaryDirectory() as root:
            key = Path(root) / 'key'
            key.write_bytes(b'x' * 32)
            key.chmod(0o600)
            result = mock.Mock(stdout=plistlib.dumps({'images': [{'image-encrypted': False,
                'system-entities': [{'mount-point': root}]}]}))
            with mock.patch.object(module, 'run', return_value=result) as run:
                with mock.patch('sys.argv', ['offline-rehearsal', '--root', root, '--storage-key', str(key)]):
                    with self.assertRaisesRegex(ValueError, 'encrypted mount'):
                        module.main()
                self.assertEqual(run.call_count, 1)
                self.assertEqual(run.call_args.args[0][:2], ['hdiutil', 'info'])


if __name__ == '__main__':
    unittest.main()
