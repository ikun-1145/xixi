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


## 2026-11-04 Browser Run 实际 Access 未授权拦截验收

本节为上一条“普通连接器 HTTP fetch 无法访问测试域名”的后续补充。**在同一天改用 Cloudflare Browser Run REST `POST /accounts/{account_id}/browser-rendering/content` 取得了真实边缘返回的 Cloudflare Access 登录页，因此之前的“无法确认实际未登录拦截”限制已被本节的两项负向测试所解决。** 但**正向登录/服务身份与支付业务 E2E 仍未完成**。

### 测试环境、约束与证据

- 原账号上 `Shuanglan AI Preproduction Access` 和限制 Cloudflare 账号成员身份提供方持续存在；再次临时创建仅允许预先核对的账户邮箱的 Access 应用，未设置 Everyone、域名通配 Allow 或全账号保护。
- 从 Draft PR #35 上传原样 `preprod-gateway-proposal.js` 至临时 `waffopay-preprod-gateway-20261104`；只有 `WAFFO_PREPROD_GATEWAY_ENABLED=false` 一项绑定。**没有**部署启用态、没有内部私有 Waffo Service Binding、没有注入 Waffo gate token、签名私钥或生产密钥。
- 显式禁用临时 Worker 的 `workers.dev` 和 Preview URL，然后才绑定 `waffo-preprod-gw-20261104.sunland.dev` 这一唯一临时 Custom Domain；正式 Worker 与原两个私有 Waffo Worker 的版本及配置未修改。
- Cloudflare Browser Run 先以不相关公开站点验证 API 可用，再向临时 URL 的 `GET /__preprod/health` 发起**未携带任何身份凭据**的访问。实际返回 HTML 标题为 `Sign in ・ Cloudflare Access`，而不是网关已关闭时会输出的 `gateway_disabled`。
- 重新向同一路径发送**无效且非敏感**的伪造 `Cf-Access-Jwt-Assertion` 和 `Cf-Access-Authenticated-User-Email` 请求头；仍得到相同 Cloudflare Access 登录页面，未进入网关业务逻辑。两次输出只记录判定结果，未保存 HTML、任何身份令牌或用户会话。
- 两项负向测试分别证实实际 Access 身份墙在边缘执行、伪造客户端身份头没有绕过。**Browser Run 返回的是最终渲染后的 HTML，不是原始 HTTP status code 证据**；不得声称已独立核实确切 401/403 或正向身份授权成功。

### 尚未通过的测试

- 正向机器身份凭据创建和自动调用尝试被当前执行环境的安全控制阻止，**没有绕过限制**；随后只读清单确认没有新增匹配的临时 Service Token。
- 未运行通过 Cloudflare Access 的**已认证** Gateway 调用；未启用临时 Gateway 的业务开关；未连接原本私有的两个 Waffo Worker；未触发任何签名 Webhook、Cron、Provider/RPC 或 D1 写入。因此真实云端 Access→Gateway→Waffo 付款 E2E 仍然 **BLOCKED / NOT VERIFIED**。
- 原有 11/11 本地 workerd 测试和全仓库 CI 仍是隔离离线证据，不能替代上面的云端正向 E2E。

### 撤销完成与只读复核

- 已删除临时 Worker Custom Domain、临时 Worker 和 Access App（其临时 Allow 策略随之撤销）；GET 确认临时 Worker、Access App、DNS 记录、Custom Domain 和新建的 Service Token 皆为 **0 残留**。
- 清理后账号资源重新核对为 **14 个 Worker、5 个 Worker Custom Domain、2 个 D1**；独立预发布 D1、原两个私有 Worker、账号 Access 组织和限制成员的身份提供方仍保留。
- 没有旋转或读取原两个私有 Worker 的现有测试 Secret，不存在本次生成而待轮换的支付凭据；正式付款、订单和权益未操作。

