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

## 仍然未覆盖的上线阻断

1. 正常的真实付款/退款业务路径及生产环境下的 GraphQL 付款证明校验，没有端到端集成验证。
2. 没有验证完整生产 D1 schema、真实 Supabase RPC、重试幂等/权益一致性和跨数据库故障恢复；当前 D1 仅用于异常分支模拟。
3. 尚未验证大批量订单、Cron 重叠竞争、付款与退款事件重放、跨服务绑定的权限控制等。
4. 没有部署新的 Worker，也没有进行真实身份认证、用户配额修改、支付订单写入或 Pro 会员开通。
5. Miniflare 是本地 workerd 模拟环境，不等于 Cloudflare 网络边缘的完整生产平台；从隔离测试通过到部署仍需人工核准、生产基线复核和分阶段回滚方案。

## 安全发布门禁

维持 Draft PR，不自动合并。后续须在**完全隔离的 D1 + Supabase RPC + 付款查询 Mock** 中验证带正常/重复/退款事件的完整路径，确保权益只能在可信付款证明后变更。生产发布及生产回滚必须单独授权。
