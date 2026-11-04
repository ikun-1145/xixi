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

## 部署版本与来源指纹锁定（2026-11-03）

已将 `scripts/reliability/cloud-preprod-postdeploy-audit.mjs` 从“仅验证单版本 100%”收紧为同时验证 **实际已部署的 Worker Version ID** 及版本元数据 `workers/commit_sha`。使用 Cloudflare 的只读 `GET /versions/{version_id}` 拉取**正在部署的版本**，而不是只看最新上传版本；若出现版本切换、改密钥触发新的版本或来源提交不一致，将返回 **BLOCKED**，等待重新审查并更新审核基线。

- 私有预发布入口：Version `26863803-021d-46bd-b3d5-49c15abbfe90`。
- 内部支付模拟 Mock：Version `39fd33fd-173c-481d-ba99-03740c1a5574`。
- 两者当时审核的源提交：`e670f7ba43c1089ac1268d72bf1364fd65c1b45b`。
- **刚刚经 Cloudflare 只读核验**：2/2 版本 ID 和提交元数据匹配；workers.dev、Preview URL 全关闭，Cron 均为 0；正式 `ai`、`waffopay`、`afdianpay` 均未通过本任务部署。
- CI **#41633191662 PASS**，完整仓库 **827 项，826 通过、0 失败、1 跳过**；本地真实双 Worker + Access 网关模拟 **11/11**；独立可重复构建 **#41633191638 PASS**。

> 版本指纹锁定是**代码来源与部署变更审计**，不是证明 Cloudflare 云端已实际执行签名 Webhook。两个私有 Worker 目前仍无被授权的云端测试入口。第三个 Cloudflare Access 网关和访问策略需另行明确批准；生产上线仍为 NO-GO。


## 2026-11-04 只读复核与 Access 未启用阻塞

本节仅记录通过 Cloudflare / GitHub 已连接账户完成的**只读**核验；没有运行 webhook、手动 Cron、D1 写入、部署、Secret 轮换、Access 开通或任何生产修改。

- **部署版本未漂移**：`waffopay-preprod-isolated` 的当前 100% Version ID 是 `26863803-021d-46bd-b3d5-49c15abbfe90`，`waffopay-preprod-mock` 是 `39fd33fd-173c-481d-ba99-03740c1a5574`；两者实际部署版本的 `workers/commit_sha` 注解均为 `e670f7ba43c1089ac1268d72bf1364fd65c1b45b`。注解与登记来源匹配属于部署元数据核对，**不是独立的构建字节级证明**。
- **隔离配置仍保持**：两个 Worker 的 `workers.dev` 和 Preview/Version URL 均禁用，自动 Cron 为 0；入口的 D1 仍为 `waffopay-preprod-ledger-isolated`（`021ab001-a309-40cf-afe0-43fceacc215a`），两个 Service Binding 指向私有 `waffopay-preprod-mock`；`WAFFO_PRODUCTION_ENTITLEMENT_ENABLED=false`，Mock 无任何绑定。
- **公网路由清单仍隔离**：Cloudflare 账号 5 个 Worker Custom Domains 和 `sunland.dev` Zone 的 2 条 Worker Route 中，均无这两个预发布 Worker 的公开入口；不应把账户下其他 staging Worker 的域名误认为 Waffo 已获准暴露。
- **生产版本保持旧审核基线**：正式 `waffopay` 最新 100% 版本 `b414b89b-2218-47c6-bb7a-b85513af9125`；`afdianpay` 最新 100% 版本 `a84fa755-4a9e-456a-94eb-8746c7f11d1b`。本次没有发布这两个生产服务。
- **新识别的硬阻塞**：账号 `GET /accounts/{account_id}/access/apps` 返回 HTTP **403** 和 Cloudflare API 错误 `access.api.error.not_enabled`（“Access is not enabled”）。因此目前**不能声称 Access 保护的网关已经可配置或已完成云端身份校验**。不要将 403 误解释成已有 Access 策略通过。
- **候选 CI**：Draft PR #35 当前代码头 `99fd67656ca4f9c0b25dfff41e52f2ab00bd3f64` 的 Payment Preproduction Isolation Gate `#41633578777` 与 Payment Worker Reproducible Build Audit `#41633578816` 均已完成并成功。CI 仍是隔离本地/模拟证据，不是云端 Access E2E。

