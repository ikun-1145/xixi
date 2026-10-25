"""Synthetic snapshot SQL and acceptance-level regression checks."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

HERE=Path(__file__).resolve().parents[1]

class SnapshotTests(unittest.TestCase):
    def test_import_snapshot_before_any_select(self):
        spec=importlib.util.spec_from_file_location('snapshot_export',HERE/'snapshot_export.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        sql=module.import_snapshot('SET SESSION ROLE postgres;\nBEGIN TRANSACTION READ ONLY;\nSELECT 1;\nCOMMIT;','00000003-000000AB-1')
        self.assertIn('REPEATABLE READ READ ONLY',sql)
        self.assertLess(sql.index('SET TRANSACTION SNAPSHOT'),sql.index('SELECT 1'))
        with self.assertRaises(ValueError):module.import_snapshot('SELECT 1;',"bad' snapshot")

    def test_known_extension_difference_does_not_hide_core_mismatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);base={c:[] for c in ('tables','indexes','constraints','functions','triggers','policies','extensions')}
            source={**base,'tables':[{'schema':'public','name':'user_profiles'}],'extensions':[{'schema':'extensions','name':'pg_net','version':'0.14.0'}]}
            restored={**source,'extensions':[{'schema':'extensions','name':'pg_net','version':'0.20.3'}]}
            for name,value in [('sc',{'public.user_profiles':2}),('rc',{'public.user_profiles':2}),('so',source),('ro',restored)]: (root/name).write_text(json.dumps(value))
            args=['python3',str(HERE/'compare_inventory.py'),*[str(root/n) for n in ['sc','so','rc','ro','result']]]
            subprocess.run(args,capture_output=True)
            result=json.loads((root/'result').read_text());self.assertTrue(result['core_business_passed']);self.assertFalse(result['passed'])
            (root/'rc').write_text(json.dumps({'public.user_profiles':1}));subprocess.run(args,capture_output=True)
            self.assertFalse(json.loads((root/'result').read_text())['core_business_passed'])

    def test_acl_order_and_uuid_default_qualification_are_semantic(self):
        spec=importlib.util.spec_from_file_location('compare_inventory',HERE/'compare_inventory.py')
        # Run the CLI with complete synthetic records rather than importing its command entry point.
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);base={c:[] for c in ('tables','indexes','constraints','functions','triggers','policies','extensions')}
            source={**base,'tables':[{'schema':'public','name':'email_codes','acl':'{postgres=r/postgres,service_role=r/postgres}','columns':[{'name':'id','default_md5':hashlib.md5(b'uuid_generate_v4()').hexdigest()}]}]}
            restored={**base,'tables':[{'schema':'public','name':'email_codes','acl':'{service_role=r/postgres,postgres=r/postgres}','columns':[{'name':'id','default_md5':hashlib.md5(b'extensions.uuid_generate_v4()').hexdigest()}]}]}
            for name,value in [('sc',{'public.email_codes':0}),('rc',{'public.email_codes':0}),('so',source),('ro',restored)]: (root/name).write_text(json.dumps(value))
            args=['python3',str(HERE/'compare_inventory.py'),*[str(root/n) for n in ['sc','so','rc','ro','result']]]
            subprocess.run(args,capture_output=True);self.assertTrue(json.loads((root/'result').read_text())['core_business_passed'])
            restored['tables'][0]['acl']='{service_role=rw/postgres,postgres=r/postgres}';(root/'ro').write_text(json.dumps(restored))
            subprocess.run(args,capture_output=True);self.assertFalse(json.loads((root/'result').read_text())['core_business_passed'])

if __name__=='__main__':unittest.main()
