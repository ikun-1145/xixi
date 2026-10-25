#!/usr/bin/env bash
set -euo pipefail
umask 077
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROJECT_REF="klyrasrqgxijwrxuoevj"
IMAGE="public.ecr.aws/supabase/postgres:17.6.1.143"
KEY_FILE="${SUNLAND_BACKUP_KEY:-$HOME/.config/sunland-backup/encryption.key}"
KEYCHAIN_SERVICE="dev.sunland.supabase.production.db-password"
PG_BIN="${SUNLAND_PG_BIN:-/opt/homebrew/opt/libpq/bin}"
DEFAULT_ROOT="/Volumes/机械硬盘/SunlandBackups"
require_tools(){ for tool in docker node python3 openssl shasum security stat;do command -v "$tool" >/dev/null||{ echo "Missing dependency: $tool" >&2;exit 2;};done;docker info >/dev/null 2>&1||{ echo 'Docker is not running' >&2;exit 2;};docker image inspect "$IMAGE" >/dev/null||{ echo "Missing Docker image: $IMAGE" >&2;exit 2;}; }
check_key(){ [[ -f "$KEY_FILE" ]]||{ echo "Backup key missing; run $SCRIPT_DIR/configure-local.sh" >&2;exit 2;};[[ $(stat -f '%Lp' "$KEY_FILE") == 600 ]]||{ echo 'Backup key permissions must be 600' >&2;exit 2;};[[ $(wc -c <"$KEY_FILE"|tr -d ' ') == 32 ]]||{ echo 'Backup key must be 32 bytes' >&2;exit 2;}; }
production_tool(){
  local tool="$1" password;shift
  case "$tool" in pg_dump|pg_dumpall|psql);;*) echo 'Production backup tool is not allowed' >&2;return 2;;esac
  [[ -f "${SUNLAND_DB_CA:-$HOME/.config/sunland-backup/prod-ca.crt}" ]] || { echo "Trusted Supabase CA certificate missing; set SUNLAND_DB_CA" >&2;return 2; }
  # Existing Keychain credential only. Never create or elevate a production role.
  password=$(security find-generic-password -s "$KEYCHAIN_SERVICE" -w) || {
    echo 'Existing Keychain database credential unavailable' >&2;return 2;
  }
  [[ -x "$PG_BIN/$tool" ]]||{ echo "Missing local PostgreSQL client: $tool" >&2;return 2; }
  PGPASSWORD="$password" PGHOST="aws-0-ap-southeast-1.pooler.supabase.com" PGPORT="${SUNLAND_DB_PORT:-5432}" \
    PGUSER="postgres.$PROJECT_REF" PGDATABASE=postgres PGSSLMODE=verify-full \
    PGSSLROOTCERT="${SUNLAND_DB_CA:-$HOME/.config/sunland-backup/prod-ca.crt}" PGCONNECT_TIMEOUT=20 \
    PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=300000' \
    "$PG_BIN/$tool" "$@"
}

check_external_root(){
  local root="$1" volume
  [[ "$root" == /Volumes/* && "$root" != /Volumes ]]||{ echo 'Backup root must be on an explicitly mounted external volume' >&2;exit 2;}
  volume=$(dirname "$root")
  [[ -d "$volume" && ! -L "$volume" ]]||{ echo 'External volume is not mounted' >&2;exit 2;}
  diskutil info "$volume"|grep -Eq 'Device Location:[[:space:]]+External'||{ echo 'Target volume is not confirmed external' >&2;exit 2;}
  diskutil info "$volume"|grep -Eq 'Volume Read-Only:[[:space:]]+No'||{ echo 'Target volume is read-only' >&2;exit 2;}
  [[ ! -L "$root" ]]||{ echo 'Backup root must not be a symlink' >&2;exit 2;}
}

remove_work(){
  python3 - "$1" <<'PY'
import os,shutil,sys
path=os.path.abspath(sys.argv[1]);name=os.path.basename(path)
if name!='.work' and not name.startswith(('.verify.','.restore.')):raise RuntimeError('refusing unsafe temporary cleanup path')
shutil.rmtree(path)
PY
}
