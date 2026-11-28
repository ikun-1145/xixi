# 霜蓝 AI 会员 API 运维

## 架构与凭据

独立 Worker `sunland-membership-api` 只向 Supabase Data API 发起一个批量 RPC。PostgreSQL 在同一事务中核验内部凭据、合作方密钥、直接查询开关与配额，再读取 `public.user_profiles.pro`。现有支付、退款和历史永久会员共用该状态。当前权威数据没有额外的到期字段，第三方查询随现有权益系统更新的 `pro` 字段变化，同时过滤封禁与非活跃身份。

Worker 使用 Supabase **publishable** key 通过 Data API 网关，并用独立的 256 位 RPC 凭据验证查询。该凭据在数据库中只存 SHA-256 哈希，只能解锁 `sunland_membership_check` 这一项操作，调用仍需有效合作方密钥的哈希。RPC 的匿名入口在验证内部凭据前不读取用户、合作方密钥或会员数据。Worker 与合作方都无须持有 Postgres 登录、Supabase secret key 或 `service_role`。生产的 `PUBLIC` 角色能访问 `pg_net` 对象，直接签发普通 PostgreSQL LOGIN 会继承这些权限，因此使用单操作凭据。

每个合作方的直接查询权限默认关闭，包括升级前已签发密钥的合作方。数据库在合作方行锁内检查开关，关闭提交后新的查询返回 403，已完成数据库判断的请求仍可能在关闭后返回。历史逐用户授权表和维护命令继续保留，供未来重新启用。当前查询按有效密钥和合作方开关放行。

## 部署前

1. 为隔离环境使用独立 Supabase 数据库、本地或隔离的 Wrangler 环境及合成数据。迁移依赖现有 `user_profiles` 定义、Supabase 数据库角色和 `user_profiles_email_unique_idx`。按顺序应用初始迁移和直接查询迁移。后者为现有合作方默认关闭直接查询，并替换原 RPC。使用数据库迁移所有者执行，确认函数所有者可读取权威资料且不是可被合作方使用的角色。
2. 分别在隔离与生产库检查 Data API 的暴露 schema。保留新表所在的 `sunland_membership` 为私有，仅允许经 `public.sunland_membership_check` 调用。验证 `anon` 无新 schema、表的直接访问权。公开 RPC 入口收到错误内部凭据时应返回应用状态 503，任何合作方密钥本身都不能绕过它。
3. 复核数据库最外层语句超时和日志设置。现有生产只读检查显示 `anon` 的 `statement_timeout` 为 3 秒，Postgres `log_statement=ddl`、`log_min_duration_statement=-1`、`log_parameter_max_length_on_error=0`。保留请求体与参数脱敏，避免开启会采集 RPC 请求体、SQL 绑定参数或认证头的诊断采样。
4. 对 100 个合成邮箱检查执行计划。批量 SQL 使用现有部分索引 `user_profiles_email_unique_idx`。生产只读计划也显示使用该邮箱索引。查看完整测试用例可复现查询。
5. 即将上线时复核 Cloudflare DNS、Workers Custom Domains、Workers Routes 和 Pages 归属。2026-11-28 已核查 `openapi.sunland.dev` 无独立绑定或记录，公开请求匹配现有通配 DNS 并返回 525。上线时使用独立 Custom Domain，并检查缓存规则对该主机明确绕过公共缓存。可用边缘 WAF 按源 IP 抑制无效密钥或非合作来源的突发请求，并为 Worker 的 `200_anomalous_access` 和持续 503 配置告警。

## 管理员 CLI

在运维终端安装 Node.js 24，进入本目录执行 `npm ci`。从私有密钥管理系统注入 `MEMBERSHIP_ADMIN_DATABASE_URL`，只能由运维终端持有。生产使用带 TLS 校验的直连或会话连接，必要时用 `MEMBERSHIP_ADMIN_CA_FILE` 指定项目 CA。先核对数据库环境，再执行写命令。

```sh
node admin.mjs partner-create partner-a
printf '%s' '{"requests_per_minute":60,"requests_per_day":5000,"emails_per_day":50000,"batch_limit":100}' |
  node admin.mjs partner-configure partner-a --json
printf '%s' '{"expiresAt":"2027-12-31T00:00:00Z"}' |
  node admin.mjs key-issue partner-a --json
```

签发输出 JSON 含 `id` 和仅出现一次的 `api_key`。保存 ID 用于管理，通过加密渠道交给合作方。避免在有日志采集的终端或命令流水线签发。仅需永久密钥时可省略 `expiresAt`。过渡期可先签发第二把密钥，确认切换后吊销第一把。两把密钥共享配额。

| 命令 | 操作 |
| --- | --- |
| `key-disable <id>` | 禁用该密钥 |
| `key-revoke <id>` | 永久吊销该密钥 |
| `key-rotate <id>` | 同一事务吊销旧 key 并签发新 key，可通过 `--json` 设新有效期 |
| `partner-disable <partner>` / `partner-enable <partner>` | 暂停合作方，或恢复其仍获批的直接查询权限 |
| `direct-query-enable <partner> --json` | 按合作方开启直接查询，并记录审批工单编号和开启时间 |
| `direct-query-disable <partner>` | 关闭该合作方直接查询，保留密钥及最近一次审批记录 |
| `worker-issue` | 生成独立 RPC token，明文与 ID 仅输出一次 |
| `worker-revoke <id>` | 吊销对应 RPC token |