**结论：Cloudflare Access 未认证访问拦截、伪造身份头拒绝、临时资源清理：PASS。正向 Cloudflare Access 身份授权与真实云端合成支付业务 E2E：NOT VERIFIED。生产支付继续 NO-GO。** 若后续要完成正向验证，应在已授权的浏览器执行环境内完成真实 Access 登录，或由经过独立安全审批的机器身份测试方案处理，不得以未认证 URL、伪造 JWT 或开放原私有 Worker 来替代。


## 2026-11-04 真实用户 Access 登录成功与临时入口清理

在原用户明确授权的隔离预发布验收范围内，临时创建精确邮箱 Allow 的 Cloudflare Access 应用及 `waffopay-preprod-gateway-manual-20261104` Worker，并配置只供该应用使用的临时 One-time PIN 邮箱登录身份提供方。原 Cloudflare 账号身份提供方也保留作为另一项登录选项。

**Cloudflare Access 正向验收：PASS（仅身份链路）。** 用户在其自身浏览器完成 Cloudflare Access 邮箱登录后，访问 `GET https://waffo-preprod-manual-20261104.sunland.dev/__preprod/health`，实际页面返回 `{"ok":false,"reason":"gateway_disabled"}`。此响应来自此前已确认仅绑定 `WAFFO_PREPROD_GATEWAY_ENABLED=false` 的网关候选，故证明经 Access 身份校验后到达了 Worker 的安全关闭状态。**Cloudflare Access 认证日志 GET** 也显示应用 `Waffo manual Access login check 20261104` 在 `2026-11-04T04:19:01Z` 有 `action=login`、`allowed=true` 的记录；没有读取、收集或持久化用户邮件验证码、Cookie、Access JWT、Session Token 或密码。

- 已通过 Cloudflare Browser Run 验证未登录访问被重定向到 `Sign in ・ Cloudflare Access`，而非 Worker 业务；前轮的伪造身份请求头负向测试仍成立。
- 本轮用户首次使用 Cloudflare OAuth 登录遇到 `Authentication error, please login`；通过启用临时 OTP IdP 成功完成 Access 正向验证。该 OAuth 故障根因尚未定位，不能据此宣称已修复 Cloudflare 登录。
- **未**开启网关业务开关；临时网关**没有**配置任何 `WAFFO_PREPROD_TARGET` Service Binding、`WAFFO_PREPROD_GATE_TOKEN` 或签名材料；没有触发合成付款、Webhook、Cron、Provider Mock、RPC 或独立 D1 写入。所谓“正向登录通过”不等于“真实支付端到端通过”。

**测试结束即清理，云端复核 PASS：** 删除临时 Worker Custom Domain、临时 Gateway Worker、临时 Access 应用及其 Allow 策略、临时 OTP 身份提供方。再次通过 GET 核对这五类临时资源 / DNS 均为 0 残留，账号恢复 **14 个 Worker、5 个 Worker Custom Domain、2 个 D1**；只保留早前已授权建立的 `Shuanglan AI Preproduction Access` 组织和 `Shuanglan Cloudflare Account` 身份提供方。既有两个私有 Waffo Worker、独立 D1 和生产支付资源未变。

**后续门禁：** 真实云端 `Access → Gateway → Waffo isolated Worker → Provider/RPC Mock → D1` 正向合成 E2E 仍 **BLOCKED/NOT VERIFIED**。要继续需要单独设计安全的独立测试凭据发放/轮换、内网 Service Binding 和可控合成签名请求执行路径。严禁借此登录验收直接开启正式支付或扩大公开 Worker 攻击面；生产支付仍 **NO-GO**。


## 2026-11-04 隔离云端 Service Binding 健康检查待用户验收

**本节为进行中的非生产云端验收，不是 PASS。** 用户已在前一轮完成受保护的**旧临时网关**的真实 Access 登录（`allowed=true`）；旧资源已清理。本节是新的、通过内部 Service Binding 真正调用私有 Worker 的验证阶段。

