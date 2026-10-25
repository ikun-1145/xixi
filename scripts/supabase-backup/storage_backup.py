#!/usr/bin/env python3
import argparse, datetime, hashlib, io, json, os, pathlib, posixpath, subprocess, sys, tarfile, tempfile, time, urllib.error, urllib.parse, urllib.request

CHUNK=1024*1024

def secret_from_env_file(path, name):
    with open(path, encoding='utf-8') as handle:
        for line in handle:
            if line.startswith(name+'='):
                value=line.split('=',1)[1].strip()
                if len(value)>1 and value[0]==value[-1] and value[0] in "\"'": value=value[1:-1]
                if value: return value
    raise RuntimeError(f'{name} is missing from {path}')

class Storage:
    def __init__(self, project, key):
        self.base=f'https://{project}.supabase.co/storage/v1'
        self.headers={'apikey':key,'Authorization':'Bearer '+key}
    def request(self, method, path, body=None, attempts=4):
        data=None if body is None else json.dumps(body).encode()
        for attempt in range(attempts):
            request=urllib.request.Request(self.base+path,data=data,method=method,headers={**self.headers,'Content-Type':'application/json'})
            try: return urllib.request.urlopen(request,timeout=120)
            except urllib.error.HTTPError as error:
                retry=error.code==429 or error.code>=500
                if not retry or attempt+1==attempts: raise RuntimeError(f'Storage HTTP {error.code} on {method} {path.split("?")[0]}') from None
            except (urllib.error.URLError,TimeoutError):
                if attempt+1==attempts: raise RuntimeError(f'Storage network failure on {method} {path.split("?")[0]}') from None
            time.sleep(2**attempt)
    def json(self, method, path, body=None):
        with self.request(method,path,body) as response: return json.load(response)
    def buckets(self): return self.json('GET','/bucket')
    def page(self,bucket,prefix,offset):
        return self.json('POST','/object/list/'+urllib.parse.quote(bucket,safe=''),{'prefix':prefix,'limit':1000,'offset':offset,'sortBy':{'column':'name','order':'asc'}})
    def objects(self,bucket):
        result=[];seen=set()
        def walk(prefix):
            offset=0
            while True:
                page=self.page(bucket,prefix,offset)
                if not page: break
                for item in page:
                    name=item.get('name')
                    if not name: raise RuntimeError('Storage list entry has no name')
                    path=prefix+name
                    if item.get('id') is None or item.get('metadata') is None: walk(path.rstrip('/')+'/')
                    else:
                        if path in seen: continue
                        seen.add(path);result.append({'bucket':bucket,'path':path,'metadata':item.get('metadata'),'updated_at':item.get('updated_at')})
                if len(page)<1000: break
                offset+=len(page)
        walk('')
        return result

def safe_member(bucket,path):
    full=f'objects/{bucket}/{path}'
    pure=posixpath.normpath(full)
    if full.startswith('/') or pure!=full or '..' in pathlib.PurePosixPath(full).parts or '\x00' in full: raise RuntimeError('unsafe Storage object path')
    return full

def download_object(client,obj,destination):
    bucket,path=obj['bucket'],obj['path']
    suffix='/object/'+urllib.parse.quote(bucket,safe='')+'/'+urllib.parse.quote(path,safe='/')
    digest=hashlib.sha256();size=0
    with client.request('GET',suffix) as response,open(destination,'wb') as out:
        os.chmod(destination,0o600)
        while True:
            chunk=response.read(CHUNK)
            if not chunk: break
            digest.update(chunk);size+=len(chunk);out.write(chunk)
    expected=(obj.get('metadata') or {}).get('size')
    if expected is None or int(expected)!=size: raise RuntimeError('downloaded object size differs from metadata')
    return {'bucket':bucket,'path':path,'metadata':obj.get('metadata'),'updated_at':obj.get('updated_at'),'bytes':size,'sha256':digest.hexdigest()}