### 正式开放审批

管理员在批准预先指定的合作方前，须在受控工单记录并确认以下内容：

- 合作方法人或组织、责任人、查询来源和允许同步的用户范围。用途限定为约定的会员权益同步。
- 双方在查询前完成用户告知，说明邮箱匹配、会员布尔结果共享、用途、保存期限、撤回或退出渠道。合作方应在查询前确认并留存适用的合法授权依据。
- 明确保存和删除期限、访问控制、凭据保管、撤回处理以及异常通报和停用流程。禁止批量枚举非约定用户、转售、转发或作为其他用途的数据源。

工单经管理员确认后，用编号开启指定合作方。已有密钥随开关生效。停用后重新开放时，重新核验审批。合作方收到退出或撤回应移出同步名单，必要时管理员关闭其直接查询权限。

```sh
printf '%s' '{"approvalRef":"MEMBERSHIP-123"}' |
  node admin.mjs direct-query-enable partner-a --json
node admin.mjs direct-query-disable partner-a
```

### 保留的逐用户授权维护命令

管理员可用以下命令维护历史逐用户授权记录。当前直接查询忽略该记录，使用退出名单或合作方开关停止相关处理。授权文件字段为 `{"userId":"synthetic-user","verifiedEmail":"user@example.com"}`，撤销文件只需要 `userId`。

```sh
node admin.mjs consent-grant partner-a --json < /secure/verified-consent.json
node admin.mjs consent-revoke partner-a --json < /secure/verified-revocation.json
```

## Wrangler 与上线顺序

仓库的 `wrangler.toml` 默认没有对外路由，禁用 workers.dev 和预览 URL。本地验证使用 Wrangler 4.169.0 或支持配置中兼容日期的更新版本。隔离环境叫 `sunland-membership-api-staging`，通过单独的 `.dev.vars.staging` 或独立的 Worker Secrets 指向隔离数据库。密钥文件仅本机可读，并已忽略提交。

```sh
npm ci
wrangler dev --local --env staging
wrangler deploy --dry-run --env staging
wrangler deploy --dry-run --env=""
```

配置 `SUPABASE_URL`、`SUPABASE_PUBLISHABLE_KEY` 和 `MEMBERSHIP_RPC_TOKEN`。可使用 Wrangler `secret bulk` 读取权限为 0600 的本地 JSON 文件，或用 Cloudflare 控制台逐项填写。首次上线经授权后，先应用迁移、准备 Worker 凭据，在确认目标环境的情况下建立无路由 Worker 并配置 Secrets。先在隔离环境验证默认关闭、显式开启、单查、100 人批查、停用、限流、数据库 503 和日志内容，再给生产配置增加下列顶层段并发布。生产每次执行 Wrangler 写命令都显式传入 `--env=""`，隔离环境传入 `--env staging`。

```toml
[[routes]]
pattern = "openapi.sunland.dev"
custom_domain = true
```

域名生效后验收 `GET /health` 和带合成账户的 API。健康接口只检查 Worker 存活。日志只记录伙伴标识、时间、数量、耗时、请求 ID、结果状态。当 UTC 自然日累计至少 100 个邮箱查询结果未匹配档案，且占当日各批去重后总查询人次至少 90% 时，记录异常状态。该信号仅见于内部日志。查明异常时可通过 CLI 暂停合作方或单把密钥。轮换 Worker Secret 时先签发新 RPC token、更新 Secret 并验证，随后吊销旧 token。

## 回滚

先在 Cloudflare 移除本 Worker 的 Custom Domain 绑定，或者在已有兼容版本时将 Worker 回滚到该版本。保留现有 DNS 通配配置。需要立即停止查询时，使用 CLI 吊销 Worker RPC token，或对受影响的合作方执行 `direct-query-disable`。需要恢复逐用户校验时，先关闭路由或吊销 Worker RPC token，再用新的回滚迁移恢复初始迁移中的 RPC 函数体及权限。回滚迁移应在同一事务执行 `update sunland_membership.partners set direct_query_enabled=false where direct_query_enabled;`。保留审批与授权记录，后续启用直接查询前重新审批。常规回滚保留私有授权、配额和密钥哈希表，便于恢复与审计。确认需永久下线且留存策略允许删除记录后，由数据库管理员执行独立迁移，按顺序移除新 RPC、授权表、密钥表、合作方表、Worker 凭据表与私有 schema。先备份，使用显式对象名，省略 `CASCADE`。

```sql
begin;
drop function public.sunland_membership_check(text,text,text[],integer);
drop table sunland_membership.authorizations, sunland_membership.api_keys;
drop table sunland_membership.partners, sunland_membership.worker_credentials;
drop schema sunland_membership;
notify pgrst, 'reload schema';
commit;
```

Cloudflare 文档见 [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) 和 [Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)。Supabase 文档见 [Data API 密钥](https://supabase.com/docs/guides/getting-started/api-keys) 和 [查询超时](https://supabase.com/docs/guides/database/postgres/timeouts)。