- 先将草稿测试网关 `workers/waffopay/preprod-gateway-proposal.js` 增加显式独立开关 `WAFFO_PREPROD_ALLOW_WEBHOOK`，默认不是 `true` 时固定返回 `403 manual_webhook_disabled`，**不会调用私有 Service Binding**。增加对应否定测试，离线 workerd 合成验证中才明确传 `true`。Draft PR #35 此轮隔离 CI / 可重复构建 CI 均 PASS；未合并或部署任何正式支付 Worker。
- 临时 Access 应用 `Waffo isolated cloud-health E2E 20261104` 仅允许事先验证的账户邮箱（精确 Email Allow 规则），仅启用独立 OTP 身份提供方，应用固定域名 `waffo-preprod-e2e-20261104.sunland.dev`。
- 临时 `waffopay-preprod-e2e-gateway-20261104` 已按本 PR 候选代码部署，仅配置以下用途：`WAFFO_PREPROD_GATEWAY_ENABLED=true`、`WAFFO_PREPROD_ISOLATED=true`、`WAFFO_PREPROD_ENTITLEMENTS_ENABLED=false`、`WAFFO_PREPROD_ALLOW_WEBHOOK=false`、`WAFFO_PREPROD_ALLOW_CRON=false`、独立 Access Audience 和唯一内部 Service Binding `WAFFO_PREPROD_TARGET → waffopay-preprod-isolated`。不含生产密钥，不持有 D1、Provider 或 RPC 绑定，不开放 Cron。临时 Worker 的 `workers.dev`、Preview URL 均关闭。
- 在云端连接器内使用 `crypto.getRandomValues` 生成全新**随机、非生产、仅用于隔离测试的 96 位十六进制 Gate Token**，一次性写入 Gateway 与私有 `waffopay-preprod-isolated` 的 `secret_text` Binding；**没有输出明文或把密钥提交至 GitHub**。这一步**确实轮换了私有预发布 Worker 的既有 Gate Token**，而不是读取旧 Secret。其他 4 项测试 Secret、原有内部 Mock Service Bindings 与独立 D1 绑定未变。
- **版本漂移警告：**密钥轮换使 `waffopay-preprod-isolated` 当前 100% 部署版本变为 `eedf9bb3-0b18-44f4-a40e-18babc0ccef2`，其 Version 元数据没有 `workers/commit_sha` 注解；因此原严格 postdeploy audit 预期会返回 **BLOCKED**，此阶段**禁止声称原版本审核通过**。原已审核版本 `26863803-021d-46bd-b3d5-49c15abbfe90` 仍存在，元数据 `workers/commit_sha=e670f7ba43c1089ac1268d72bf1364fd65c1b45b` 已核验，**必须在阶段结束后将私有预发布 Worker 恢复到这一原版本并重新验收**。不要修改审核基线去掩盖临时漂移。
- Gateway 通过 Secret 上传后当前独立版本为 `0cf34866-7cbd-4916-aa0f-358f9d0d2b91`，完整保留 `WAFFO_PREPROD_ALLOW_WEBHOOK=false`、`WAFFO_PREPROD_ALLOW_CRON=false`，与唯一私有 Service Binding。
- 先检查 Access 应用/精确邮箱规则、OTP IDP、无 DNS 域名冲突，随后绑定临时 Custom Domain。Cloudflare Browser Run 对 `GET /__preprod/health` 的**未登录**调用实际返回 `Sign in ・ Cloudflare Access`，没有触达业务 Worker；正向登录和私有 Service Binding 真实健康检查**等待用户浏览器验收**。其他一项伪造头探测没有取得可判定结果，不能把这项计作本轮通过。
- 预发布 D1 的只读基线仍为 `payment_intents=1`、`event_ledger=0`、`production_outbox=0`，本轮没有执行签名 Webhook、Cron、RPC/Mock 调用或 D1 写入。**完整支付 E2E 尚未通过。**

