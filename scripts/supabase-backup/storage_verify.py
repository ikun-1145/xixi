#!/usr/bin/env python3
"""Verify every tar member and optionally materialize files in a new private directory."""
import hashlib,json,pathlib,posixpath,re,sys,tarfile
archive_path,result_path=sys.argv[1:3]
with open(result_path,'x') as out:json.dump({'passed':False,'stage':'verification_in_progress'},out)
inventory_path=sys.argv[3] if len(sys.argv)>3 else None
extract_root=pathlib.Path(sys.argv[4]) if len(sys.argv)>4 else None
if extract_root:extract_root.mkdir(mode=0o700,exist_ok=False)
with tarfile.open(archive_path,'r:') as archive:
    members={}
    for member in archive.getmembers():
        name=member.name
        if not member.isfile() or name in members or posixpath.normpath(name)!=name or name.startswith('/') or '..' in pathlib.PurePosixPath(name).parts:
            raise RuntimeError('Unsafe or duplicate Storage tar member')
        members[name]=member
    manifest_member=members.pop('SUNLAND-STORAGE-MANIFEST.json',None)
    if manifest_member is None:raise RuntimeError('Storage manifest is missing')
    manifest=json.load(archive.extractfile(manifest_member));expected={}
    if manifest['failures']:raise RuntimeError('Storage manifest contains failed objects')
    for item in manifest['objects']:
        name=f"objects/{item['bucket']}/{item['path']}"
        if name in expected or '/' in item['bucket'] or not item['bucket'] or not item['path']:
            raise RuntimeError('Invalid or duplicate Storage manifest object')
        expected[name]=item
    if set(members)!=set(expected):raise RuntimeError('Storage tar members differ from manifest')
    total=0;by_bucket={};source_etags_checked=0;identities=[]
    for name,item in expected.items():
        source=archive.extractfile(members[name]);digest=hashlib.sha256();md5=hashlib.md5();size=0
        target=None
        if extract_root:
            path=extract_root/name;path.parent.mkdir(mode=0o700,parents=True,exist_ok=True);target=path.open('xb');path.chmod(0o600)
        try:
            while True:
                chunk=source.read(1024*1024)
                if not chunk:break
                digest.update(chunk);md5.update(chunk);size+=len(chunk)
                if target:target.write(chunk)
        finally:
            if target:target.close()
        if size!=item['bytes'] or digest.hexdigest()!=item['sha256']:raise RuntimeError('Storage object integrity mismatch')
        metadata_size=(item.get('metadata') or {}).get('size')
        if metadata_size is None or int(metadata_size)!=size:raise RuntimeError('Storage source metadata size mismatch')
        if extract_root and hashlib.sha256((extract_root/name).read_bytes()).hexdigest()!=item['sha256']:
            raise RuntimeError('Extracted Storage object integrity mismatch')
        etag=str((item.get('metadata') or {}).get('eTag','')).strip('"')
        if re.fullmatch(r'[0-9a-fA-F]{32}',etag):
            if md5.hexdigest()!=etag.lower():raise RuntimeError('Storage source ETag checksum mismatch')
            source_etags_checked+=1
        identities.append([item['bucket'],item['path'],size])
        total+=size;entry=by_bucket.setdefault(item['bucket'],{'objects':0,'bytes':0});entry['objects']+=1;entry['bytes']+=size
    if inventory_path:
        inventory=json.load(open(inventory_path))
        if inventory['failures'] or inventory['objects']!=len(expected) or inventory['bytes']!=total:
            raise RuntimeError('Storage aggregate inventory mismatch')
        buckets={b['bucket']:b for b in inventory['buckets']}
        if not set(by_bucket)<=set(buckets):raise RuntimeError('Storage bucket inventory mismatch')
        for bucket,info in buckets.items():
            if by_bucket.get(bucket,{'objects':0,'bytes':0})!={k:info[k] for k in ('objects','bytes')}:
                raise RuntimeError('Storage per-bucket inventory mismatch')
    result={'passed':True,'objects':len(expected),'bytes':total,'failures':0,'extracted_and_rehashed':bool(extract_root),'buckets':by_bucket,'source_etag_checks':source_etags_checked,'object_identity_sha256':hashlib.sha256(json.dumps(sorted(identities),separators=(',',':')).encode()).hexdigest()}
    with open(result_path,'w') as out:json.dump(result,out,indent=2);out.write('\n')
    print(f"Storage restore verification passed: {len(expected)} objects, {total} bytes")
