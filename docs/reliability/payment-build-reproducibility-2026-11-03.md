# 支付 Worker 离线可重复构建审计（2026-11-03）

> 本文仅记录 GitHub Actions 里的**无生产凭据、无部署**构建。通过哈希核对不等于批准真实支付 Worker 上线。

## 验证方式

GitHub Draft PR #34 新增独立 CI：`.github/workflows/payment-worker-build-repro.yml`。该流程：

1. 从 Pull Request 事件的精确 base SHA 检出未改动的 `main`，避免随运行时间变化的浮动基线。
2. 使用历史发布记录 `docs/full-stack-development/requirements/afdian-worker-resource-fix/06-verification/evidence/fencing-fix-20261013/dry-run.log` 指明的 Wrangler **4.103.0**，分别对 `afdianpay` 与 `waffopay` 运行 `deploy --dry-run --outdir`。
3. 另在候选 PR 源码上分别编译**两次**，核对两次候选输出 SHA-256 完全一致。
4. 将基线 dry-run bundle SHA-256 与当日通过 Cloudflare 只读 API 核实的生产哈希逐项比较。
5. 验证候选 bundle 与基线有差异，且包含当前预期的心跳事件名：`reconciliation_cycle_outcome`、`waffo_production_outbox_cycle`。
6. CI 不提供 `CLOUDFLARE_API_TOKEN`，禁用 Wrangler 遥测，编译输出不上传、不保留到 GitHub artifacts。

## 已确认结果

- GitHub Actions Run **41587646517**：编译和离线 SHA 门禁最终全部成功。
- Afdian 生产/基线 SHA-256：`a512bdccaaa3168f3ed56a3009e2a317f8651160930315bed1c2b1850503ec4a`。
- Waffo 生产/基线 SHA-256：`90b6cc74748c9c26a99420eda251d6a7ac16252668caec80c6795e00a2f65db5`。
- Afdian 候选 SHA-256：`28f9da0cd0183ca5ce4b5d29159f806048b4dc29a0ce164515a2c4abca267214`。
- Waffo 候选 SHA-256：`7050ce2432c6beae4a3a4fb2c7333198fac188a5257535376fabadd53e724b40`。
- 两套候选连续两次构建均字节相同，且不同于原生产；未写入生产。
- 同一 PR 的另一 CI 以 Wrangler **4.141.0** 独立完成生产哈希复现与 Node 模块冒烟测试。GitHub Actions Run **41587646552** 两个 job 全部成功。

## 含义与限制

- 现在可确认：在两个已测试的 Wrangler 版本下，旧生产 Worker 均可从仓库基线重建出**完全一致的 JS bundle**。Waffo 之前缺失的独立构建证据已补齐。
- 候选两次构建一致，说明当前固定工具链和源码在 CI 环境中产物稳定；不证明任意 Wrangler 版本、系统架构或未来日期仍保持哈希一致。
- Node 中直接导入编译好的 Worker 验证了未知路由返回 404 和 Waffo 未配置 Cron 进入 disabled 分支，但**不是原生 workerd 行为验收**。
- 仍需在隔离 workerd/Miniflare 环境验证支付 Cron、D1 的 Mock 数据、Supabase RPC 失败/幂等与 Waffo 授权路径，以及人工可执行的恢复方案。上线或回滚均需要独立批准。
- 线上指纹来自只读 Cloudflare API，CI 不下载或上传线上脚本。

## 安全限制

禁止将真实订单、用户隐私、Cloudflare Secret、Supabase service_role、真实 Waffo 私钥或爱发电 Token 注入 CI。**禁止把 `--dry-run` 改成真正 `wrangler deploy`**。正式生产发布必须使用单独、人工授权的工作流。