### 待完成的清理门禁（不要遗漏）

1. 用户确认正向请求显示 `{"ok":true,"mode":"isolated","entitlements":false,"automaticCron":false}`，或者测试无法继续时，**先解除临时 Custom Domain**，再删除临时 Gateway Worker、Access 应用及其 Email Allow 策略、独立 OTP IDP。
2. 将 `waffopay-preprod-isolated` 的 100% 部署版本恢复到 `26863803-021d-46bd-b3d5-49c15abbfe90`；以 GET 核验实际部署版本、对应来源 commit 注解、所有原 Secret Binding 类型、Mock/D1 指向和 0 Cron。原 Worker `workers.dev`、Preview 仍关闭。
3. 重新执行 Cloudflare 只读审计，确认全部临时 Worker/Access App/域名/DNS/OTP 无残留，正式 Waffo、Afdian 及生产数据库未改变。**只有这三个收尾条件确认后才能把本阶段记为完成。** 未完成前不得合并 PR #35 或将任何支付路径上线。

**生产状态：NO-GO；本阶段仅健康路径检查，签名支付 E2E 仍待更细致的受控测试方案。**


## 2026-11-04 首次真实云端健康请求拒绝与 Worker 级 Access 修正

受邀审查人使用 Cloudflare Access OTP 正常登录 `waffo-preprod-e2e-20261104.sunland.dev/__preprod/health` 后，浏览器实际显示 `{"ok":false}`，**健康检查未通过**。Access Authentication 日志同时显示 `2026-11-04T04:33:40Z` 有 `action=login, allowed=true`。因此认证层放行成立，但不能把 Worker 链路写为 PASS；`{"ok":false}` 在候选代码中可能是 Access Worker 上下文校验失败，亦可能是私有目标错误被 Gateway 安全屏蔽，缺乏 HTTP 状态及服务器追踪尚不能完全区分。

根据 Cloudflare 2026-11-02 官方 Workers Access 文档，`ctx.access` 是应用 Access 保护在 Worker 调用上下文的身份对象。候选网关 `verifiedAccess(ctx,audience)` 对该对象及精确 AUD 强制 fail closed。本轮最小调整仅涉及**现有临时 Access 应用的目的地模式**：从 `destinations:[{type:"public",uri:"waffo-preprod-e2e-20261104.sunland.dev"}]` 切换为 `destinations:[{type:"worker",worker_id:"979a32154d3748e282dbdd959eaca24d"}]`，保留相同应用 ID `44d96853-d386-481c-b5ce-b44ae6dba634`、相同 Audience `d91acb5be2f84f46b7332618624ba7aff97354ac5e2f861938f4ab5ec3c6e4d7`、相同唯一精确邮箱 Allow 策略、同一独立 OTP 身份提供方和 30 分钟会话。没有添加 Everyone、全账号 Worker Access 或额外域名。

**变更后只读验证通过**：GET 确认 Worker 目的地 ID、策略与原 Audience 匹配，临时 Custom Domain 仍只绑定该 Gateway，Webhook/Cron 分别为 `false`；Cloudflare Browser Run 的未登录 GET 再次呈现 `Sign in ・ Cloudflare Access`。**已认证的重新健康检查尚待审查人刷新完成，故本次修正仍是待验证的假设，不能声称问题已解决或 E2E PASS。** 未测试真实签名 Webhook，独立 D1 未写入。

重要：原 `waffopay-preprod-isolated` 的临时 Secret 轮换版本 `eedf9bb3-0b18-44f4-a40e-18babc0ccef2` 仍部署中，必须在完成或放弃健康检查后先解除临时公网入口，删除临时 Gateway、Access 应用及 OTP，最后恢复审计认可版本 `26863803-021d-46bd-b3d5-49c15abbfe90` 并核验。生产支付、会员权益及正式数据库均未获授权修改，继续 **NO-GO**。


