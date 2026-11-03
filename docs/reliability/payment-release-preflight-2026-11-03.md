# 支付 Worker 生产一致性检查（2026-11-03）

本工具在支付 Worker 部署前，**只读**比对 Cloudflare 当前生产运行版本与 2026-11-03 已审核基线。

> **它不是部署器，不调用真实支付，不读取真实订单，不执行迁移，也不会变更生产状态。**
> 工具的 PASS 只表示当前部署与已审核基线吻合，不代表新候选 Worker 已经通过安全验收，更不代表授权上线。

## 1. 受检范围

仅 afdianpay 与 waffopay；不涉及未完成的 phone-auth。预期元数据：

`docs/reliability/payment-worker-production-baseline-2026-11-03.json`

基线仅包含：Worker 版本 ID、当前部署 bundle 的 SHA-256、Cron、兼容日期、日志开关、绑定**名称和类型**、关键非敏感模式开关、Service Binding 目标、KV/D1 资源标识。**没有 API Key、私钥、JWT、Supabase Service Role 凭据、真实交易数据或密钥值。**

- 爱发电：版本 `a84fa755-4a9e-456a-94eb-8746c7f11d1b`，bundle SHA-256 `a512bdccaaa3168f3ed56a3009e2a317f8651160930315bed1c2b1850503ec4a`，Cron 每两分钟。哈希与仓库历史正式发布证据 `docs/afdianpay-cpu-fencing-release-20261013.md` 完全吻合。
- Waffo：版本 `b414b89b-2218-47c6-bb7a-b85513af9125`，bundle SHA-256 `90b6cc74748c9c26a99420eda251d6a7ac16252668caec80c6795e00a2f65db5`，Cron 每五分钟。此哈希来自本轮线上只读查询；尚无独立的早期发布哈希记录，但已通过固定 Wrangler 4.141.0 的 GitHub Actions **从 main 逐字节复现线上 bundle 哈希**。

两个 Worker 的 Service Binding 都指向 `ai/production`。当前 Waffo 的 `WAFFO_ENVIRONMENT=test`，同时两个独立 Production 开关为 `true`，属于现有 Test/Production 分离设计，不可简化为全局 Production 模式。

## 2. 本地执行

使用专用的 **Cloudflare 只读 API Token**。需要读取 Workers 脚本、配置、部署与 Cron 信息的权限；不要授予发布、编辑、删除或 D1 写入权限。

在自己的受信任终端安全设置 `CLOUDFLARE_ACCOUNT_ID` 和 `CLOUDFLARE_API_TOKEN` 环境变量。不要把 Token 写进 GitHub、日志、命令行参数、截图或聊天。

在仓库根目录运行：

```bash
node scripts/reliability/payment-release-preflight.mjs
```

脚本只使用 Cloudflare Workers GET：`/settings`、`/schedules`、`/deployments` 及脚本内容读取。脚本内容仅在内存计算 SHA-256，不存盘、不输出原始内容或凭据。

如果任何指纹、版本、Cron、绑定、Service Binding、资源或模式开关漂移，则退出码为 2，打印字段级阻断原因。权限不足、响应错误、解析失败或分流部署也会阻断。

## 3. 验证

无需真实账号或 Token 的测试：

```bash
node --test scripts/reliability/payment-release-preflight.test.mjs
```

GitHub Actions 的 Payment Cron Heartbeat CI 同时运行 Mock 与仓库完整测试，**不在 CI 提供任何 Cloudflare 生产凭据**。

已验证：通过已连接 Cloudflare 的只读接口取得两个生产 bundle SHA-256，并读取部署、Cron、绑定元数据和非敏感模式开关；Mock 测试覆盖 GET-only、脱敏、版本/哈希/配置漂移阻断。

**离线构建复现已通过**：GitHub Actions Run #41582733442 使用 Wrangler 4.141.0 从 `main` 构建的两套 Worker SHA-256 均与线上打包脚本完全一致，候选版本也编译成功、与旧版指纹不同。细节见 `docs/reliability/payment-bundle-reproduction-2026-11-03.md`。尚未用单独建立的本地只读 Token 完整执行生产版本检查 CLI，因此这仍不能作为端到端上线验收。

## 4. 发布前阻断条件

1. 当前 `main` 与线上 bundle 已由固定 Wrangler 4.141.0 逐字节复现；后续若工具链/源码变化，需重做指纹验证，不能直接沿用旧 SHA。
2. 将已审核生产基线与新候选源码区分验证，不因旧哈希吻合而跳过候选测试。
3. 隔离环境验证支付 Cron 心跳、D1 账本、Supabase RPC 兼容与回滚，禁止真实支付写入。
4. 任何生产发布和回滚必须单独取得明确授权。
5. 发布后人工复核新版本、绑定、Cron、日志和业务失败率。仅在证据充分后单独更新基线，不让脚本自动学习或覆盖。

相关候选：[PR #34](https://github.com/ikun-1145/xixi/pull/34)（Cron 业务心跳）、[PR #33](https://github.com/ikun-1145/xixi/pull/33)（只读指标）。两个 PR 仍应保持 Draft，直至验收与授权完成。
