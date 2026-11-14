#!/usr/bin/env python3
"""Run the no-SMS Turnstile probe with hidden local inputs; never retry failures."""
import getpass
import argparse
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time

PROBE = Path(__file__).with_name('turnstile-probe.py')
INVALID_TOKEN = b'invalid-turnstile-negative-control'
ORIGIN = 'https://sunland.dev'


def receive_browser_token():
    """Receive one real-origin token in memory via a one-use loopback endpoint."""
    path = '/' + secrets.token_urlsafe(32)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, status):
            self.send_response(status)
            self.send_header('Access-Control-Allow-Origin', ORIGIN)
            self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type')
            self.send_header('Access-Control-Allow-Private-Network', 'true')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()

        def permitted(self):
            return (self.path == path and self.headers.get('Origin') == ORIGIN and
                    self.headers.get('Host') == '127.0.0.1:' + str(self.server.server_port))

        def do_OPTIONS(self):
            self.reply(204 if self.permitted() else 403)

        def do_POST(self):
            if not self.permitted() or self.headers.get('Transfer-Encoding'):
                self.reply(403)
                return
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 1 <= length <= 2048:
                    raise ValueError('invalid token length')
                self.connection.settimeout(5)
                token = self.rfile.read(length)
                if (len(token) != length or any(byte < 33 or byte > 126 for byte in token)
                        or token == INVALID_TOKEN):
                    raise ValueError('invalid token')
            except (ValueError, OSError):
                self.reply(400)
                return
            self.server.token = token
            self.reply(204)

    with HTTPServer(('127.0.0.1', 0), Handler) as server:
        server.timeout = 1
        server.token = None
        url = f'http://127.0.0.1:{server.server_port}{path}'
        snippet = ("void window.SunlandPhoneAuth.runTurnstile('phone_login').then(t=>fetch(" +
                   json.dumps(url) + ",{method:'POST',headers:{'Content-Type':'text/plain'},body:t,"
                   "referrerPolicy:'no-referrer'})).catch(()=>{});")
        print('请在 https://sunland.dev/login 的开发者控制台执行以下代码，并完成页面提示；令牌不会打印：')
        print(snippet, flush=True)
        deadline = time.monotonic() + 180
        while server.token is None and time.monotonic() < deadline:
            server.handle_request()
        if server.token is None:
            raise TimeoutError('browser token not received')
        return server.token


def invoke(admin, token, replay=False):
    descriptors = []
    try:
        admin_read, admin_write = os.pipe()
        descriptors.extend((admin_read, admin_write))
        token_read, token_write = os.pipe()
        descriptors.extend((token_read, token_write))
        with os.fdopen(admin_write, 'wb') as out:
            descriptors.remove(admin_write)
            out.write(admin)
        with os.fdopen(token_write, 'wb') as out:
            descriptors.remove(token_write)
            out.write(token)
        command = [sys.executable, str(PROBE), '--admin-fd', str(admin_read), '--token-fd', str(token_read), '--safe-details']
        if replay:
            command.append('--expect-replay')
        result = subprocess.run(command, pass_fds=(admin_read, token_read), capture_output=True, timeout=15)
        accepted = result.returncode == 0 and result.stdout == (b'rejected\n' if replay else b'verified\n')
        if not accepted:
            messages = {
                b'failed:unexpected_acceptance\n': '诊断入口返回成功：重复 token 未被拒绝。',
                b'failed:unauthorized\n': '诊断入口未接受管理员凭据。',
                b'failed:rate_limited\n': '诊断请求受到限流。',
                b'failed:service_error\n': '诊断服务或上游返回服务错误。',
                b'failed:transport_error\n': '诊断请求连接失败或超时。',
                b'failed:invalid_response\n': '诊断响应无法确认。',
            }
            print(messages.get(result.stdout, '诊断结果未知。'))
        return accepted
    finally:
        for descriptor in descriptors:
            os.close(descriptor)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--admin-only', action='store_true', help='check administrator credential without a real token')
    modes.add_argument('--browser', action='store_true', help='receive the real browser token over loopback')
    args = parser.parse_args(argv)
    try:
        admin = getpass.getpass('管理员凭据（隐藏输入）：').encode('ascii')
        if not 32 <= len(admin) <= 512 or any(byte < 33 or byte > 126 for byte in admin):
            raise ValueError('invalid input')
        if args.admin_only:
            if not invoke(admin, INVALID_TOKEN, replay=True):
                print('管理员凭据未确认通过；已停止，不重试。')
                return 1
            print('诊断入口已接受管理员凭据；未验证真实 Turnstile token。')
            return 0
        token = receive_browser_token() if args.browser else getpass.getpass('真实网页一次性 Turnstile token（隐藏输入）：').encode('ascii')
        if not 1 <= len(token) <= 2048 or any(byte < 33 or byte > 126 for byte in token) or token == INVALID_TOKEN:
            raise ValueError('invalid input')
        if not invoke(admin, token):
            print('合法 token 未确认通过；已停止，不重试。')
            return 1
        print('合法 token：通过')
        # Cloudflare documents eventually consistent token redemption. This is
        # one deliberate replay check after propagation, not an automatic retry.
        time.sleep(6)
        if not invoke(admin, token, replay=True):
            print('重复 token 未确认被拒绝；已停止，不重试。')
            return 1
        print('重复 token：已拒绝')
        if not invoke(admin, INVALID_TOKEN, replay=True):
            print('错误 token 未确认被拒绝；已停止，不重试。')
            return 1
        print('错误 token：已拒绝；请复核三个功能开关仍关闭。')
        return 0
    except (Exception, KeyboardInterrupt):
        print('验证失败或结果未知；已停止，不重试。')
        return 1


if __name__ == '__main__':
    sys.exit(main())