## 2026-11-04 临时健康路径分段诊断开关

审查人确认在原 Cloudflare Access 应用切换到 Worker-scoped destination 后，健康访问仍仅显示 `{"ok":false}`，因此**不认定 Worker 级 Access 调整解决了问题**。Access 账户只读审计显示 `2026-11-04T04:39:36Z` 的认证事件为 `action=login, allowed=true`，但临时 Gateway 的 Cloudflare Workers Observability 原先是禁用状态，不能从现有服务端日志还原失败的内部步骤。尚不清楚是运行时 `ctx.access` 不符合网关断言、后端 Token 校验拒绝、内侧 `preprodReady` 返回 503，或其他原因。

为避免继续反复试错、猜测或放宽安全规则，Draft PR #35 新增仅在 `WAFFO_PREPROD_DIAGNOSTICS_ENABLED=true` 且**精确 GET /__preprod/health（不带查询参数）**时输出预定义的安全错误类别：

- `access_context_rejected`：Worker 级 Access 上下文与要求不符。
- `private_worker_gate_rejected`：私有 Worker 返回 403。
- `private_worker_not_ready`：私有 Worker 返回 503。
- `private_worker_non_200`：其他被批准范围内的非 200 响应。
- `private_health_invalid_json`、`private_health_payload_mismatch`：下游 200 健康报文不是预期安全结构。
- 独立的 `private_target_unavailable` 仍仅指内部 Service Binding 调用异常。

**从不返回下游原始响应、Exception、Token、JWT、邮箱、D1 内容或用户凭证；不改变 Access 失败时的 403，也不放开付款路由。** 非健康接口与未启用诊断的 Gateway 维持原有通用错误输出。对应单元测试及全仓离线测试、可重复构建的两项 CI 均 PASS（`#41774824034`、`#41774824068`）。

仅对临时 `waffopay-preprod-e2e-gateway-20261104` 进行了新版本上传，在 multipart metadata 保留原有 `secret_text` Binding 类型，未读/回显密钥或改变现有私有 Worker。云端 GET 复核：Gateway 已部署单一 100% Version `00649704-3eb4-4860-be9d-77d3533e879b`，保留唯一私有 Service Binding `WAFFO_PREPROD_TARGET → waffopay-preprod-isolated` 和名为 `WAFFO_PREPROD_GATE_TOKEN` 的 Secret Binding；`WAFFO_PREPROD_DIAGNOSTICS_ENABLED=true`，`WAFFO_PREPROD_ALLOW_WEBHOOK=false`、`WAFFO_PREPROD_ALLOW_CRON=false`、`WAFFO_PREPROD_ENTITLEMENTS_ENABLED=false`，workers.dev 和 Preview URL 关闭，Worker 级 Access 应用仅允许精确邮箱。原私有 Worker 临时 Version `eedf9bb3-0b18-44f4-a40e-18babc0ccef2` 未改变。

**当前诊断请求仍待审查人用已认证浏览器重新 GET**，尚未判定故障链路，不得将这次代码变更称为“修复完成”。完成本轮后必须立刻解除临时 Custom Domain、移除 Gateway/Access App/OTP IdP，并恢复私有预发布 Worker 至原审核版 `26863803-021d-46bd-b3d5-49c15abbfe90`，重新 GET 审计。任何真实签名 Webhook、D1 写入、正式支付发布继续禁止。


## 2026-11-04 云端健康验证未通过与受控回滚最终记录

**验收结果：BLOCKED / NOT VERIFIED，不得标记为 PASS。** 审查人在已认证浏览器中复测 `GET /__preprod/health`，即使将临时 Access 应用目的地改为 Worker-scoped、再部署添加安全健康诊断的 Gateway 版本，页面仍显示 `{"ok":false}`。Cloudflare Access 服务端认证日志在 `2026-11-04T04:39:36Z` 等时间记录 `action=login, allowed=true`，但不能由此推定 Gateway 自身的 `ctx.access` 验证成功。

