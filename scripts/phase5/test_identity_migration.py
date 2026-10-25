"""Local-only safety checks for the frozen migration SQL generator."""
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SOURCE=Path(__file__).with_name('identity_migration.py')

class MigrationGuardTests(unittest.TestCase):
    def test_frozen_sha_remains_enforced_with_python_optimization(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'synthetic.sql';path.write_text('begin;\nselect 1;\ncommit;\n')
            code="""import importlib.util,pathlib,sys
spec=importlib.util.spec_from_file_location('migration',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.MIGRATIONS=[('00000000000000','synthetic',pathlib.Path(sys.argv[2]),'0'*64)]
try:m.transaction(0)
except ValueError as error:
 if str(error)=='Frozen migration changed':sys.exit(0)
sys.exit(1)
"""
            result=subprocess.run([sys.executable,'-O','-c',code,str(SOURCE),str(path)],capture_output=True)
            self.assertEqual(result.returncode,0,'optimized Python must not bypass the frozen source hash')

    def test_transaction_boundary_requires_exact_outer_pair(self):
        spec=importlib.util.spec_from_file_location('migration',SOURCE);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
        self.assertEqual(m.body('begin;\nselect 1;\ncommit;\n'),'select 1;\n')
        for sql in ['select 1;','begin;\nselect 1;','begin;\nbegin;\nselect 1;\ncommit;']:
            with self.assertRaises(ValueError):m.body(sql)

if __name__=='__main__':unittest.main()
