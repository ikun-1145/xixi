#!/usr/bin/env python3
import hashlib,json,re,sys
source_counts,source_objects,restored_counts,restored_objects,output=sys.argv[1:]
load=lambda path:json.load(open(path))
sc,so,rc,ro=map(load,(source_counts,source_objects,restored_counts,restored_objects))
def canonical(item):
    item=json.loads(json.dumps(item))
    acl=item.get('acl')
    # Preserve grant options and grantors; only reorder simple, unquoted entries.
    if isinstance(acl,str) and re.fullmatch(r'\{[A-Za-z0-9_*/=,]*\}',acl):item['acl']=sorted(acl[1:-1].split(','))
    if item.get('schema')=='public' and item.get('name')=='email_codes':
        qualified=hashlib.md5(b'extensions.uuid_generate_v4()').hexdigest()
        unqualified=hashlib.md5(b'uuid_generate_v4()').hexdigest()
        for column in item.get('columns',[]):
            if column['name']=='id' and column.get('default_md5')==unqualified:column['default_md5']=qualified
    return item

missing={};mismatched={}
for category in ('tables','indexes','constraints','functions','triggers','policies','extensions'):
    identity=lambda item:json.dumps(canonical(item),sort_keys=True)
    wanted={identity(item) for item in so.get(category,[])};actual={identity(item) for item in ro.get(category,[])}
    if wanted!=actual:missing[category]={'missing_or_changed':sorted(wanted-actual),'unexpected_or_changed':sorted(actual-wanted)}
for table,count in sc.items():
    if rc.get(table)!=count:mismatched[table]={'source':count,'restored':rc.get(table)}
# Only known local managed-extension version substitutions are classified here.
allowed_versions={'pg_net':('0.14.0','0.20.3'),'pg_cron':('1.6','1.6.4')}
source_ext={x['name']:x for x in so.get('extensions',[])};restored_ext={x['name']:x for x in ro.get('extensions',[])}
managed=[];extension_blocked=False
for name in source_ext.keys()|restored_ext.keys():
 source,restored=source_ext.get(name),restored_ext.get(name)
 if source==restored:continue
 if source and restored and source['schema']==restored['schema'] and (source['version'],restored['version'])==allowed_versions.get(name):
  managed.append({'name':name,'source_version':source['version'],'local_version':restored['version']})
 else:extension_blocked=True
core=not mismatched and not (set(missing)-{'extensions'}) and not extension_blocked
result={'passed':not missing and not mismatched,'core_business_passed':core,'managed_extension_differences':managed,'comparison_normalizations':['ACL entry order only; grantors and grant options retained','public.email_codes.id uuid_generate_v4 qualification resolves to extensions.uuid_generate_v4 in source archive'],'row_counts_match':not mismatched,'critical_objects_match':not missing,'checked_tables':len(sc),'missing_objects':missing,'row_count_mismatches':mismatched}
with open(output,'w') as out:json.dump(result,out,indent=2);out.write('\n')
print(json.dumps({key:value for key,value in result.items() if key not in ('missing_objects','row_count_mismatches')}))
if missing or mismatched:sys.exit(1)