查明的观测条件：

- 临时 Gateway 的 Workers Logs / traces 原本未开启，无法从历史日志读取故障路径。Cloudflare API 已验证诊断版 `00649704-3eb4-4860-be9d-77d3533e879b` 为 **100% 活跃部署**，Settings 中 `WAFFO_PREPROD_DIAGNOSTICS_ENABLED=true`、唯一内部 Service Binding、Secret Binding 均存在；`WAFFO_PREPROD_ALLOW_WEBHOOK=false`、`WAFFO_PREPROD_ALLOW_CRON=false`、权益开关关闭。部署版本与绑定存在**不等于**取得了单次失败请求所执行的具体分支。
- 仓库 Gateway 代码的健康诊断仅在精确 GET `/__preprod/health` 且无查询参数时输出固定 `reason`。目前的通用 `{"ok":false}` 可能来自路径 / 查询参数 / 方法不匹配的路由拒绝分支、与当前部署代码不一致的响应或其他尚未被观测到的因素。**没有真实请求的 HTTP 状态、完整路径与追踪数据，不能认定根因为 Access、Secret 或内部 Service Binding。**
- CI 的离线 workerd 合成用例及可重复构建通过，但本次**真实云端健康检查及签名支付 E2E 都没有通过**。独立 D1 的只读计数仍是 `payment_intents=1`、`event_ledger=0`、`production_outbox=0`，没有执行业务写入。

**安全清理与回滚：PASS。** 先删除临时 Custom Domain，再 GET 确认该域名与 DNS 均不存在、没有临时 Zone Route；随后删除 `waffopay-preprod-e2e-gateway-20261104`、对应 Access 应用及临时 One-time PIN 身份提供方。再次 GET 核查五类临时资源均为 0 残留，账号恢复 **14 个 Worker、5 个 Worker Custom Domain、2 个 D1**，原有 Cloudflare Access 组织与正式身份提供方保留。

- 私有预发布 Worker 在本次测试中曾经轮换 `WAFFO_PREPROD_GATE_TOKEN`，临时部署版本为 `eedf9bb3-0b18-44f4-a40e-18babc0ccef2`。回滚到审核版时 Cloudflare API 先返回 **10220**，提示旧版之后该 Secret 已改变，须显式 `force=true` 才能恢复。**在测试公网入口已撤销、目标 Version ID 与旧来源 Commit 注解已重新核验后**，用 `POST /deployments?force=true` 创建单一 100% 审核版本部署。
- 回滚后实际版本确认为 `waffopay-preprod-isolated = 26863803-021d-46bd-b3d5-49c15abbfe90`，来源 Commit 注解 `e670f7ba43c1089ac1268d72bf1364fd65c1b45b`；Mock 仍是审核版 `39fd33fd-173c-481d-ba99-03740c1a5574`。两者 `workers.dev=false`、`previews_enabled=false`、Cron 数量 0，Entry 的原有 15 项 Binding 类型与合成 D1 / 内部 Mock 指向重新核验匹配。
- 正式 `waffopay` 版本仍为 `b414b89b-2218-47c6-bb7a-b85513af9125`，`afdianpay` 仍为 `a84fa755-4a9e-456a-94eb-8746c7f11d1b`；未修改生产付款、会员权益或数据库。

**后续建议**：先改进离线 Gateway 诊断覆盖范围，增加未携带任何凭据的路由与带查询参数的错误分支测试；若仍需云端复现，启用最小化、脱敏的 Worker request/response 状态日志，利用一次明确的授权浏览器访问采集 HTTP status、路径（不含查询值、Cookie、JWT）及脱敏跟踪标识。禁止直接放宽 Access、把隔离 Worker 开放给公网或为了诊断重演真实付款。**生产继续 NO-GO。**


## 2026-11-04 第二次诊断演练：待人工配对测试密钥

