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

## 只读云端资源核对（新增）

在申请创建任何预发布资源之前，先运行新脚本 `scripts/reliability/cloud-preprod-isolation-preflight.mjs`。它**只调用 GET**：Worker 列表、D1 数据库列表、已有 `waffopay`/`afdianpay`/`ai` 的非敏感绑定元数据；不读取密钥值、脚本内容、订单或用户数据，也没有创建、写入或删除操作。

在**受信任的本机终端**设置两项环境变量 `CLOUDFLARE_ACCOUNT_ID`、专用**只读** `CLOUDFLARE_API_TOKEN`，之后在仓库根目录运行：

```bash
node scripts/reliability/cloud-preprod-isolation-preflight.mjs before-create
```

当前只读现场记录：Cloudflare 存在 **12 个 Worker、1 个 D1**；未发现名为 `waffopay-preprod-isolated`、`waffopay-preprod-mock` 的 Worker 或 `waffopay-preprod-ledger-isolated` 的 D1；生产 Waffo D1 保持审核过的 **`9003f99a-bcef-4ba5-a961-33c399a01ab5`**，其身份 Service Binding 仍指向 `ai/production`。若名称冲突、资源清单不完整、生产 D1 UUID 或服务绑定发生漂移，必须返回阻断。

**仅在另行批准创建新的独立 D1 之后**，将新数据库 UUID 安全地设置为 `WAFFO_PREPROD_D1_ID`，运行第二道门禁：

```bash
node scripts/reliability/cloud-preprod-isolation-preflight.mjs after-d1-create
```

这会校验新 D1 的**名字和 UUID 均匹配**，且不与任何生产 Worker 当前绑定的 D1 重合。只有第二道门禁通过，才允许生成 Wrangler 配置并进入另一项单独审批的云端部署。**不要把旧 D1 ID 或生产 API Token 放到仓库、CI、终端命令行参数或聊天中。**

GitHub Actions 新增 `tests/payment-cloud-preprod-preflight.test.mjs`，使用模拟 Cloudflare API 响应覆盖只读 GET、分页、权限不足、重名、D1 复用、生产绑定精确 ID 漂移等情况。**该模拟测试不等于已经在本机使用独立 Token 端到端运行 CLI**。本轮通过 Cloudflare 连接器只读复核了现场元数据，但没有在云端创建任何资源。

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


## 新增密钥完整性与真实双 Worker 验收

进一步核对发现：仅有隔离健康检查和成功编译，并不能证明 `handleProductionWebhook` 会接受合法合成回调。它还要求两份不同的 Webhook 公钥及独立的 RSA 签名私钥。已在预发布入口增加**启动时拒绝**条件：

- `WAFFO_PREPROD_SIGNING_KEY`：仅预发布使用、单独生成的 PKCS8 RSA 测试私钥，不读取 `WAFFO_PRIVATE_KEY_PRODUCTION`。
- `WAFFO_WEBHOOK_PUBLIC_KEY_PROD`：在这个隔离 Worker 中只用于识别**合成的 prod-mode 测试 Webhook**，必须与下面公钥不同，不能复用线上 Waffo 公钥。
- `WAFFO_WEBHOOK_PUBLIC_KEY_TEST`：另一把单独生成的 RSA 测试公钥，避免两套环境公钥混用。
- `WAFFO_PREPROD_RPC_TEST_KEY`：仅模拟 RPC 接受的测试凭据，强制 `waffo-preprod-` 前缀与最小长度；不接收线上 Supabase service_role。
- `WAFFO_PREPROD_GATE_TOKEN`：额外的内部测试入口令牌，必须独立生成且至少 32 字符；仅用于私有 Service Binding 的人工测试入口。

**以上秘密均不加入配置仓库或 GitHub Actions Secrets。** 本地 CI 每次随机生成 RSA 密钥；未来创建云端预发布时必须在受信任设备上生成独立测试密钥并以专用预发布绑定注入，且与线上密钥核对不相同。

新增 `scripts/reliability/payment-preprod-workerd-e2e.mjs`：直接读取 Wrangler 编译的两个候选 Worker 模块，使用固定 Miniflare 5.20261101.0-beta，在同一个真实 `workerd` 中连接两条独立 Service Binding 和临时 D1；拦截所有其他出站网络请求。已实际通过 **7/7** 场景：

1. 未提供测试令牌时拒绝访问，并且 D1 不被修改。
2. 正确测试令牌返回隔离模式健康信息，自动 Cron 与会员发放均关闭。
3. 无效 RSA 签名在写入 D1 之前被拒绝。
4. 有效合成回调完成 Webhook 验签、两次内部 Service Binding 调用及本地 D1 写入，权益字段保持禁用。
5. 重放相同的合成付款不会新增 D1 事件或出站记录。
6. 手动 Cron 报告空待处理队列正常，并且不使用生产网络。
7. 生产 checkout、身份验证和正式 Webhook 路由保持不可访问。

**实测 CI Run #41613637366：** 隔离单元测试 **8/8**，全仓库 **806 项中 805 通过、0 失败、1 跳过**，双 Worker 端到端 **7/7**，非模拟外部网络访问 **0 次**。独立复现构建 CI Run **#41613637335** 同样 PASS。

以上均发生在**本地临时运行时**，还没有创建真正的 Cloudflare 云端预发布 Worker/D1、绑定云端资源、注入密钥或部署。下一道门禁仍是单独批准云端非生产资源创建和隔离联调。

## 本轮 CI 实测结果

- Preproduction Isolation Gate Run **41598668646**：8/8 条隔离/合成签名/Service Binding 测试通过；完整仓库 806 项，805 通过、0 失败、1 跳过；两份带模拟独立 D1 UUID 的配置都成功通过 Wrangler 4.141.0 `deploy --dry-run`。
- Reproducible Build Audit Run **41598669011**：按已审核 `main` 源码而非 PR #34 候选作为生产基线，生产 bundle SHA 复现与新候选两次一致性验证通过。GitHub 堆叠 PR 的 base ref 不能被当作已审核生产快照。
- CI 没有 Cloudflare API Token，测试环境的 D1 ID 仅为虚构 UUID；没有在 Cloudflare 创建资源、真正部署、注入密钥或调用 Waffo/Supabase 生产端点。