**结论：资源隔离与既有版本指纹只读复核 PASS；真实云端 Access→Gateway→内部 Waffo Worker 的业务 E2E 为 BLOCKED。** 后续必须由负责人另行明确授权启用 Cloudflare Access、创建临时受保护测试入口/策略和匹配测试凭据的安全轮换，并先以未认证请求验证拒绝策略，再运行任何合成业务调用。未经新授权，不创建第三 Worker、不公开现有 Worker、不操作生产；生产支付上线依然 **NO-GO**。


## 2026-11-04 Access 初始化与临时测试网关撤销记录

本轮收到用户对“启用 Cloudflare Access、创建临时测试 Worker 与受限访问策略、验证后撤销”的明确授权。操作严格针对**非生产**测试资源，未触碰真实订单、付款接口、正式 Worker、Supabase 或会员权益。

**已完成：**
- 通过 Cloudflare 组织 API 启用 Zero Trust / Access，创建 `Shuanglan AI Preproduction Access`；保留此组织供后续明确授权的安全测试使用，未配置全账号级 Worker 默认封锁，也未选择付费计划。
- 新建 Cloudflare 身份提供方 `Shuanglan Cloudflare Account`，`restrict_to_account_members=true`。未将任何用户邮箱或身份凭据写入仓库。
- 临时 Access 应用使用精确邮箱 Allow 规则，仅针对 `waffo-preprod-gw-20261104.sunland.dev`；并通过 GET 确认 audience、IDP 与 policy 已保存，未建立宽泛 Everyone Allow。
- 将当前 Draft PR 的 `preprod-gateway-proposal.js` 原样上传到临时 Worker `waffopay-preprod-gateway-20261104`，显式绑定 `WAFFO_PREPROD_GATEWAY_ENABLED=false`；确认 `workers.dev` 与 Preview 均关闭。该临时 Worker **未配置连接测试入口所需的 gate token、Service Binding、Access audience 或签名密钥**，因此不可执行支付测试。
- 仅在 Access 应用已创建、临时 Worker 默认关闭以后，才短暂绑定临时 Custom Domain；没有修改原有 Waffo 两个私有 Worker 的任何绑定、代码或密钥。

**未能完成的云端验证：**
- 当前连接器的普通 HTTP `fetch` 对该临时域名返回的是**执行环境本身**的 `403 Forbidden: requests to ... are not allowed`，且无 Cloudflare `cf-ray`；外部网页读取也不可访问。因而无法取得来自 Cloudflare Access 边缘的真实“未登录阻断”响应，不能将这一 403 认定为 Cloudflare Access 保护生效。
- 基于 fail-closed 门禁，没有启用 Gateway，没有从云端触发合成 Webhook、Cron、签名支付、RPC 或 D1 写入。**真实 Cloudflare Access→Gateway→私有 Waffo Worker E2E 仍是 BLOCKED / NOT VERIFIED。**
- 从未向临时网关注入或读取真实/测试 gate token，也没有更改原有两个私有 Worker 的任何 Secret，因此**没有需要撤销的新测试凭据；没有轮换原有凭据**。此事项并非“已完成密钥轮换”。

**撤销完成并 GET 核验：**
- 删除临时 Custom Domain，自动创建的 DNS 记录已不存在。
- 删除临时 Worker，以及这次创建的临时 Access 应用和应用内 Allow 策略。
- 查询确认临时 Worker **不存在**、临时 Access 应用 **不存在**、临时域名 **不存在**、临时 DNS 记录 **0 条**；账号恢复为 **14 个 Workers、5 个 Custom Domains、2 个 D1**，其中原独立预发布 D1 与正式 D1 均仍存在。
- **仅保留已获授权启用的 Zero Trust / Access 组织与限定账号成员的 Cloudflare 登录身份提供方**，未删除原预发布 Worker/D1。

**结论：Access 初始化 PASS，临时资源清理 PASS；真实运行时 Access 拦截验证与云端支付 E2E 均 NOT VERIFIED。** 后续如要重新执行，需要能够向 Cloudflare Access 保护的真实 HTTPS 地址发起请求、并完成受限身份认证的测试执行环境；必须再次核对 Access 边缘 401/403/登录重定向后，才能配置新测试密钥并启用合成支付调用。当前不可据此申请生产发布，**正式支付继续 NO-GO**。
