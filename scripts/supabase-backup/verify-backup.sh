#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)";source "$HERE/common.sh"
require_tools;check_key
DEST="${1:?usage: verify-backup.sh BACKUP_DIRECTORY}";[[ -d "$DEST" && -f "$DEST/backup-manifest.json" ]]||{ echo 'Backup directory or manifest missing' >&2;exit 2;}
python3 - "$DEST" <<'PY'
import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1]);manifest=json.load(open(root/'backup-manifest.json'))
required={'database.dump.aesgcm','database.dump.aesgcm.source.json','roles.sql.aesgcm','roles.sql.aesgcm.source.json','storage.tar.aesgcm','storage.tar.aesgcm.source.json','source-inventory.json','source-row-counts.json','storage-inventory.json'}
if manifest.get('format')!=1 or manifest.get('project_ref')!='klyrasrqgxijwrxuoevj' or set(manifest.get('files',{}))!=required:raise RuntimeError('Invalid backup manifest scope')
storage=json.load(open(root/'storage-inventory.json'))
if storage['failures'] or storage['objects']!=manifest['storage_objects'] or storage['bytes']!=manifest['storage_bytes']:raise RuntimeError('Storage manifest aggregate mismatch')
for name,item in manifest['files'].items():
 if pathlib.PurePath(name).name!=name:raise RuntimeError('unsafe manifest path')
 p=root/name
 if p.stat().st_size!=item['bytes'] or hashlib.sha256(p.read_bytes()).hexdigest()!=item['sha256']:raise RuntimeError('backup file SHA-256 mismatch: '+name)
print('Encrypted file sizes and SHA-256 values verified')
PY
for file in database.dump.aesgcm roles.sql.aesgcm storage.tar.aesgcm;do node "$HERE/aead-file.mjs" verify "$KEY_FILE" "$DEST/$file";done
RESULT_DIR="${2:-$(mktemp -d "$DEST/verify-run.XXXXXX")}"
ROOT=$(dirname "$DEST");WORK=$(mktemp -d "$ROOT/.verify.XXXXXX");trap 'remove_work "$WORK"' EXIT
node "$HERE/aead-file.mjs" decrypt "$KEY_FILE" "$DEST/storage.tar.aesgcm" "$WORK/storage.tar"
python3 "$HERE/storage_verify.py" "$WORK/storage.tar" "$RESULT_DIR/storage-restore-result.json" "$DEST/storage-inventory.json" "$WORK/objects"
chmod 600 "$RESULT_DIR/storage-restore-result.json"
