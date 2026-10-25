#!/usr/bin/env bash
set -euo pipefail
umask 077
HERE="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$HOME/.config/sunland-backup"
SERVICE="dev.sunland.supabase.production.db-password"
mkdir -p "$CONFIG";chmod 700 "$CONFIG"
if [[ ! -f "$CONFIG/encryption.key" ]];then
  openssl rand -out "$CONFIG/encryption.key" 32
  chmod 600 "$CONFIG/encryption.key"
  echo 'Created a new local AES-256 key (not displayed).'
else
  [[ $(stat -f '%Lp' "$CONFIG/encryption.key") == 600 ]]||{ echo 'Existing key permissions must be 600' >&2;exit 1;}
  [[ $(wc -c <"$CONFIG/encryption.key"|tr -d ' ') == 32 ]]||{ echo 'Existing key must be 32 bytes' >&2;exit 1;}
  echo 'Existing backup key retained.'
fi
if ! security find-generic-password -s "$SERVICE" >/dev/null 2>&1;then
  echo 'macOS will now securely prompt for the Supabase production database password.'
  security add-generic-password -a "$USER" -s "$SERVICE" -w
else
  echo 'Existing Keychain database credential retained.'
fi
python3 - "$HERE/../../.env.local" <<'PY'
import sys
path=sys.argv[1]
assert any(line.startswith('SUPABASE_SERVICE_ROLE_KEY=') for line in open(path)), 'SUPABASE_SERVICE_ROLE_KEY missing'
PY
cat <<MSG
Local backup prerequisites are ready.
Key: $CONFIG/encryption.key (mode 600; keep an independent secure copy)
Database credential: macOS Keychain service $SERVICE
No secret was printed or stored in Git.
MSG
