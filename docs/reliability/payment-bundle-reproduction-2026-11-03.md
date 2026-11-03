# 支付 Worker 双版本离线构建复现：2026-11-03

> 状态：**构建指纹通过，隔离运行时与端到端支付验收未完成**。本文只是可复核的 CI 证据，不是生产部署授权。

## 固定构建环境

- GitHub Actions PR #34，Run `41582733442`，作业 `bundle-dry-run`。
- Node.js 22；显式使用 `wrangler@4.141.0`。
- 无 Cloudflare API Token、无生产 Secrets。只执行 `wrangler deploy --dry-run --outdir`，不上传、部署或更新 Cron/绑定。
- 同一 Runner 先从 `origin/main` 生成基线构建，再从 PR 候选 HEAD 生成构建，均做 JS 语法检查。
- 构建产物只在 Runner 临时目录保存。校验脚本只打印 SHA-256 和白名单事件标记，不公开打包源码。

## 实际结果

| Worker | main bundle SHA-256（重建） | 本次线上 Cloudflare SHA-256 | PR #34 候选 bundle SHA-256 |
|---|---|---|---|
| afdianpay | `a512bdccaaa3168f3ed56a3009e2a317f8651160930315bed1c2b1850503ec4a` | 完全一致 | `28f9da0cd0183ca5ce4b5d29159f806048b4dc29a0ce164515a2c4abca267214` |
| waffopay | `90b6cc74748c9c26a99420eda251d6a7ac16252668caec80c6795e00a2f65db5` | 完全一致 | `7050ce2432c6beae4a3a4fb2c7333198fac188a5257535376fabadd53e724b40` |

校验结果：两个 Worker 均 `baseline_main_reproduces_live=true`、`candidate_differs=true`、`candidate_heartbeat_present=true`。新增哈希门禁单元测试 **5/5 通过**；同一次 CI 仓库完整测试 **798 项，797 通过、0 失败、1 跳过**。

因此现有 `main` 代码已在这套环境里逐字节复现两个线上打包产物，解决了此前缺少独立 Waffo 构建复核的问题。未发现独立历史 Waffo 发布哈希记录这一事实不变，但现在已有**独立的当前构建复现证据**。

## 不能据此放行的事项

1. 构建指纹只证明打包代码的对应关系。它不验证上线时 Secret **值**、D1 数据、KV 状态或真实 Supabase 权益事务。
2. 新候选与原版本指纹不同是预期现象；必须另外审查源码差异、业务调用时序和幂等特性。
3. 仍需在不含真实订单/凭据的独立运行时检查候选 Worker 的 HTTP 与 Scheduled 路径、D1 失败/成功边界和支付错误日志。
4. 任何合并、版本上传、正式部署、回滚或真实订单验证都要经项目负责人单独授权。
5. 若基线版本、Wrangler 版本或任何公共构建文件发生变化，不能静默更新预期 SHA-256；必须解释差异并重新取得审核。

验证脚本：`scripts/reliability/verify-payment-bundle-build.mjs` 与同名 `.test.mjs`；流程：`.github/workflows/payment-cron-heartbeat-ci.yml`。
