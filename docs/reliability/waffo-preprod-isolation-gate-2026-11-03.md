# Waffo 云端预发布隔离门禁（Draft，尚未部署）

本次变更是 **PR #34 的堆叠式候选分支**。目标是让后续创建 Waffo 预发布环境时，不能无意中调用真实支付接口或现有 Supabase 权益 RPC。**截至 2026-11-03，尚未创建任何新 Cloudflare D1、Worker、路由、Cron 或密钥。**

## 已确认的风险

线上 `waffopay` 仍使用生产 D1 `9003f99a-bcef-4ba5-a961-33c399a01ab5`，以及正式域名、生产 Worker Service Binding 和 Cron。现有 `production-rpc.js`、`payment-proof.js` 内的生产 API 地址曾是硬编码的。将原始 `wrangler.toml` 复制一份并更名**不构成安全的预发布环境**。

## 本 PR 的隔离机制

- `workers/waffopay/preprod-transport.js`：只有当 `WAFFO_PREPROD_ISOLATED=true` 时，将付款证明查询转为 `WAFFO_PREPROD_PROVIDER`，将权益 RPC 转为 `WAFFO_PREPROD_RPC` Service Binding。目标域名只允许 `.invalid`；绑定缺失时抛错，**不会回退到真实网络请求**。
- `payment-proof.js` 的隔离模式只读取 `WAFFO_PREPROD_SIGNING_KEY`，不读取 `WAFFO_PRIVATE_KEY_PRODUCTION`。
- `production-rpc.js` 的隔离模式只读取 `WAFFO_PREPROD_RPC_TEST_KEY`，不读取现有生产 service_role。未进入隔离模式时依然走原来的生产代码路径。
- 独立入口 `preprod-worker.js`：只开放内部的 `/__preprod/health`、`/__preprod/webhook`、`/__preprod/cron` 三个受专用测试令牌保护的接口。不会暴露购物结算、真实身份认证或公网 Webhook 路由，也不注册自动 Scheduled handler。
- `preprodReady()` 拒绝生产密钥、生产身份 Service Binding、Production entitlement 开关和非合成 `MER_/STO_/PROD_` 标识。
- 独立 `preprod-mock.js` 在本 Worker 内返回固定合成付款证明与**不授予权益**的 RPC 响应，拒绝未知 URL。不通过网络代理转发请求。
- `render-payment-preprod.mjs`：必须先获取**全新**的独立 D1 UUID（与生产 UUID 不同）才可生成 Wrangler 配置。生成物没有 route、workers.dev、Cron、真实密钥或生产 Service Binding；只写入 Git 忽略的 `.preprod-generated/`，不负责创建云端资源或部署。
- CI 使用假 D1 UUID 验证以上约束，并只调用 `wrangler deploy --dry-run`，**不提供 Cloudflare Token**。

## 环境边界

| 类别 | 预发布允许 | 必须阻断 |
|---|---|---|
| Worker | `waffopay-preprod-isolated` | 生产 `waffopay` |
| Mock | `waffopay-preprod-mock` | 生产 `ai` 及真实支付 API |
| 数据库 | 全新 `waffopay-preprod-ledger-isolated` | 现有 D1 ID、线上 Supabase |
| 授权 | 专用模拟测试 Token / 合成签名密钥 | 任何生产 Waffo 私钥、Supabase service_role |
| 访问 | 仅内部 Service Binding | 公网 route / workers.dev |
| 运行 | 人工触发测试 | 自动 Cron、真实支付交易 |
| 权益 | `WAFFO_PRODUCTION_ENTITLEMENT_ENABLED=false` | 真实 Pro 授予、真实退款 |

## 未来创建独立环境之前的步骤

1. 先审核并通过候选分支 CI。验证 `preprod-worker.js` 和 `preprod-mock.js` 都能离线构建。
2. 单独批准在 Cloudflare 账号中**创建新的** D1 与两个非公开 Worker。此批准**不包括**对已有 Worker、正式自定义域名或现有数据库进行修改。
3. 在受信任终端设置 `CLOUDFLARE_ACCOUNT_ID` 与新 D1 ID `WAFFO_PREPROD_D1_ID`，执行：
   `node scripts/reliability/render-payment-preprod.mjs .preprod-generated`。
4. 人工复核生成的两个配置文件，确认 Service Binding 均指向新建的 `waffopay-preprod-mock`，D1 UUID 与生产不同，`workers_dev=false` 且完全没有路由和 Cron。
5. 仅向预发布 Worker 注入**另外生成**的合成 RSA 签名密钥、公钥（两环境不同）和测试令牌；生产私钥、JWT、service_role 不可复制。
6. 在独立 D1 上运行仓库的 `schema.sql`、`outbox.sql`；只插入合成付款意图与回调。
7. 独立审批 Cloudflare 云端**仅预发布**部署；先部署 Mock，再部署入口 Worker。之后通过内部专用调用者 Service Binding 触发人工测试，验证失败不回退到生产，并对比资源 ID。
8. 预发布所有证据合格后，再提交独立的**生产部署审批**。禁止将本 PR 合并等同于授权生产部署。

## 局限和剩余阻断

这些安全入口仅证明 `preprod` 可安全配置、生成和离线构建；**尚未进行真实 Cloudflare 云端联调**。Service Binding 的云端目标、真实部署权限和沙箱运行时仍需要独立验收。模拟 RPC 没有持久化权益数据库，因此不能用这套 Mock 证明跨数据库事务；正式权益事务已经在 PR #34 的 PGlite 单独测试。禁止把这些不同层级的测试混为一谈。


## 本轮 CI 实测结果

- Preproduction Isolation Gate Run **41598668646**：8/8 条隔离/合成签名/Service Binding 测试通过；完整仓库 806 项，805 通过、0 失败、1 跳过；两份带模拟独立 D1 UUID 的配置都成功通过 Wrangler 4.141.0 `deploy --dry-run`。
- Reproducible Build Audit Run **41598669011**：按已审核 `main` 源码而非 PR #34 候选作为生产基线，生产 bundle SHA 复现与新候选两次一致性验证通过。GitHub 堆叠 PR 的 base ref 不能被当作已审核生产快照。
- CI 没有 Cloudflare API Token，测试环境的 D1 ID 仅为虚构 UUID；没有在 Cloudflare 创建资源、真正部署、注入密钥或调用 Waffo/Supabase 生产端点。
