#!/usr/bin/env python3
import json,sys
source_counts,source_objects,restored_counts,restored_objects,output=sys.argv[1:]
load=lambda path:json.load(open(path))
sc,so,rc,ro=map(load,(source_counts,source_objects,restored_counts,restored_objects))
missing={};mismatched={}
for category in ('tables','indexes','constraints','functions','triggers','policies','extensions'):
    identity=lambda item:json.dumps(item,sort_keys=True)
    wanted={identity(item) for item in so.get(category,[])};actual={identity(item) for item in ro.get(category,[])}
    if wanted!=actual:missing[category]={'missing_or_changed':sorted(wanted-actual),'unexpected_or_changed':sorted(actual-wanted)}
for table,count in sc.items():
    if rc.get(table)!=count:mismatched[table]={'source':count,'restored':rc.get(table)}
result={'passed':not missing and not mismatched,'row_counts_match':not mismatched,'critical_objects_match':not missing,'checked_tables':len(sc),'missing_objects':missing,'row_count_mismatches':mismatched}
with open(output,'w') as out:json.dump(result,out,indent=2);out.write('\n')
print(json.dumps({key:value for key,value in result.items() if key not in ('missing_objects','row_count_mismatches')}))
if missing or mismatched:sys.exit(1)
