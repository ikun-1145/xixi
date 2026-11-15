# 支付 Worker 原生 workerd 隔离验收（2026-11-03）

> 只针对 Draft PR #34 的候选代码。测试未访问生产 Cloudflare、Supabase、Waffo、爱发电，也未进行真实付款、退款或权益写入。

## 测试方法

- GitHub Actions Run **41589880481** 的 `bundle-dry-run` job 在没有生产 API Token 或 Cloudflare 账号的条件下，先使用 Wrangler 4.141.0 `deploy --dry-run` 生成候选 Worker 文件。
- 新增 `scripts/reliability/payment-workerd-integration.mjs`，利用固定版本 **Miniflare 5.20261101.0-beta** 启动真正的 `workerd`，保持当前生产兼容日期 `2026-09-05`。
- 每个 Waffo 案例都创建全新临时本地 D1，并仅建立两张最小测试表：`production_outbox`、`payment_intents`。没有使用线上 D1 标识、表数据或密钥。
- Miniflare 的 `outboundService` 全部拦截并用本地模拟的 HTTP 503 响应处理出站请求，不转发任何请求到互联网。Waffo 测试断言出站请求计数必须为 0；爱发电故障场景则必须触发模拟拒绝。
- 导入 Wrangler 编译后的 ES module 明细清单，而不是独立重写 Worker 行为。每个案例都实际派发 Scheduled 事件，并在 Waffo 案例前后核对本地 outbox 行数未发生异常变化。
- 固定 Miniflare v5 是因为正式发布的 Miniflare v4 内置 workerd 不支持 Worker 使用的 2026-09-05 兼容日期。v5 当前仍是 beta，需要注意未来运行时依赖更新后的回归验证。

## 实际 workerd 结果

| 模拟场景 | workerd 观测结果 | 验证 |
|---|---|---|
| Waffo Production outbox 未配置 | `status=disabled`，全部计数为 0 | PASS |
| Waffo 配置有效、空 outbox | `status=completed,due=0` | PASS |
| Waffo 有待处理记录但没有匹配付款意图 | `status=incomplete,due=1,failed=0,unbound=1` | PASS |
| Waffo 待处理记录损坏 | `status=incomplete,due=1,failed=1,unbound=0` | PASS |
| 爱发电 Supabase RPC 全部由模拟服务拒绝 | `status=failed,rejected_tasks=3`，Cron 结果非成功 | PASS |

重要修正：最初测试的“缺少付款意图”案例未创建 `payment_intents` 表，实际上触发了 D1 异常。已在测试数据准备阶段创建表并重新运行；最终成功日志确认 **unbound=1、failed=0**，才将该场景列为通过。

全部 workerd 场景 **5/5 通过**。Run **41589880481** 两个 job 成功，仓库完整测试 **798 项，797 通过、0 失败、0 取消、1 跳过**。

## 验收范围更新（2026-11-03）

原文以下内容是首轮 **5 个异常场景**通过时的记录。后来补充了签名付款、退款重放、RPC 响应丢失以及真实 PGlite SQL 事务测试，具体结果请以 [完整隔离收敛报告](payment-full-isolated-convergence-2026-11-03.md) 为准。

截至最新测试：候选 Worker 在真实 workerd 下已通过 5 个 Cron 异常场景和 4 个签名付款/退款组合场景；真实本地 D1 已执行仓库完整测试 Schema；仓库 SQL 迁移使用 PGlite 已通过 48 项事务与权限检查。**外部付款与权益 RPC 仍为模拟响应，尚未验证线上 Supabase 函数定义或真实支付 Provider。**

## 当前仍然未覆盖的上线阻断

1. 尚未只读验证**当前线上** Supabase 权益函数、依赖和角色权限是否与仓库中已测试的迁移保持一致。
2. Waffo GraphQL、权益 RPC、Cloudflare Worker service binding 的真实跨服务路径在本轮完全隔离测试中仍由模拟器代替，不能等同于完整生产支付 E2E。
3. 未通过大量 backlog、并发重复 Cron、真实平台网络延迟和生产配置中的业务验收。
4. Miniflare 5 当前为固定 beta 测试工具，不等于生产边缘全部环境。
5. PR 仍为 Draft；没有生产部署，任何生产发布及回滚都必须另行获得批准。

## 安全发布门禁

先完成线上只读 SQL 漂移核对与独立非生产部署的端到端验证，再审查灰度/回滚和告警流程。不得将合并 GitHub PR 自动视为可以安全发布支付 Worker。
