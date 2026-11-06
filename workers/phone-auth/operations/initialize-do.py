#!/usr/bin/env python3
"""Initialize or inspect the production DO only after separate authorization.

Read the existing admin token from stdin without a newline. Status also creates
an object if none exists; it is not a harmless pre-initialization probe.
"""
import json
import sys
import urllib.error
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main():
    if len(sys.argv) != 3 or sys.argv[1] != '--execute' or sys.argv[2] not in ('initialize', 'status'):
        print('Not executed. Read PREFLIGHT.md and obtain separate production authorization.')
        return 2
    try:
        token = sys.stdin.buffer.read(4097)
        if not 32 <= len(token) <= 4096 or any(c < 33 or c > 126 for c in token):
            raise ValueError('invalid token')
        request = urllib.request.Request('https://api.sunland.dev/v1/phone/_admin/' + sys.argv[2], data=b'{}',
            headers={'Authorization': 'Bearer ' + token.decode('ascii'), 'Content-Type': 'application/json'}, method='POST')
        del token
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=10) as response:
            if response.status != 200:
                raise ValueError('unexpected status')
            raw = response.read(4097)
        if len(raw) > 4096:
            raise ValueError('unexpected response')
        body = json.loads(raw)
        if (not isinstance(body, dict) or body.get('success') is not True or body.get('schema') != 1 or
            body.get('enabled') is not True or body.get('mode') != 'canary' or
            any(type(body.get(k)) is not int or body[k] != 0 for k in ('test_reserved','total_micros','day_count','day_micros'))):
            raise ValueError('unexpected state')
        print('DO response confirms initialized canary ledger and zero counters.')
        return 0
    except Exception:
        print('Stopped: operation failed or outcome may be unknown. Do not retry; investigate separately.')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
