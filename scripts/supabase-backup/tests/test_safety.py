"""Synthetic-only regression checks; never contacts production."""
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

HERE = Path(__file__).resolve().parents[1]

class SafetyTests(unittest.TestCase):
    def test_existing_encryption_target_is_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            key = root/'key'; key.write_bytes(b'k'*32)
            target = root/'archive'; target.write_bytes(b'original')
            sidecar = root/'archive.source.json'; sidecar.write_text('original metadata')
            result = subprocess.run(['node', str(HERE/'aead-file.mjs'), 'encrypt', str(key), str(target)], input=b'new', capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(target.read_bytes(), b'original')
            self.assertEqual(sidecar.read_text(), 'original metadata')

    def test_existing_decryption_target_is_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); key=root/'key'; key.write_bytes(b'k'*32)
            archive=root/'archive'; target=root/'restored'; target.write_bytes(b'original')
            subprocess.run(['node',str(HERE/'aead-file.mjs'),'encrypt',str(key),str(archive)],input=b'payload',check=True,capture_output=True)
            result=subprocess.run(['node',str(HERE/'aead-file.mjs'),'decrypt',str(key),str(archive),str(target)],capture_output=True)
            self.assertNotEqual(result.returncode,0)
            self.assertEqual(target.read_bytes(),b'original')

    def test_duplicate_storage_member_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); archive=root/'storage.tar'
            item={'bucket':'avatars','path':'a','bytes':1,'sha256':hashlib.sha256(b'a').hexdigest()}
            with tarfile.open(archive,'w') as tar:
                for name,data in [('objects/avatars/a',b'a'),('objects/avatars/a',b'a'),('SUNLAND-STORAGE-MANIFEST.json',json.dumps({'objects':[item],'failures':[]}).encode())]:
                    info=tarfile.TarInfo(name);info.size=len(data);tar.addfile(info,io.BytesIO(data))
            result=subprocess.run(['python3',str(HERE/'storage_verify.py'),str(archive),str(root/'result.json')],capture_output=True)
            self.assertNotEqual(result.returncode,0)

    def test_existing_sidecar_is_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);key=root/'key';key.write_bytes(b'k'*32)
            archive=root/'archive';sidecar=root/'archive.source.json';sidecar.write_text('original')
            result=subprocess.run(['node',str(HERE/'aead-file.mjs'),'encrypt',str(key),str(archive)],input=b'payload',capture_output=True)
            self.assertNotEqual(result.returncode,0)
            self.assertEqual(sidecar.read_text(),'original')
            self.assertFalse(archive.exists())

    def test_tampered_ciphertext_is_rejected_without_plaintext(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);key=root/'key';key.write_bytes(b'k'*32);archive=root/'archive'
            subprocess.run(['node',str(HERE/'aead-file.mjs'),'encrypt',str(key),str(archive)],input=b'payload',check=True,capture_output=True)
            data=bytearray(archive.read_bytes());data[-1]^=1;archive.write_bytes(data)
            result=subprocess.run(['node',str(HERE/'aead-file.mjs'),'decrypt',str(key),str(archive),str(root/'plain')],capture_output=True)
            self.assertNotEqual(result.returncode,0)
            self.assertFalse((root/'plain').exists())

    def test_storage_extract_and_inventory_mismatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);archive=root/'storage.tar';data=b'synthetic'
            item={'bucket':'avatars','path':'nested/a','bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'metadata':{'size':len(data),'eTag':hashlib.md5(data).hexdigest()}}
            with tarfile.open(archive,'w') as tar:
                for name,payload in [('objects/avatars/nested/a',data),('SUNLAND-STORAGE-MANIFEST.json',json.dumps({'objects':[item],'failures':[]}).encode())]:
                    info=tarfile.TarInfo(name);info.size=len(payload);tar.addfile(info,io.BytesIO(payload))
            inventory={'objects':1,'bytes':len(data),'failures':0,'buckets':[{'bucket':'avatars','objects':1,'bytes':len(data)}]}
            (root/'inventory.json').write_text(json.dumps(inventory))
            args=['python3',str(HERE/'storage_verify.py'),str(archive),str(root/'result.json'),str(root/'inventory.json')]
            subprocess.run([*args,str(root/'extracted')],check=True,capture_output=True)
            self.assertEqual((root/'extracted/objects/avatars/nested/a').read_bytes(),data)
            self.assertEqual(json.loads((root/'result.json').read_text())['source_etag_checks'],1)
            inventory['objects']=2;(root/'inventory.json').write_text(json.dumps(inventory));(root/'result.json').unlink()
            result=subprocess.run(args,capture_output=True)
            self.assertNotEqual(result.returncode,0)
            self.assertFalse(json.loads((root/'result.json').read_text())['passed'])

if __name__=='__main__':unittest.main()
