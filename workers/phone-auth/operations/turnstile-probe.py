#!/usr/bin/env python3
"""Call the no-SMS admin diagnostic once; read both sensitive inputs from FDs.

--expect-replay checks a second, separately invoked call with the same token.
A failed replay is meaningful only after a confirmed successful first call and
while the three feature switches remain false. Never retry an uncertain call.
"""
import argparse
import json
import os
import ssl
import urllib.error
import urllib.request

URL = 'https://api.sunland.dev/v1/phone/_admin/turnstile-probe'

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def read_fd(fd, maximum):
    parts, size = [], 0
    while size <= maximum:
        part = os.read(fd, maximum + 1 - size)
        if not part:
            break
        parts.append(part)
        size += len(part)
    data = b''.join(parts)
    if not data or len(data) > maximum or any(byte < 33 or byte > 126 for byte in data):
        raise ValueError('invalid input')
    return data.decode('ascii')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--admin-fd', required=True, type=int)
    parser.add_argument('--token-fd', required=True, type=int)
    parser.add_argument('--expect-replay', action='store_true')
    args = parser.parse_args()
    try:
        if args.admin_fd < 0 or args.token_fd < 0 or args.admin_fd == args.token_fd:
            raise ValueError('invalid descriptors')
        admin = read_fd(args.admin_fd, 512)
        token = read_fd(args.token_fd, 2048)
        if len(admin.encode('ascii')) < 32:
            raise ValueError('invalid admin')
        request = urllib.request.Request(URL, method='POST',
            headers={'Authorization': 'Bearer ' + admin, 'Content-Type': 'application/json'},
            data=json.dumps({'token': token}, separators=(',', ':')).encode('ascii'))
        del admin, token
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(),
                                             urllib.request.HTTPSHandler(context=ssl.create_default_context()))
        try:
            response = opener.open(request, timeout=10)
        except urllib.error.HTTPError as exc:
            response = exc
        with response:
            body = response.read(1025)
            if len(body) > 1024:
                raise ValueError('oversize response')
            value = json.loads(body)
            expected_status = 403 if args.expect_replay else 200
            expected_value = {'ok': not args.expect_replay}
            if response.status != expected_status or value != expected_value:
                raise ValueError('unexpected response')
        print('ok')
        return 0
    except Exception:
        print('failed')
        return 1

if __name__ == '__main__':
    raise SystemExit(main())
