#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)";source "$HERE/common.sh"
require_tools;check_key
SOURCE="${1:?usage: restore-local.sh BACKUP_DIRECTORY}";[[ -d "$SOURCE" ]]||{ echo 'Backup directory missing' >&2;exit 2;}
# Each run owns its reports; archive bytes and historical reports remain unchanged.
if [[ -n "${2:-}" ]];then
 DEST="$2";[[ "$DEST" == "$SOURCE/"* && ! -e "$DEST" && ! -L "$DEST" ]]||{ echo 'Restore evidence path must be a new directory inside the source batch' >&2;exit 2;};mkdir -m 700 "$DEST"
else
 DEST=$(mktemp -d "$SOURCE/restore-run.XXXXXX")
fi
STAGE='copy-and-verify'
early_failure(){ local code=$?;if ((code));then python3 - "$DEST/restore-result.json" "$STAGE" <<'PY_EARLY'
import datetime,json,sys
with open(sys.argv[1],'w') as out:json.dump({'passed':False,'failed_stage':sys.argv[2],'tested_at':datetime.datetime.now(datetime.timezone.utc).isoformat()},out,indent=2)
PY_EARLY
fi; }
trap early_failure EXIT
python3 - "$SOURCE" "$DEST" <<'PY_COPY'
import json,pathlib,shutil,sys
source,target=map(pathlib.Path,sys.argv[1:])
manifest=json.load(open(source/'backup-manifest.json'))
for name in [*manifest['files'],'backup-manifest.json']:
 if pathlib.PurePath(name).name!=name:raise RuntimeError('Unsafe backup manifest path')
 shutil.copy2(source/name,target/name)
