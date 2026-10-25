#!/usr/bin/env python3
"""Obtain a short-lived, explicitly read-only Supabase CLI login role."""
import json
import os
import pathlib
import subprocess
import sys
import urllib.error
import urllib.request

PROJECT_REF = "klyrasrqgxijwrxuoevj"


def access_token():
    if os.environ.get("SUPABASE_ACCESS_TOKEN"):
        return os.environ["SUPABASE_ACCESS_TOKEN"]
    for account in ("supabase", "default", "access-token"):
        result = subprocess.run(
            ["security", "find-generic-password", "-s", "Supabase CLI", "-a", account, "-w"],
            capture_output=True, text=True,
        )
        if result.returncode == 0:
            return result.stdout.strip()
    raise RuntimeError("Supabase CLI access token unavailable; run supabase login")


def obtain():
    request = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{PROJECT_REF}/cli/login-role",
        data=json.dumps({"read_only": os.environ.get("SUNLAND_LOGIN_READ_ONLY", "true") == "true"}).encode(),
        headers={
            "Authorization": f"Bearer {access_token()}",
            "Content-Type": "application/json",
            "User-Agent": "sunland-read-only-backup/1",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            if response.status != 201:
                raise RuntimeError(f"Unexpected login-role HTTP status: {response.status}")
            data = json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Read-only login-role request failed: HTTP {error.code}") from None
    except urllib.error.URLError as error:
        raise RuntimeError("Read-only login-role request failed: network error") from None
    if not data.get("role", "").startswith("cli_login_") or not data.get("password"):
        raise RuntimeError("Read-only login-role response was invalid")
    return {"role": data["role"], "password": data["password"]}


def main():
    cache = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1] else None
    if cache and cache.exists():
        if oct(cache.stat().st_mode & 0o777) != "0o600":
            raise RuntimeError("Login-role cache permissions must be 600")
        data = json.loads(cache.read_text())
    else:
        data = obtain()
        if cache:
            fd = os.open(cache, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as output:
                json.dump(data, output)
    json.dump(data, sys.stdout)


if __name__ == "__main__":
    raise SystemExit("Disabled: use the existing Keychain credential; production role creation is outside backup authorization")
