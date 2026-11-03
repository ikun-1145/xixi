# Worker 健康快照（只读工具）

这是一份可重复运行的 Cloudflare Workers Observability 聚合指标快照工具。它**不是部署脚本，不自动告警，不执行生产写操作**。

## 当前监测范围

只监测已经投入使用且需要优先保障的 Worker：

- `ai`
- `afdianpay`
- `waffopay`

尚未完成的 `phone-auth` 被明确排除。

工具查询 Cloudflare Analytics SQL API 的 `logs.workersLogs` 聚合数据，分别统计 **HTTP Fetch** 与 **Scheduled/Cron** 执行次数，同时返回 HTTP 4xx/5xx、平均 CPU、近似最高 CPU 及平均运行时间。HTTP 5xx 比例的分母只计算 HTTP Fetch，不会混入 Cron。

工具另执行一条纯聚合 `SELECT`，从 Cloudflare 结构化日志的 `attributes['event']` 统计已存在的支付业务事件。爱发电目前可统计 `reconciliation_started`、`payment_scan_processed` 与 `scan_failed`，Waffo 可统计 `waffo_production_failed`、`waffo_production_outbox_unavailable`。查询**不读取订单详情、请求正文或原始消息**。

**重要：** `payment_scan_processed` 发生在完成游标 RPC 之前，不能算作整轮任务成功；Waffo 当前生产版本也没有可靠的成功心跳。没有业务事件或仅没有错误日志，都不能证明任务成功。Cloudflare 日志可能采样，计数只表示已观测事件。SQL **不查询** `message`、`url`、聊天正文、JWT、邮件、手机号或其他用户数据。

已预留对 [Draft PR #34](https://github.com/ikun-1145/xixi/pull/34) 的未来日志格式的支持：爱发电 `reconciliation_cycle_completed`，以及 Waffo 的 `waffo_production_outbox_cycle`（`status` 分为 `completed`、`incomplete`、`disabled`）。**这些心跳尚未部署到生产；当前缺失时报告 `NOT_OBSERVED`，绝不当作零次成功。** `completed` 只说明当前 Cron 执行/待处理批次没有已知失败，不是订单、退款或 Pro 会员权益成功的证明。

## 使用方法

1. 在 Cloudflare 创建仅可读取相关 Analytics 数据的专用 API Token。官方文档要求至少账户级 **Account Analytics Read**，部分日志数据集/字段还可能要求额外的只读权限。不要使用全局 API Key、Workers 编辑权限、Supabase Service Role 或生产部署 Token。
2. 在本机安全地设置 `CLOUDFLARE_ACCOUNT_ID`（32 位账号标识）和 `CLOUDFLARE_API_TOKEN` 环境变量，不要把凭据写入仓库、聊天、命令行参数或 CI 配置。
3. 在仓库根目录运行：

```bash
node scripts/reliability/worker-health.mjs --hours 24
```

也支持过去 1～168 小时，例如 `--hours 72`。默认过去 24 小时。

验证工具本身（仅 Mock，不连接 Cloudflare）：

```bash
node --test scripts/reliability/worker-health.test.mjs
```

## 解释结果时的边界

- Cloudflare 日志聚合可能有采样和自动加权，数字不一定等于逐条原始请求数。
- 执行记录包含部分非用户触发调用，不应该直接作为用户 API 请求量、收费金额或计费准确量。
- `NO OBSERVED LOG DATA` 代表该时段**没有观察到日志记录**，不代表 Worker 没有异常；可能是没有流量、日志未开启或数据尚未可用。
- 某段时间的 HTTP 5xx 为 0，并不证明 DeepSeek、Cron 或业务逻辑一定成功。
- 平均 CPU 与近似最大 CPU 不是 Cloudflare CPU 超限判定结果。
- 此工具**不会**自动通知故障，不能代替后续的 Cron 成功心跳或 Workers Issues 告警。
- 支付业务指标查询若失败，会让整个命令失败并返回非零退出码，不输出“0 次业务故障”误导使用者。
- 业务日志保存在 `attributes['event']`，不在普通 `message` 字段；聚合只使用代码中确认的固定事件名称。

## 数据安全与失败处理

- API 仅向 `/accounts/{account_id}/analytics/sql` 发送 `SELECT` 聚合查询；虽然 HTTP 方法为 POST，但这是查询接口，不涉及生产变更。
- API Token 只在请求头传递；错误输出不会打印 Token、响应正文或网络异常的原始堆栈。
- 不向 GitHub Actions 提供任何生产凭据；CI 只测试 Mock。
- 错误时返回非零退出码，但不会修改 Cloudflare 配置。
- 如 API 返回 403，请检查 Token 的正确只读权限；**不要**为使工具工作而授予编辑/部署权限。

文档：
- https://developers.cloudflare.com/analytics/sql-api/get-started/
- https://developers.cloudflare.com/analytics/sql-api/query-api/