用户要求持续推进，直到必须人工参与时暂停。本轮复查 Draft PR #35 的 Isolation CI 和可重复构建 CI 都已通过。新部署使用当前草稿分支的分段日志 Gateway 代码，**并未执行云端支付 E2E**。

**已经完成的非生产、只读和临时配置动作：**

- 独立 Cloudflare Access 账号成员 OTP 身份提供方：`Waffo one-shot diagnostic OTP 20261104`（ID `acaceac2-7741-453b-9c7f-09795715a470`）。
- 独立 Access 应用：`Waffo one-shot diag Access 20261104`（ID `17729548-132b-4746-a131-940dea958d0d`，Audience `dfdae64c7b4fc3058ce7a3ed39210a7320cf06b8941f1936b9f88b6db8d656d8`），严格单邮箱 Allow、无 Everyone / Bypass，已切换为 Worker-scoped 保护，目标 Worker ID `f3ddba13cd734eea93f552d5eb877199`。
- 新建私有诊断 Gateway `waffopay-preprod-diagnostic-20261104`，当前 100% Version `e10cba71-ccc5-4814-aa80-f92a6b083de4`。已设置 `WAFFO_PREPROD_GATEWAY_ENABLED=true`、`WAFFO_PREPROD_ISOLATED=true`、`WAFFO_PREPROD_ENTITLEMENTS_ENABLED=false`、`WAFFO_PREPROD_DIAGNOSTICS_ENABLED=true`、`WAFFO_PREPROD_ALLOW_WEBHOOK=false`、`WAFFO_PREPROD_ALLOW_CRON=false`、精确 Access AUD，唯一 Service Binding 目标 `waffopay-preprod-isolated`。
- 仅该临时 Gateway 启用 Workers Observability Logs（100% 采样），**关闭自动 invocation_logs，关闭 traces**。阶段日志由源代码固定枚举安全生成；已核对 Gateway Worker 的实际 API settings 生效。Gateway 的 `workers.dev=false`、Preview=false、Cron=0，**不存在公网 Custom Domain**。Access 应用的预留域名 `waffo-preprod-diag-20261104.sunland.dev` 尚未绑定 Worker。
- 私有审核 Worker `waffopay-preprod-isolated` 仍为原版 `26863803-021d-46bd-b3d5-49c15abbfe90`（100%），未修改其任何 Secret / Binding，已有 15 项 Binding 完整。独立 D1 仍为 1 payment intent、0 events、0 outbox。生产 Worker 版本未动。

**人工阻塞：** 自动创建并配对非生产 `WAFFO_PREPROD_GATE_TOKEN` Secret 到诊断 Gateway 与既有私有 Worker 的执行请求被当前工具安全检查拒绝，**工具调用没有执行**。执行后再次 GET 证实：诊断 Gateway 完全没有此 Secret Binding，原私有 Worker 仍为旧审核版本且存在原 Secret Binding，没有发生半途轮换，也没有公网入口。**不得**更换工具参数绕过该检查；下一步必须由拥有该 Cloudflare 账号权限的用户在可信管理界面人工生成并在两个 Worker 上设置相同的新随机测试 Token，不在聊天或 GitHub 提交明文。人工设置完成后，继续 GET 核实两个绑定的名称与类型、临时新版本、Access 安全策略与脱敏日志，匿名拦截测试 PASS 后才能临时绑定域名，再由用户完成一次授权健康检查并收集安全阶段日志。

**状态：USER_ACTION_REQUIRED，PRIVATE_GATEWAY_NOT_ROUTABLE，PRODUCTION_NO_GO。** 禁止在 Secret 未配对及安全核验之前公开测试域名；测试结束后必须按本 PR runbook 的顺序解绑域名、删除临时 Gateway/Access/OTP，并将私有 Worker 恢复到审核 Version，必要时仅在原审核元数据核实后遵循 Cloudflare 的 force 回滚保护。
