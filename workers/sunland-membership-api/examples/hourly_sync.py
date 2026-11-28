"""合作方定时任务示例。运行前按接入文档初始化本地 SQLite 数据库。"""

import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request

BATCH_SIZE = 100
HOUR = 3600


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class RetryLater(Exception):
    def __init__(self, seconds):
        self.seconds = seconds


def check_batch(base_url, key, emails):
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}/v1/membership/batch",
        data=json.dumps({"emails": emails}).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    opener = urllib.request.build_opener(NoRedirect())
    for attempt in range(4):
        try:
            with opener.open(request, timeout=15) as response:
                data = json.load(response)
            results = data.get("results")
            if (data.get("success") is not True or not isinstance(results, list)
                    or [item.get("email") for item in results] != emails
                    or any(type(item.get("is_pro")) is not bool for item in results)):
                raise ValueError("invalid_response")
            return results
        except urllib.error.HTTPError as error:
            status = error.code
            retry_after = error.headers.get("Retry-After", "")
            error.close()
            if status == 429:
                delay = int(retry_after) if retry_after.isdecimal() else 60
                if delay > 60 or attempt == 3:
                    raise RetryLater(max(1, delay)) from None
                time.sleep(max(1, delay))
            elif status in (500, 503) and attempt < 3:
                time.sleep(2 ** attempt)
            else:
                raise RuntimeError(f"membership_http_{status}") from None
        except (TimeoutError, urllib.error.URLError):
            if attempt == 3:
                raise RuntimeError("membership_network_error") from None
            time.sleep(2 ** attempt)


def sync(connection, base_url, key, batch_size=BATCH_SIZE):
    if not 1 <= batch_size <= BATCH_SIZE:
        raise ValueError("invalid_batch_size")
    now = int(time.time())
    throttle = connection.execute("select next_retry_at from sync_control where id=1").fetchone()
    if throttle and throttle[0] > now:
        return
    hour_start = now // HOUR * HOUR
    while True:
        emails = [row[0] for row in connection.execute(
            """select email from sync_users where has_partner_pro=0
               and last_checked_at < ? order by last_checked_at,email limit ?""",
            (hour_start, batch_size),
        )]
        if not emails:
            return
        try:
            results = check_batch(base_url, key, emails)
        except RetryLater as error:
            with connection:
                connection.execute(
                    """insert into sync_control(id,next_retry_at) values (1,?)
                       on conflict(id) do update set next_retry_at=excluded.next_retry_at""",
                    (int(time.time()) + error.seconds,),
                )
            return
        with connection:
            # 生产系统可在同一事务内持久化同步结果与发放事件，再由合作方幂等处理事件。
            connection.executemany(
                """update sync_users set has_partner_pro=max(has_partner_pro, ?), last_checked_at=?
                   where email=?""",
                [(int(item["is_pro"]), hour_start, item["email"]) for item in results],
            )


def main():
    database = os.environ["PARTNER_SYNC_DB"]
    base_url = os.environ.get("SUNLAND_API_BASE", "https://openapi.sunland.dev")
    if not base_url.startswith("https://"):
        raise ValueError("https_required")
    with sqlite3.connect(database) as connection:
        sync(connection, base_url, os.environ["SUNLAND_API_KEY"],
             int(os.environ.get("SUNLAND_BATCH_SIZE", BATCH_SIZE)))


if __name__ == "__main__":
    try:
        main()
    except (KeyError, TypeError, ValueError, AttributeError, sqlite3.Error, RuntimeError):
        sys.exit("同步失败，已提交的批次保留，当前批次将在后续运行重试。")
