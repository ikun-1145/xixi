# 支付 Worker 独立预发布验收与放行门禁（2026-11-03）

> **截至本文创建时，只有完全隔离的本地/CI 环境通过测试。未创建 Cloudflare 预发布 Worker、未合并 PR、未变更任何生产绑定或订单。** 本文是后续明确授权后的操作条件，不是部署命令。

## 已完成的离线证据

- 当前线上支付 Worker 和 GitHub 历史源码 SHA-256 相同，候选两次 Wrangler 构建字节一致。
- 实际 `workerd` + 临时本地 D1 通过 **13/13** 场景（5 个 Cron 基础异常场景、8 个付款/退款/积压/并发场景），全部出站调用由进程内 Mock 拦截。
- PGlite 实际执行了 **49** 项 PostgreSQL 回归测试，线上 Supabase 三个 Waffo RPC 的定义指纹与受审迁移 **3/3** 相同。
- 针对积压的红灯测试曾确实复现：10 条无法匹配意图的旧 outbox 行阻塞第 11 条有效行。候选已增加固定错误码及 `updated_at` 重试时间推进，另覆盖 10 条损坏 JSON 队列的相同问题。
- 最新经核验 GitHub Actions：Payment Cron Heartbeat CI **41595934430**、Payment Worker Reproducible Build Audit **41595934404**，均 PASS。完整仓库 798 项：797 通过、0 失败、1 跳过。

## 下一阶段：独立 Cloudflare 预发布环境（尚未实施）

必须由维护者另行批准**创建独立资源**。不可复用生产 Worker 名称、路由、Cron、D1、Service Binding、Supabase service_role、爱发电 Token、Waffo Production 私钥或任何真实订单标识。

推荐隔离形态：
- 单独 Worker 名称，例如 `waffopay-preprod`，仅内部可访问，**不暴露公开真实支付 Webhook 路由**，且初始状态下不启用 Cron；
- 独立 D1 数据库，使用仓库 `schema.sql` 和 `outbox.sql` 初始化，仅导入虚构付款意图、回调和事件；
- 独立身份服务 Mock，Service Binding 不可指向现有 `ai/production`；
- 独立 Supabase 开发项目或严格模拟的 RPC，不能连接线上项目；用不同于生产的测试服务端密钥；
- Waffo 测试端点或经白名单拦截的 GraphQL Mock，**不能调用实际 Production 支付 API**；
- `WAFFO_PRODUCTION_ENTITLEMENT_ENABLED=false` 作为首轮安全默认值。为测试权益 RPC 的变动，必须使用全套虚构身份、独立 PostgreSQL 环境与受控测试密钥；
- 环境变量、D1 数据库 ID、域名、绑定目标和 Cron 需在部署前人工核实。严禁简单复制线上 `wrangler.toml` 并执行部署。

## 预发布验收流程和阻断项

1. **部署前核对**：只读检查当前生产版本和绑定仍与审计基线一致；检查候选编译 SHA 与通过 CI 的提交完全相同。
2. **资源隔离证明**：对比生产和预发布 Worker、D1、Service Binding、RPC 地址，任何关键资源标识相同即 BLOCKED。
3. **业务验证**：用签名测试 Webhook 验证付款、重放、退款先后顺序、坏签名、金额/商品/商户不一致拒绝。观察是否有模拟权益异常授予。
4. **积压与并发**：至少验证 12 条队列分两轮 10+2 消化、10 条无效/无意图数据不阻塞后续有效事件、2 个重叠 Cron 不重复授予模拟权益。
5. **断点恢复**：在 RPC 提交后人为丢弃响应，确认 pending outbox 经下次 Cron 变为 delivered、PostgreSQL 只应用一次权益变更。
6. **可观测性**：检验 `waffo_production_outbox_cycle` 的 disabled/completed/incomplete 和 `waffo_production_outbox_unavailable`，禁止“无错误日志=支付成功”的判定。
7. **发布后恢复演练**：准备并核对回滚 Worker 版本、旧绑定以及前进修复方案。代码回滚**不会**撤销 D1/PostgreSQL 已确认的支付状态，绝不能通过反向修改会员字段做“回滚”。
8. **人工签发**：预发布通过之后，提交独立生产发布评审；不得由合并 PR 自动触发支付 Worker 部署。

## 保持生产 NO-GO 的条件

- 未经批准启用生产 Cron 或写入 Production D1；
- 预发布环境缺少 Service Binding / RPC / Provider 隔离证据；
- 编译后产物、生产指纹或关键配置出现未解释漂移；
- 不能证明真实密钥不会进入测试 CI 或 logs；
- 存在任何未归因的重复权益授予、退款后复活、被坏数据阻塞队列或重试不收敛；
- 没有明确的生产回滚版本、观测指标与人工值守安排。

**当前结论：本地隔离与真实 PostgreSQL 验收通过；独立云端预发布尚未开始，生产发布仍为 NO-GO。**
