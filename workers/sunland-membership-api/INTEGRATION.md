# 霜蓝 AI Pro 会员查询 v1

正式基地址为 `https://openapi.sunland.dev`。霜蓝 AI 确认上线后使用该地址，测试地址由双方另行约定。本版仅支持邮箱查询。所有查询由合作方服务端以 HTTPS 发起。

## 认证与数据使用范围

查询使用 `Authorization: Bearer sl_live_…` 与 `Content-Type: application/json`。密钥按合作方签发，只授予 `membership:read`。请存入服务端密钥管理系统，通过加密渠道交接。

本接口只向经霜蓝 AI 管理员审批的受信任合作方开放。直接查询权限默认关闭，开通后可用有效密钥直接提交邮箱。API 查询时无需提交逐用户授权记录。

合作方只能查询双方约定范围内、为会员权益同步所需的用户。首次查询前须告知用户将使用邮箱匹配、共享 Pro 布尔结果，并说明用途、保存期限和退出渠道。合作方须取得并留存适用的合法授权依据，收到退出或撤回后及时将用户移出同步名单。禁止查询约定范围外的邮箱、枚举账户、转发查询结果或改作其他用途。

## 接口

| 方法 | 路径 | 请求体 |
| --- | --- | --- |
| GET | `/health` | 无。返回 `{"status":"ok"}`，仅反映 Worker 存活 |
| POST | `/v1/membership/verify` | `{"email":"user@example.com"}` |
| POST | `/v1/membership/batch` | `{"emails":["user1@example.com","user2@example.com"]}` |

单用户成功响应

```json
{"success":true,"is_pro":true}
```

批量成功响应

```json
{"success":true,"results":[{"email":"user1@example.com","is_pro":true},{"email":"user2@example.com","is_pro":false}]}
```

邮箱去除首尾空白并转成小写。支持常用 ASCII 邮箱格式和已转为 Punycode 的域名。批量最多 100 个输入，按首次出现的顺序返回规范化、去重后的邮箱。每次请求 JSON 请求体最多 32 KiB。当前只接受表中的字段。

`is_pro: false` 统一涵盖未注册、普通用户、权益失效、封禁或非活跃账户等情况。只有 HTTP 200 的成功响应可以用于判定用户会员状态。批量结果按返回的邮箱关联本地记录。

## 错误与限流

错误响应包含 `success: false`、`error.code` 和 `request_id`。所有正常到达 Worker 的响应都含 `X-Request-Id`。排查时提供时间及请求 ID。

| HTTP | 错误码 | 含义 |
| --- | --- | --- |
| 400 | `invalid_request`、`invalid_email`、`invalid_batch_size` | JSON、字段、邮箱或批量大小不符合约定 |
| 401 | `invalid_api_key` | 密钥缺失、无效、已过期或已吊销 |
| 403 | `access_disabled` | 密钥或合作方访问已禁用，或合作方尚未开启直接查询 |
| 404 | `not_found` | 路径不存在 |
| 405 | `method_not_allowed` | 请求方法错误，见 `Allow` |
| 408 | `request_timeout` | 读取请求体超时 |
| 413 | `payload_too_large` | 请求体超过 32 KiB |
| 429 | `rate_limited` | 请求或人次配额用尽，按 `Retry-After` 秒数等待 |
| 500 | `internal_error` | 服务内部异常 |
| 503 | `membership_unavailable` | 数据库不可用或超时，可退避重试 |

每个合作方默认滚动 60 秒 60 次请求，UTC 自然日 5,000 次请求、50,000 个邮箱人次。配额在合作方所有密钥间共享。重复邮箱仍按提交的人次计入配额，越限请求不扣减。配额和每批上限可按合作方调整。对网络故障、500 和 503 做有限退避重试，对 429 遵循 `Retry-After`。单次超时可能发生在数据库已扣减配额之后。

## curl

从密钥管理系统注入 `SUNLAND_API_KEY`。示例从标准输入向 curl 传入认证头。

```sh
printf 'header = "Authorization: Bearer %s"\n' "$SUNLAND_API_KEY" |
  curl -sS --max-time 15 --config - 'https://openapi.sunland.dev/v1/membership/verify' \
    -H 'Content-Type: application/json' --data '{"email":"user@example.com"}'
```

## Python

```python
import json
import os
from urllib.request import HTTPRedirectHandler, Request, build_opener

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

request = Request(
    "https://openapi.sunland.dev/v1/membership/batch",
    data=json.dumps({"emails": ["user1@example.com", "user2@example.com"]}).encode(),
    headers={"Authorization": f"Bearer {os.environ['SUNLAND_API_KEY']}",
             "Content-Type": "application/json"},
    method="POST",
)
with build_opener(NoRedirect()).open(request, timeout=15) as response:
    results = json.load(response)["results"]
```

## JavaScript（Node.js 22+）

```js
const response = await fetch("https://openapi.sunland.dev/v1/membership/verify", {
  method: "POST",
  redirect: "error",
  headers: {
    Authorization: `Bearer ${process.env.SUNLAND_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ email: "user@example.com" }),
  signal: AbortSignal.timeout(15000),
});
if (!response.ok) throw new Error(`会员查询失败，HTTP ${response.status}`);
const { is_pro } = await response.json();
```

## 首次查询与每小时批量同步

首次按批查询约定范围内且已履行告知与授权要求的用户。受每日配额限制时，从上次保存的进度继续。后续每小时查询合作方尚未发放权益的用户。收到 `true` 后按本地用户 ID 幂等发放，收到 `false` 后等待下次同步。接口失败时保留当前状态及该批次，避免把失败写为 `false`。

[Python 小时任务示例](examples/hourly_sync.py) 使用 SQLite 保存进度及发放标记。初始化本地表并导入符合数据使用范围的规范化邮箱。已在合作平台开通会员的用户在本地标记为 `has_partner_pro=1`。

```sql
create table sync_users (
  email text primary key,
  has_partner_pro integer not null default 0,
  last_checked_at integer not null default 0
);
create index sync_users_due on sync_users(has_partner_pro,last_checked_at,email);
create table sync_control (
  id integer primary key check (id=1),
  next_retry_at integer not null
);
```

为定时进程注入 `PARTNER_SYNC_DB` 和 `SUNLAND_API_KEY`，每小时运行 `python3 examples/hourly_sync.py`。可通过 `SUNLAND_BATCH_SIZE` 设置双方约定的批量上限。示例按 UTC 小时记录进度，并持久化跨次运行的限流等待时间。为同一合作方设置任务互斥，并将示例中的发放标记接入本地权益事务或幂等事件。同步只负责查询和开通流程。
