#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)";source "$HERE/common.sh"
require_tools;check_key
ROOT="${1:-$DEFAULT_ROOT}";check_external_root "$ROOT"
mkdir -p "$ROOT";chmod 700 "$ROOT"
[[ -z "${SUNLAND_RESUME_BACKUP:-}" ]]||{ echo 'Resume disabled: each database inventory must belong to its original backup window' >&2;exit 2;}
DEST="$ROOT/$(date +%Y-%m-%d_%H-%M-%S)";[[ ! -e "$DEST" ]]||{ echo 'Timestamp backup already exists; refusing overwrite' >&2;exit 2;}
mkdir -m 700 "$DEST";touch "$DEST/INCOMPLETE"
WORK="$DEST/.work";[[ ! -e "$WORK" ]]||{ echo 'Temporary work directory already exists' >&2;exit 2;};mkdir -m 700 "$WORK"
cleanup(){ local code=$?;remove_work "$WORK";if ((code));then echo "Backup incomplete; encrypted partial evidence retained at $DEST" >&2;fi; }
trap cleanup EXIT
START=$(date -u +%Y-%m-%dT%H:%M:%SZ);echo "Backup started at $START"
echo 'Exporting database, business catalog and counts from one shared READ ONLY snapshot...'
python3 "$HERE/snapshot_export.py" "$DEST" "$KEY_FILE"
echo 'Exporting role definitions without passwords...'
if [[ ! -s "$DEST/roles.sql.aesgcm" || ! -s "$DEST/roles.sql.aesgcm.source.json" ]];then production_tool pg_dumpall --roles-only --no-role-passwords --role=postgres | node "$HERE/aead-file.mjs" encrypt "$KEY_FILE" "$DEST/roles.sql.aesgcm";fi
echo 'Enumerating and downloading Storage objects with retries...'
BASE="${SUNLAND_STORAGE_BASE:-$DEFAULT_ROOT/2026-10-25_09-33-27}"
node "$HERE/aead-file.mjs" decrypt "$KEY_FILE" "$BASE/storage.tar.aesgcm" "$WORK/storage-base.tar"
if [[ ! -s "$DEST/storage.tar.aesgcm" || ! -s "$DEST/storage.tar.aesgcm.source.json" || ! -s "$DEST/storage-inventory.json" ]];then
 python3 "$HERE/storage_backup.py" --reuse-tar "$WORK/storage-base.tar" --project "$PROJECT_REF" --env-file "$REPO_DIR/.env.local" --inventory-output "$DEST/storage-inventory.json" --output "$DEST/storage.tar.aesgcm" --key "$KEY_FILE" --aead "$HERE/aead-file.mjs" --work "$WORK"
fi
END=$(date -u +%Y-%m-%dT%H:%M:%SZ)
PG_VERSION=$("$PG_BIN/pg_dump" --version)
python3 - "$DEST" "$START" "$END" "$PG_VERSION" <<'PY'
import hashlib,json,os,pathlib,sys
root=pathlib.Path(sys.argv[1]);inventory=json.load(open(root/'source-inventory.json'));storage=json.load(open(root/'storage-inventory.json'))
names=['database.dump.aesgcm','database.dump.aesgcm.source.json','roles.sql.aesgcm','roles.sql.aesgcm.source.json','storage.tar.aesgcm','storage.tar.aesgcm.source.json','source-inventory.json','source-row-counts.json','storage-inventory.json']
files={}
for name in names:
 p=root/name;files[name]={'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
manifest={'format':1,'project_ref':'klyrasrqgxijwrxuoevj','started_at':sys.argv[2],'ended_at':sys.argv[3],'database_version':inventory['server_version'],'backup_tool_version':sys.argv[4],'encryption':'AES-256-GCM; random 96-bit IV; authenticated header; per-file plaintext SHA-256 sidecar','database_archive_bytes':(root/'database.dump.aesgcm').stat().st_size,'storage_objects':storage['objects'],'storage_bytes':storage['bytes'],'files':files,'limitations':['Role passwords and Supabase platform credentials are never exported.','Full managed-schema export uses an existing Keychain credential; no production roles are created and database commands use read-only sessions.','Supabase managed extensions/configuration may require platform-specific restoration; local restore results are recorded separately.','Storage API restoration is not performed without a separately authorized isolated cloud project.'],'restore_tested':False,'snapshot':json.load(open(root/'snapshot-evidence.json')),'storage_collection':{k:v for k,v in storage.items() if k!='buckets'},'storage_base_batch':os.environ.get('SUNLAND_STORAGE_BASE','2026-10-25_09-33-27')}
(root/'backup-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');os.chmod(root/'backup-manifest.json',0o600)
PY
"$HERE/restore-local.sh" "$DEST" "$DEST/initial-restore"
python3 - "$DEST" <<'PY_RESULT'
import json,pathlib,sys
root=pathlib.Path(sys.argv[1]);result=json.load(open(root/'initial-restore/restore-result.json'))
if not result['core_business_passed'] or not result['cleanup_complete'] or not result['storage_comparison']['passed']:raise SystemExit('Restore acceptance failed')
manifest=json.load(open(root/'backup-manifest.json'));manifest['restore_tested']=result['passed'];manifest['core_business_restore_tested']=True;manifest['restore_verified_at']=result['tested_at'];manifest['restore_evidence']='initial-restore/restore-result.json'
(root/'backup-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
PY_RESULT
touch "$DEST/CORE_BUSINESS_RESTORE_VERIFIED"
if python3 - "$DEST/backup-manifest.json" <<'PY_FULL'
import json,sys
sys.exit(0 if json.load(open(sys.argv[1]))['restore_tested'] else 1)
PY_FULL
then rm "$DEST/INCOMPLETE";touch "$DEST/COMPLETE";fi
echo "Backup and isolated recovery verification completed: $DEST"