PY_COPY
printf 'Restore evidence directory: %s\n' "$DEST"
"$HERE/verify-backup.sh" "$DEST" "$DEST"
ROOT=$(dirname "$DEST");WORK=$(mktemp -d "$ROOT/.restore.XXXXXX");RUN=$(python3 -c 'import uuid;print(uuid.uuid4())');NAME="sunland-restore-${RUN:0:12}";LABEL='dev.sunland.production-restore';STAGE='initialization'
cleanup(){
 local code=$? cleanup_failed=0 actual
 if [[ -n "${NAME:-}" ]]&&docker inspect "$NAME" >/dev/null 2>&1;then
  actual=$(docker inspect "$NAME" --format "{{index .Config.Labels \"$LABEL\"}}")||cleanup_failed=1
  if [[ "$actual" == "$RUN" ]];then
   docker logs "$NAME" >"$DEST/postgres-container.log" 2>&1||cleanup_failed=1
   chmod 600 "$DEST/postgres-container.log"||cleanup_failed=1
   docker rm --force "$NAME" >/dev/null||cleanup_failed=1
  else
   cleanup_failed=1
  fi
 elif ! docker info >/dev/null 2>&1;then
  cleanup_failed=1
 fi
 remove_work "$WORK"||cleanup_failed=1
 python3 - "$DEST/restore-result.json" "$STAGE" "$code" "$cleanup_failed" <<'PY_CLEANUP'
import datetime,json,pathlib,sys
path=pathlib.Path(sys.argv[1]);stage=sys.argv[2];code=int(sys.argv[3]);cleanup_failed=int(sys.argv[4])
result=json.load(open(path)) if path.exists() else {'passed':False,'failed_stage':stage,'tested_at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
if code and stage!='complete':result.update(passed=False,failed_stage=stage)
result['cleanup_complete']=not cleanup_failed
if cleanup_failed:result.update(passed=False,cleanup_warning='Container or plaintext cleanup did not complete; inspect this run locally')
path.write_text(json.dumps(result,indent=2)+'\n')
PY_CLEANUP
 if ((cleanup_failed));then echo 'Local recovery cleanup incomplete' >&2;exit 1;fi
 exit "$code"
}
trap cleanup EXIT
STAGE='decrypt';node "$HERE/aead-file.mjs" decrypt "$KEY_FILE" "$DEST/database.dump.aesgcm" "$WORK/database.dump"
node "$HERE/aead-file.mjs" decrypt "$KEY_FILE" "$DEST/roles.sql.aesgcm" "$WORK/roles.sql"
[[ $(dd if="$WORK/database.dump" bs=5 count=1 2>/dev/null) == PGDMP ]]||{ echo 'Decrypted database is not a custom pg_dump archive' >&2;exit 1;}
STAGE='container';LOCAL_RESTORE_PASSWORD=$(openssl rand -hex 32);export PGPASSWORD="$LOCAL_RESTORE_PASSWORD"
docker run --detach --name "$NAME" --label "$LABEL=$RUN" --network none --read-only --memory 2g --cpus 2 --pids-limit 192 --user 100:101 -e LOCAL_RESTORE_PASSWORD="$LOCAL_RESTORE_PASSWORD" --tmpfs /tmp:rw,nosuid,size=4g,mode=1777 --tmpfs /etc/postgresql-custom:rw,nosuid,size=1m,mode=777 --entrypoint bash "$IMAGE" -c "umask 077;printf '%s' \"\$LOCAL_RESTORE_PASSWORD\" >/tmp/pg.password;initdb -D /tmp/backup-pg -A scram-sha-256 --pwfile=/tmp/pg.password --no-locale >/dev/null;rm /tmp/pg.password;exec postgres -D /tmp/backup-pg -k /tmp -c listen_addresses='' -c shared_buffers=64MB -c shared_preload_libraries='pg_stat_statements,pgaudit,plpgsql,plpgsql_check,pg_cron,pg_net,pgsodium,auto_explain,pg_tle,plan_filter,supabase_vault' -c cron.database_name=sunland_restore -c pgsodium.getkey_script=/usr/lib/postgresql/bin/pgsodium_getkey.sh -c vault.getkey_script=/usr/lib/postgresql/bin/pgsodium_getkey.sh" >/dev/null
local_psql(){ docker exec -i -e PGPASSWORD "$NAME" psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -h /tmp "$@"; }
for _ in {1..150};do if local_psql -d postgres -c 'select 1' >/dev/null 2>&1;then break;fi;sleep 0.2;done
local_psql -d postgres -c 'select 1' >/dev/null
STAGE='roles';python3 - "$WORK/roles.sql" "$WORK/roles-local.sql" <<'PY'
import re,sys
source,target=sys.argv[1:]
with open(source) as src,open(target,'w') as dst:
 for line in src:
  if line.startswith(('CREATE ROLE postgres;','ALTER ROLE postgres ')):
   continue
  if line.startswith('GRANT '):
   line=re.sub(r' GRANTED BY [^;]+','',line)
  dst.write(line)
PY
local_psql -d postgres <"$WORK/roles-local.sql"
STAGE='database';local_psql -d postgres -c 'create database sunland_restore' >/dev/null
STAGE='pg_restore';restore_archive(){ docker exec -i -e PGPASSWORD -e PGVERBOSITY=terse "$NAME" pg_restore --exit-on-error -U postgres -h /tmp -d sunland_restore "$@" <"$WORK/database.dump" 2>>"$DEST/pg_restore.log"; }
: >"$DEST/pg_restore.log"
restore_archive --section=pre-data
# Validated production CHECKs may have historical rows that predate them.
# Recreate every original definition after COPY, then validate exactly those
# that were validated at source. Any real violation still fails the restore.
local_psql -d sunland_restore -c "SELECT format('ALTER TABLE %I.%I DROP CONSTRAINT %I;',n.nspname,c.relname,con.conname) FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE con.contype='c' AND con.conislocal AND con.conparentid=0 ORDER BY n.nspname,c.relname,con.conname;" >"$WORK/drop-checks.sql"
local_psql -d sunland_restore -c "CREATE TABLE public._sunland_restore_checks AS SELECT n.nspname AS schema_name,c.relname AS table_name,con.conname,pg_get_constraintdef(con.oid) AS definition,con.convalidated FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE con.contype='c' AND con.conislocal;"
local_psql -d sunland_restore -c "SELECT format('%s|%s|%s',schema_name,table_name,conname) FROM public._sunland_restore_checks WHERE convalidated ORDER BY schema_name,table_name,conname;" >"$WORK/validate-checks.txt"
python3 - "$DEST/source-inventory.json" >>"$WORK/validate-checks.txt" <<'PY'
import json,sys
for item in json.load(open(sys.argv[1]))['constraints']:
 if item['type']=='c' and item['validated']:print(f"{item['schema']}|{item['table']}|{item['name']}")
PY
sort -u -o "$WORK/validate-checks.txt" "$WORK/validate-checks.txt"
local_psql -d sunland_restore <"$WORK/drop-checks.sql"
restore_archive --section=data
restore_archive --section=post-data
local_psql -d sunland_restore -c "SELECT format('ALTER TABLE %I.%I ADD CONSTRAINT %I %s NOT VALID;',s.schema_name,s.table_name,s.conname,s.definition) FROM public._sunland_restore_checks s WHERE NOT EXISTS (SELECT FROM pg_constraint con WHERE con.conrelid=to_regclass(format('%I.%I',s.schema_name,s.table_name)) AND con.conname=s.conname) ORDER BY s.schema_name,s.table_name,s.conname;" >"$WORK/restore-checks.sql"
local_psql -d sunland_restore <"$WORK/restore-checks.sql"
: >"$WORK/validation-failures.txt"
while IFS='|' read -r schema table constraint;do
 [[ -n "$constraint" ]]||continue
 q_schema=${schema//\"/\"\"};q_table=${table//\"/\"\"};q_constraint=${constraint//\"/\"\"}
 if ! docker exec -e PGPASSWORD -e PGVERBOSITY=terse "$NAME" psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -h /tmp -d sunland_restore -c "ALTER TABLE \"$q_schema\".\"$q_table\" VALIDATE CONSTRAINT \"$q_constraint\"" 2>>"$WORK/validation-errors.log";then
  printf '%s|%s|%s\n' "$schema" "$table" "$constraint" >>"$WORK/validation-failures.txt"
 fi
done <"$WORK/validate-checks.txt"
local_psql -d sunland_restore -c "SELECT json_build_object('chat_messages_rows',(SELECT count(*) FROM public.chat_messages),'chat_messages_text_violations',(SELECT count(*) FROM public.chat_messages WHERE char_length(text)>8000),'chat_messages_max_chars',(SELECT max(char_length(text)) FROM public.chat_messages),'oc_profiles_rows',(SELECT count(*) FROM public.oc_profiles),'oc_profiles_description_violations',(SELECT count(*) FROM public.oc_profiles WHERE char_length(description)>500),'oc_profiles_max_description_chars',(SELECT max(char_length(description)) FROM public.oc_profiles));" >"$WORK/data-quality.json"
local_psql -d sunland_restore -c 'DROP TABLE public._sunland_restore_checks'
chmod 600 "$DEST/pg_restore.log"
STAGE='storage-database-link';local_psql -d sunland_restore -c "SELECT coalesce(json_agg(json_build_array(bucket_id,name,(metadata->>'size')::bigint) ORDER BY bucket_id,name),'[]'::json) FROM storage.objects;" >"$WORK/storage-database-identities.json"
python3 - "$WORK/storage-database-identities.json" "$DEST/storage-restore-result.json" <<'PY_STORAGE_LINK'
import hashlib,json,sys
items=json.load(open(sys.argv[1]));result=json.load(open(sys.argv[2]))
digest=hashlib.sha256(json.dumps(sorted(items),separators=(',',':')).encode()).hexdigest()
result['database_metadata_matches']=digest==result['object_identity_sha256']
result['passed']=result['passed'] and result['database_metadata_matches']
with open(sys.argv[2],'w') as out:json.dump(result,out,indent=2);out.write('\n')
PY_STORAGE_LINK
STAGE='inventory';local_psql -d sunland_restore <"$HERE/inventory.sql" >"$DEST/restored-inventory.json"
python3 "$HERE/row_counts.py" "$DEST/restored-inventory.json" "$WORK/restored-row-counts.sql"
local_psql -d sunland_restore <"$WORK/restored-row-counts.sql" >"$DEST/restored-row-counts.json"
STAGE='compare';python3 "$HERE/compare_inventory.py" "$DEST/source-row-counts.json" "$DEST/source-inventory.json" "$DEST/restored-row-counts.json" "$DEST/restored-inventory.json" "$DEST/restore-comparison.json"||true
STAGE='report';python3 - "$DEST" "$RUN" "$WORK/validation-failures.txt" <<'PY'
import datetime,json,pathlib,sys
root=pathlib.Path(sys.argv[1]);comparison=json.load(open(root/'restore-comparison.json'));storage=json.load(open(root/'storage-restore-result.json'));source=json.load(open(root/'database.dump.aesgcm.source.json'))
failures=[{'schema':parts[0],'table':parts[1],'constraint':parts[2]} for line in open(sys.argv[3]) if len(parts:=line.rstrip('\n').split('|'))==3]
result={'passed':comparison['passed'] and storage['passed'] and not failures,'tested_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'run_id':sys.argv[2],'network':'none','published_ports':False,'database':'sunland_restore','pg_restore':'exit-on-error completed','decrypted_database_bytes':source['bytes'],'decrypted_database_sha256':source['sha256'],'database_comparison':comparison,'storage_comparison':storage,'constraint_validation_failures':failures,'restored_data_quality':json.load(open(pathlib.Path(sys.argv[3]).parent/'data-quality.json')),'limitations':['Roles restored without passwords; local bootstrap postgres role and its local superuser privilege are retained. GRANTED BY is removed from local role membership replay.', 'Object owners and ACLs are replayed. Inventory equality covers the recorded business scope, not all Supabase platform services.','Local Vault uses a disposable test root key; production Vault secret recovery is not verified.','No Storage objects were uploaded to any cloud project.','Supabase hosted API/Auth/Storage service configuration is outside pg_dump and requires platform restoration.']}
(root/'restore-result.json').write_text(json.dumps(result,indent=2)+'\n')
manifest_path=root/'backup-manifest.json'
if manifest_path.exists():
 manifest=json.load(open(manifest_path));manifest['restore_tested']=result['passed'];manifest['restore_verified_at']=result['tested_at'];manifest_path.write_text(json.dumps(manifest,indent=2)+'\n')
PY
chmod 600 "$DEST"/*.json
STAGE='complete';python3 - "$DEST/restore-result.json" <<'PY'
import json,sys
if not json.load(open(sys.argv[1]))['passed']:raise SystemExit('Recovery data comparison completed, but full acceptance failed; see restore-result.json')
PY
echo "Isolated PostgreSQL and Storage recovery verification passed: $DEST"