def aggregate(buckets,objects,failures):
    by_bucket={bucket['name']:{'bucket':bucket['name'],'public':bool(bucket.get('public')),'objects':0,'bytes':0} for bucket in buckets}
    for obj in objects:
        entry=by_bucket[obj['bucket']];entry['objects']+=1;entry['bytes']+=int((obj.get('metadata') or {}).get('size') or 0)
    return {'buckets':list(by_bucket.values()),'objects':len(objects),'bytes':sum(item['bytes'] for item in by_bucket.values()),'failures':len(failures)}

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--project',default='klyrasrqgxijwrxuoevj');parser.add_argument('--env-file',required=True)
    parser.add_argument('--inventory-only',action='store_true');parser.add_argument('--inventory-output',required=True)
    parser.add_argument('--output');parser.add_argument('--key');parser.add_argument('--aead');parser.add_argument('--work')
    args=parser.parse_args()
    client=Storage(args.project,secret_from_env_file(args.env_file,'SUPABASE_SERVICE_ROLE_KEY'))
    buckets=client.buckets();objects=[];failures=[]
    try:
        for bucket in buckets: objects.extend(client.objects(bucket['name']))
    except Exception:
        pathlib.Path(args.inventory_output).write_text(json.dumps({'complete':False,'error':'Storage inventory failed; see safe console error'})+'\n')
        raise
    pathlib.Path(args.inventory_output).write_text(json.dumps(aggregate(buckets,objects,failures),indent=2)+'\n')
    os.chmod(args.inventory_output,0o600)
    print(f"Storage inventory: {len(buckets)} buckets, {len(objects)} objects, {sum(int((o.get('metadata') or {}).get('size') or 0) for o in objects)} bytes")
    if args.inventory_only:return
    if not all([args.output,args.key,args.aead,args.work]):raise RuntimeError('backup output, key, AEAD helper and work directory are required')
    process=subprocess.Popen(['node',args.aead,'encrypt',args.key,args.output],stdin=subprocess.PIPE)
    entries=[]
    try:
        with tarfile.open(fileobj=process.stdin,mode='w|') as archive:
            for obj in objects:
                descriptor=None
                try:
                    member=safe_member(obj['bucket'],obj['path'])
                    fd,descriptor=tempfile.mkstemp(prefix='object-',dir=args.work);os.close(fd)
                    for attempt in range(4):
                        try:
                            entry=download_object(client,obj,descriptor);break
                        except Exception:
                            if attempt==3:raise
                            time.sleep(2**attempt)
                    entries.append(entry)
                    info=tarfile.TarInfo(member);info.size=entry['bytes'];info.mode=0o600;info.mtime=int(time.time())
                    with open(descriptor,'rb') as source:archive.addfile(info,source)
                except Exception as error:
                    failures.append({'bucket':obj['bucket'],'path':obj['path'],'error':str(error)[:300]})
                finally:
                    if descriptor:
                        try:os.unlink(descriptor)
                        except FileNotFoundError:pass
            manifest=json.dumps({'format':1,'objects':entries,'failures':failures},ensure_ascii=False,separators=(',',':')).encode()
            info=tarfile.TarInfo('SUNLAND-STORAGE-MANIFEST.json');info.size=len(manifest);info.mode=0o600;info.mtime=int(time.time())
            archive.addfile(info,io.BytesIO(manifest))
        if process.stdin:process.stdin.close()
        code=process.wait()
        if code:raise RuntimeError(f'encryption helper exited {code}')
    except Exception:
        try:process.stdin.close()
        except Exception:pass
        process.kill();process.wait();raise
    pathlib.Path(args.inventory_output).write_text(json.dumps(aggregate(buckets,entries,failures),indent=2)+'\n');os.chmod(args.inventory_output,0o600)
    print(f'Storage backup: {len(entries)} objects encrypted; {len(failures)} failures')
    if failures:sys.exit(3)
if __name__=='__main__':main()
