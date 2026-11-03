# Waffo Cloudflare 独立预发布部署记录（2026-11-03）

> **范围仅限 Cloudflare 非公开的测试资源。正式 Waffo、爱发电、AI Worker 与现有支付 D1、Supabase、真实订单、Pro 会员均未修改。**

## 授权与来源

- 用户在本轮明确授权“创建和预发布”。按照先前约定仅创建两个非公开 Worker 和一个全新 D1；**没有创建第三个公网测试网关，也没有创建 Cloudflare Access 应用或策略**。
- 源代码来自 Draft [PR #35](https://github.com/ikun-1145/xixi/pull/35) 对应的已通过 CI 的提交 `e670f7ba43c1089ac1268d72bf1364fd65c1b45b`。未合并任何 PR，没有对生产执行 Wrangler deploy。
- 初始部署使用 Cloudflare API 的私有版本上传与百分比部署。Worker 模块文件直接从该提交上传（Cloudflare API 多模块格式）；**不是直接运行此前 Wrangler 的本地合成 bundle**。多模块上传和部署成功不等于真实云端业务 E2E 已通过。

## 新建资源

| 资源 | Cloudflare 名称 | 唯一标识 / 已部署版本 |
|---|---|---|
| 独立 D1 | `waffopay-preprod-ledger-isolated` | `021ab001-a309-40cf-afe0-43fceacc215a` |
| 私有合成 Provider/RPC Mock Worker | `waffopay-preprod-mock` | Version `39fd33fd-173c-481d-ba99-03740c1a5574` |
| 私有预发布 Waffo 入口 Worker | `waffopay-preprod-isolated` | Version `26863803-021d-46bd-b3d5-49c15abbfe90` |

D1 创建时选择亚太主区域提示，关闭读副本。按照仓库 `workers/waffopay/production-backend/schema.sql` 和 `outbox.sql` 建立三张表及待处理队列索引：
`payment_intents`、`event_ledger`、`production_outbox`。

仅插入一个**纯合成**的测试付款意图：
`payment_reference = 11111111-1111-4111-8111-111111111111`、
`store_id = STO_PREPROD1`、
`product_id = PROD_PREPROD1`、
`user_id = synthetic-preprod-user`。
初始化后 event ledger 为 **0 行**，outbox 为 **0 行**。没有真实付款或退款。

## 隔离与实际部署后核验

针对两个 Worker 的生产云端设置做了独立**只读**检查，均满足：

- `workers.dev` **关闭**、Preview/Version URLs **关闭**。
- 无自动 Cron，两个部署版本均 **100%**，兼容日期 `2026-09-05`。
- 账号 **5 个 Worker Custom Domains**、**1 个 Zone 的 2 条 Worker Routes** 均核对，**0 条指向**两个新的预发布 Worker。
- Mock Worker 绑定 **0** 项，无法读取现有 Cloudflare/Supabase 资源。
- 入口 Worker **15** 项绑定，与计划完全吻合：7 个非敏感隔离标志、5 个独立测试凭据/测试公钥（均为 `secret_text`，不在本文记录其值）、1 个全新 D1 和 2 个指向 `waffopay-preprod-mock` 的 Service Binding。
- `WAFFO_PREPROD_ISOLATED=true`、`WAFFO_PRODUCTION_ENTITLEMENT_ENABLED=false`。没有 `WAFFO_IDENTITY_SERVICE`、生产服务端密钥、生产支付私钥或指向现有 AI Worker 的 Service Binding。
- 新的 RSA 测试密钥与测试令牌**在 Cloudflare 隔离执行中随机生成并直接绑定**；未输出到聊天、文档或 GitHub。未来若要从受控网关调用，必须单独、安全地轮换和配置匹配的测试令牌。
- 当前 Cloudflare D1 数量从 1 增至 2，Worker 数量从 12 增至 14。生产 Waffo 的 Worker 版本仍为 `b414b89b-2218-47c6-bb7a-b85513af9125`，爱发电仍为 `a84fa755-4a9e-456a-94eb-8746c7f11d1b`。

**核验结果：PASS（资源隔离、配置和部署证据）。**

## 尚未通过的实际云端业务验收

- 两个预发布 Worker 故意不暴露任何公网 Route、Preview URL 或 workers.dev，因而现在不能直接从外部访问它们的 `/__preprod/health`、Webhook、手动 Cron。
- 本地 Miniflare/workerd **7/7** 端到端测试已通过，但**尚未实际在 Cloudflare 边缘上触发这两个 Worker 的业务调用**；不能宣称完成了云端支付业务端到端验收。
- 第三个 Cloudflare Access 保护的**临时测试网关**尚未获准创建，也没有部署、没有公开域名、没有 Cloudflare Access 应用/策略。该操作需独立审批。
- 生产支付/会员权益上线继续 **NO-GO**。PR #32、#33、#34、#35 维持 Draft、不合并。部署到新测试资源不等于批准现有支付 Worker 发布。

## 下一步

申请单独批准：第三个临时受 Cloudflare Access 保护的测试网关及其访问策略；先验证 Access 鉴权确实生效，再仅通过内网 Service Binding 对预发布 Worker 发起合成回调与 Cron 测试。测试结束后单独批准撤销网关/访问策略和轮换测试令牌。非生产 D1/Worker 不应在未经授权时自动删除。


## 预发布调用链后续验收（2026-11-03）

在不增加 Cloudflare 公网入口、不使用生产支付或会员凭据的前提下，候选分支进一步把临时 Access 网关逻辑接入**两个真实 workerd Worker、内部 Service Binding 与临时 D1**，从过去的 7 条扩展到 **11 条**本地组合端到端回归。

- 使用模拟的 Cloudflare Access 认证上下文进入网关，经过私有 Waffo 入口 Worker、内部 Waffo Provider Mock、RPC Mock，最终写入隔离 D1；有效签名通过，不重复记录。
- 缺少 Access 上下文、错误 audience 或伪造请求头时拒绝；健康检查只返回安全字段；手动 Cron 要求第二次显式开启；不允许任意路由和查询参数。
- **本地真实 Worker 出站网络调用次数为 0**，所有内部 RPC 和付款证明仍是模拟数据。
- GitHub Actions **Payment Preproduction Isolation Gate #41632063907：PASS**，本地组合 E2E **11/11**，全仓库 **826 项中 825 通过、0 失败、1 跳过**；独立可重复构建审计 **#41632063955：PASS**。
- 同日再次通过 Cloudflare 的只读接口核对两套部署版本均保持不变、两个 Worker 无 workers.dev / Preview URL / Cron，预发布入口只绑定隔离 D1 和两个 Mock Service Binding。现有 `ai`、`waffopay`、`afdianpay` 生产版本均未在本轮改变。

**严禁将这 11 项测试写成已在 Cloudflare 云端成功执行的 Access→Gateway→Worker E2E**：Access 上下文是本地模拟；私有云端 Worker 尚未获得单独审批的第三个 Access 测试网关。生产上线仍为 NO-GO。
