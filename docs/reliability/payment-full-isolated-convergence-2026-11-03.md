# 支付完整隔离回归：workerd + D1 + RPC 模拟 + PostgreSQL（2026-11-03）

> 本文是 Draft PR #34 的候选验收证据。**没有使用生产 Waffo、Supabase、Cloudflare 密钥、真实付款或会员账户**，也没有合并/部署任何 Worker。

## 1. 验证架构

- 新增 `scripts/reliability/payment-workerd-convergence.mjs`，直接加载 Wrangler `--dry-run` 编译后的 Waffo Worker bundle，在固定 Miniflare 5 (workerd, compatibility date 2026-09-05) 中测试。
- 使用当场生成的 RSA 测试公私钥签名 Webhook；Test 和 Production 测试公钥为不同密钥，避免从仓库或线上读取秘密。
- 使用真实本地 D1 实例，执行仓库维护的**完整 D1 `schema.sql` 与 `outbox.sql`**，存储测试 payment intent、event ledger 与 outbox。
- 所有 outbound requests 由进程内白名单 `outboundService` 处理：只模拟 Waffo GraphQL 订单证明与 Supabase `sunland_waffo_apply_event` RPC；其他目标直接拒绝，**绝不真实联网**。
- RPC 模拟器保留事件去重、已退款终态与“提交成功但响应丢失”行为；这是 JS 事务模型，**不是**真实 Supabase SQL 实现。真实 SQL 单独使用 PGlite 验证。

## 2. 已通过的真实 workerd 组合路径

| 场景 | 核验 |
|---|---|
| 已签名订单完成 Webhook 首次到达和原样重放 | D1 ledger 只有一份事件记录；模拟权益仅授予一次；重复事件回复 duplicate |
| 已授予权益后发生退款，再重放订单完成 | 权益保持 revoked；不会重新授予 |
| Supabase RPC 已提交而 HTTP 响应丢失 | 旧 outbox 保持 pending；Cron 重试后转为 delivered；模拟权益仅授予一次 |
| 非法签名与 Waffo GraphQL Test-mode 订单 | 不调用权益 RPC；D1 保持 pending 或拒绝写入；无权益授予 |

- GitHub Actions **Run #41591472905** 的真实 `workerd` 新增组合验收 **4/4 通过**；先前 Cron 异常测试仍 **5/5 通过**。
- 前两次 CI 暴露出测试 SQL 的加载方式问题：Miniflare D1 对注释与多行 CREATE 的 `exec` 行解析不同。已改用可信静态 SQL 逐条 `db.prepare(...).run()`，最终真实 D1 表被正确建立，测试通过。
- 这些断言验证了 Workers 的真实验签、Provider/RPC 调用编排、D1 存储与重试行为，但 Provider 与 RPC 响应仍由受控模拟器提供。

## 3. 真实 PostgreSQL SQL 回归

- 将现有 `workers/waffopay/production-backend/verify-source-rpc.mjs` 纳入新 `postgres-rpc-sandbox` CI 作业。
- 使用固定 `@electric-sql/pglite@0.3.16` 在 GitHub Actions 内存中执行仓库历史 RPC fixture + `20261002071010_waffo_production_entitlement_sources.sql`，**不连接生产 Supabase**。
- GitHub Actions **Run #41591710806** 的 SQL 作业输出：**48 real PostgreSQL regression checks passed**。
- 覆盖真实函数的事件重复、退款墓碑、退款后旧事件重放、人工/爱发电等其他权益来源保持、事务注入回滚、角色 EXECUTE 权限、私有 Schema 读取限制。

## 4. 仍然阻断生产发布的因素

1. PGlite 验证的是仓库声明的 SQL 迁移与函数，尚未只读证明**当前线上 Supabase 对应函数**和所有依赖与该提交保持一致。
2. `outboundService` 使用进程内 GraphQL/RPC 模拟器，不能代替真实 Waffo 支付验证、真实 Edge service binding、生产 webhook 重试和真实跨数据库网络故障。
3. 暂无真实环境的并发 Cron / 大量 backlog / 实际 D1 读写延迟压力指标。
4. PR #34 增加了支付 Cron 日志语义，但尚未在独立非生产 Worker 对完整支付流进行端到端部署验收。
5. 所有生产发布、发布后变更和回滚必须获得单独明确授权；CI 成功本身不授权生产写操作。

## 5. 操作与保持不变量

- GitHub Actions 无 Cloudflare/Supabase 生产凭据；Workerd 与 PGlite 都使用短暂内存状态。
- 未开启真实付款、退款或 Pro 开通。
- `PR #32` 网页错误提示、`PR #33` 只读监控、`PR #34` 支付心跳均保持 Draft。
