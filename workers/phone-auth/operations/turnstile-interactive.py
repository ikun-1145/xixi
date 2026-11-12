#!/usr/bin/env python3
"""Run the no-SMS Turnstile probe with hidden local inputs; never retry failures."""
import getpass
import argparse
import os
from pathlib import Path
import subprocess
import sys

PROBE = Path(__file__).with_name('turnstile-probe.py')
INVALID_TOKEN = b'invalid-turnstile-negative-control'


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
        command = [sys.executable, str(PROBE), '--admin-fd', str(admin_read), '--token-fd', str(token_read)]
        if replay:
            command.append('--expect-replay')
        result = subprocess.run(command, pass_fds=(admin_read, token_read), capture_output=True, timeout=15)
        return result.returncode == 0 and result.stdout == (b'rejected\n' if replay else b'verified\n')
    finally:
        for descriptor in descriptors:
            os.close(descriptor)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--admin-only', action='store_true', help='check administrator credential without a real token')
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
        token = getpass.getpass('真实网页一次性 Turnstile token（隐藏输入）：').encode('ascii')
        if not 1 <= len(token) <= 2048 or any(byte < 33 or byte > 126 for byte in token) or token == INVALID_TOKEN:
            raise ValueError('invalid input')
        if not invoke(admin, token):
            print('合法 token 未确认通过；已停止，不重试。')
            return 1
        print('合法 token：通过')
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
