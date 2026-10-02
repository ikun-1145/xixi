# Waffo Pancake 接手审计（2026-09-30）

结论：已完成独立审计、最小修正和本地验证。候选只能用于取得缺失参数后的 Test Mode 观测验证；尚不能发布生产权益开通。官方 Webhook 无可靠 productId，税费、折扣及可信订单报价证明尚未闭合，因此代码和 SQL 提案均拒绝 Waffo 权益写入。

本轮没有部署、commit、push、执行 migration、生产数据库写入、创建真实支付、退款、修改 Dashboard/DNS/route、开任何开关或改真实用户 Pro。生产 Supabase 仅只读核对函数、ACL、触发器和约束。没有读取或持久化真实私钥。

## 接手与修改范围

- 原 checkout `/Users/liuxize/Developer/xixi` 为干净 main，HEAD `bfb9574495dbcc4b5141816724cb1d01c1f6eea1`。
- 复用已有 worktree `.claude/worktrees/ghost-account-bug-in-login-registration-ecfeea`，branch `claude/exciting-dijkstra-82155c`，HEAD `c1dbad9893a3a2d8a5f5ad3f3f5e98d89476bdb2`。
- 初始即有 Round 1/2/3 未提交改动。未切分支、暂存、重置或创建替代工作区。
- 本轮续改 `worker.js`、`wrangler.toml`、provider-aware proposal、`ai/pro-payment.js`、`tests/waffopay-worker.test.mjs`、`tests/pro-payment-ui.test.mjs`，另新增本报告。
- Round 1/2 页面、`p/js/site-i18n.js`、Afdian Worker/config 与接手指纹相同；既有 Afdian ¥10、订单及历史规则未改。接手版本的设置页升级按钮已禁用，其余现有 Afdian checkout 入口保持原逻辑；不能把设置页禁用归因于本轮。
- 采用现有 Afdian Worker 的零依赖 WebCrypto 风格，参考官方 TypeScript/Go SDK 的签名、错误及事件模型，未复制实现或新增依赖。

## A–P 审计结果

| 项目 | 原实现问题 / 本轮结论 |
| --- | --- |
| A API 签名 | canonical 结构正确，但 API 时间戳误用毫秒，已改 Unix 秒；对实际发送 JSON 的 SHA-256 Base64 签名。私钥只支持 PKCS8；官方 SDK 兼容 PKCS1，未来须安全转换后注入。 |
| B Raw body | 保留 `request.text()` 后验签、再 JSON.parse；64 KiB 流式限制不重序列化，原生 workerd 对带空白/换行报文验证通过。 |
| C 环境 | 原版跨公钥尝试/字段兜底不足。现在仅当前环境公钥，签名环境、payload.mode、部署环境必须一致；生产公钥等于 Test 公钥拒绝。另强制可信 Store ID 匹配。 |
| D 幂等 | event.id 不是保证独立的交付 UUID。KV 按环境/商店/观测用途/eventType/id/eventId 分区，只做交付观测去重；不是事务锁，不宣称完整业务幂等。未来需要 provider + PAY ID 的 DB 事务账本。 |
| E 用户绑定 | 仅用户 Bearer token 调既有 intent RPC，复用服务端 payment_reference UUID；回传 orderMerchantExternalId，不从 metadata、email 或客户端 user_id 猜绑定。当前未走激活 RPC。 |
| F Checkout 篡改 | product 固定确认 ID，币种固定 CNY，引用来自 RPC，客户端只影响语言/深色模式。忽略客户端金额、商品、引用和 user_id，不传 priceSnapshot override。 |
| G Origin | 明确非白名单 Origin 返回 403，未作 RPC/API 调用。合法来源在错误响应也有 CORS；无 Origin 不作为身份凭据，仍须 token。 |
| H successUrl | 配置限定站点 HTTPS 来源；前端仅接受官方收银台 HTTPS 来源、拒绝 URL 用户信息。到达成功页及取得 checkoutUrl 均不证明付款。 |
| I Refund | refund.succeeded / refund.failed 只记录结构化观测日志，无 DB 更新或自动撤销永久 Pro。 |
| J 错误/超时 | 官方响应读取 data.checkoutUrl；非空/畸形 errors、HTTP 错误、409、坏 JSON、重定向、响应体超时均不显示成功。每个上游 8 秒含读 body；前端 30 秒含响应体。无自动重试写 API。 |
| K Replay/header | 过去 45 分钟、未来 1 分钟，严格毫秒 t；重复 t/v1、错误 Base64、坏签名拒绝。容差内的有效重放仍须去重，时间窗不是业务幂等。 |
| L chargedAmount | 去掉 parseFloat 和 deprecated amount 回落，严格主单位字符串、BigInt 换分，拒绝缺失/NaN/Infinity/科学计数/负数/数字类型/多余精度等。算术验证不等于权益资格。 |
| M Afdian 兼容 | 原提案弱化线上 active guard、存在副作用/幂等风险。新提案不替换旧函数，Afdian 显式委托原 6 参；Waffo 在读写前拒绝。不改表/历史数据。 |
| N RPC/ACL | 线上存在 2/6 参重载；新增 7 参 provider 必填无 DEFAULT，避免默认参数歧义。明确撤销 PUBLIC/anon/authenticated，仅授 service_role，缓存 reload 留在未执行提案。 |
| O 回滚 | SQL 仅精确 DROP 新 7 参，不 CASCADE、不恢复旧快照、不删历史。Worker 版本回滚不能代替 DNS、KV、Secret、route 各自的回滚。当前没有外部变更需要回滚。 |
| P Route | 计划 Custom Domain waffopay.sunland.dev 合理；route 仍注释、workers_dev=false，未创建任何入口。须先确定隔离 Test Worker 目标与域名占用，另行授权后配置。 |

## 信任边界与请求规则

Checkout：白名单 Origin（如果存在）→ Bearer token → 完整 Test 配置 → 既有 Supabase intent RPC 认证/绑定 → pending UUID → 服务端固定商品/币种 → 官方签名 API → 官方 checkoutUrl。已激活状态只接受 RPC 明确 activated；前端 alreadyActivated 必须严格为 true。

前端复用刚验证身份的同一 token，避免两次异步取 token 之间切账号；超时关闭占位窗口，迟到响应不得导航。`WAFFO_ENABLED=false`，没有接入生产按钮。

API canonical：`METHOD + "\n" + PATH + "\n" + UNIX_SECONDS + "\n" + BASE64(SHA256(exactJsonBody))`，RSA-SHA256。每次逻辑操作随机 X-Idempotency-Key；不复用可能返回过期 checkout 的 24 小时缓存 key，不宣称双击/客户端重试只产生一个 session。

Webhook：限制原始 body → 严格签名 header/时间窗 → 当前环境公钥验证 `${t}.${rawBody}` → JSON parse → 必要 event 字段 → mode/environment/store 同时一致。Waffo 公钥由平台所有商店共享，验签本身不能证明属于本商店。

生产 `order.completed` 且开关误设 true：在 KV 查询、金额判断和任何下游调用之前返回 503，不污染去重。Test 或开关 false：仅观测。Worker 当前无激活 RPC 路径、无 service_role 权限配置，不能写 Pro。未知事件只确认接收；处理失败返回 503，签名失败 401，结构/环境/商店不符 400。

订单观测要求 paymentStatus=succeeded、orderStatus=completed、CNY、PAY/ORD 格式、eventId=paymentId、有效 UUID 引用及金额算术一致。退款只观测。观测 200 表示接收完成，绝不代表开通。没有 KV 时允许重复日志；即使配置 KV，也不承担业务原子去重。

API 实际 Test/Prod 由 API 私钥所属环境决定，`WAFFO_ENVIRONMENT=test` 无法覆盖误注入的生产私钥。未来必须人工确认 Test API Key 所属环境，Test Worker 不注入生产 API 私钥、生产 Webhook 公钥或 service_role key。

## 金额、税费、折扣、商品最终方案

已确认业务参数：一次性永久 Pro、非订阅，产品 `PROD_4ibh2Jka4tSTmyb35okbRs`、标价 15 CNY；不影响 Afdian 10 元。

官方 chargedAmount 是渠道报告的税含实收、主单位字符串；未报告可省略。旧 amount 可能回落 listPrice.total，禁止作实收证明。listPrice 的 total/subtotal/taxAmount 是订单价格快照；checkout 可传 priceSnapshot 临时覆盖折扣，所以不能把它当作永远不变的原始商品价格。Webhook 的 productName/productMetadata 不能代替可靠 productId；缺商品时填配置商品就是伪造证明。

当前仅验证非负精确分、实收正数、total=subtotal+tax、chargedAmount=total。差异/缺字段只记录拒绝；即使全部通过也不开 Pro。**没有接受 chargedAmount>=15，也没有机械采用 ==15。此处算术条件不是已批准的税费/折扣权益方案。**

未来允许权益前必须有服务端可信的订单→商品→币种→checkout 报价绑定（官方订单查询或受控 checkout 账本），确认 15 元含税策略、taxCategory、折扣允许范围，建立产品价格与实际付款的精确规则；统一 RPC 接收并验证必要证明字段。Store ID 只能挡跨商店事件，不能挡同商店错误商品；单独 payment_reference 只能证明用户引用，不能证明商品及报价。上述证明未闭合即拒绝。

## Provider-aware proposal 与线上只读证据

Proposal 仍在 `supabase/migrations/proposals/`，禁止执行；它是拒绝 Waffo 写入的审核提案，不是完整 Waffo 开通 migration，Test 验证无需执行。

只读目录证据：现有 6 参含 profile active guard；缺失/删除账号不能被创建或复活。2 参激活重载为 service_role-only。新函数默认 ACL 显式授权 anon/authenticated，所以只 REVOKE PUBLIC 不够。订单 BEFORE INSERT trigger 的 advisory lock 在 profile/intent 副作用之后，空结果 FOR UPDATE 也不锁不存在行，不能据此证明并发安全。numeric NaN/Infinity 与 >=15 的比较可通过。历史 unresolved 恢复语义未顺带改动。

提案保留旧 2/6 参定义与 ACL；新 7 参 SECURITY INVOKER、固定 search_path、provider 无默认值；afdian 具名委托旧 6 参；waffo SQLSTATE 55000 在任何读写前拒绝；空/未知 provider 拒绝。事务内撤销 PUBLIC/anon/authenticated，再 grant service_role。将来正式权益版本必须在副作用之前锁 provider/PAY ID、校验重复绑定、保留 active guard，并在隔离数据库验证 PostgREST 解析、权限、并发和精确回滚。

本地证据 `/tmp/waffo-official-audit/supabase-catalog-evidence.json`，SHA-256 `0d94432b03171a399e832bbe57fe98a0b3132fd6eac68e3b1e4c2fd7125bf3c9`。仅目录定义/权限/纯数值验证，不含真实订单/用户。pglast SQL 6 个语句及 PL/pgSQL 1 个函数解析通过；未在数据库执行提案，不能声称线上 RPC 实测通过。

## 自动验证与限制

| 检查 | 结果 |
| --- | --- |
| Waffo 单测 | 96/96 |
| Afdian 回归 | 10/10 |
| pro-payment UI | 11/11 |
| site-i18n | 10/10 |
| 四组定向合计 | 127/127 |
| 默认 npm test（扩展至 95 个 Waffo 用例时） | 463 个，462 通过，诊断 UI summary/off 一次失败 |
| 该诊断 UI 文件独立运行 | 13/13 |
| 最终串行全量 `node --test --test-concurrency=1 tests/*.test.mjs` | 464/464 |
| 原生本地 workerd（Wrangler 4.141.0） | 9/9，合成密钥/签名，仅 loopback，无上游服务配置 |
| 最终 Wrangler deploy --dry-run | 通过；22.88 KiB，gzip 6.43 KiB；没有上传 |
| node --check、TOML 解析、git diff --check | 通过 |

新增用例覆盖秒/毫秒差别、官方签名规范、重复 header、重放窗口、跨商店/跨环境、公钥误配、客户端篡改、响应错误/redirect/超时/限流、金额异常、生产硬阻断、KV 分区、退款观测、前端 token 一致性及迟到导航。原生 workerd 验证原始报文成功/篡改失败/重复观测/缺签名/超限/错误方法/不可信 Origin/缺 token/缺配置；临时合成私钥仅内存使用。验证后关闭本轮本地服务器。

默认并发全量的单次失败未掩盖，串行结果不等于默认并发全部通过。本轮未修改诊断 UI。没有真实 Waffo API、真实 Webhook/Dashboard、真实设备、生产部署、真实支付/退款或 SQL 执行验证。

可复核日志：`/tmp/waffo-focused-all.log`、`/tmp/waffo-full-serial.log`、`/tmp/waffo-full-suite.log`、`/tmp/waffo-flaky-isolated.log`、`/tmp/waffo-native-smoke-results.json`。临时证据不是长期归档。

## 并发与 diff 边界

接手时保存 HEAD/status/diff 及全部 tracked/当时 untracked 文件 SHA-256；结束核对原文件只有上述 6 个授权文件变化，另新增本报告，HEAD/branch 未变。Afdian 与 Round 1/2 页面/i18n 指纹未变。机器存在多个 Agent 进程，不能声称无并发；本次指纹核对未发现其他文件漂移。

当前 `git diff --stat` 包含交接前页面改动；Worker、Waffo 测试、proposal 是 untracked，普通 diff stat 不包含，不能用该统计代表本轮范围。本报告被现有 `.gitignore` 的 `*.md` 规则忽略，只是可审阅本地交付文件；未修改 ignore 规则或强制暂存。完整状态保留全部交接改动。

## 缺失参数与下一步 Test Mode 操作

仍缺 Merchant Short ID、实际 Store Short ID、Test API 私钥及其所属环境证明、Production Webhook Public Key。生产公钥本轮不需要；还须在 Dashboard 核对产品属于该 Store、一次性类型、CNY 标价 15、税务属性/折扣设置。已有 Test Webhook 公钥保留，不要求在聊天发送私钥。

以下为**下一阶段待另行授权的操作清单，本轮全部未执行**：

1. 确认 Cloudflare account、隔离 Test Worker 名称、waffopay.sunland.dev 当前占用和最终配置文件路径，冻结候选 HEAD/文件指纹。若目标域名现有服务冲突先停，不替换现有支付 Worker。
2. 在审批后的 Test 配置填真实 WAFFO_STORE_ID，保留 WAFFO_ENVIRONMENT=test、WAFFO_PRODUCTION_ENTITLEMENT_ENABLED=false、workers_dev=false、route 注释及前端 WAFFO_ENABLED=false。不提供生产私钥/service_role key。核对私钥是 Test API Key；本实现输入必须 PKCS8 PEM。
3. 先创建无公开入口的 Test Worker，再安全注入 SUPABASE_ANON_KEY、WAFFO_MERCHANT_ID、WAFFO_PRIVATE_KEY_TEST。指定同一 config，不在 shell 参数、日志、仓库或聊天输入密钥。`wrangler secret put` 会立即发布新版本，不能当成无发布影响的配置操作。
4. 如需观测交付去重，另行批准后创建 WAFFO_EVENTS KV 并填精确 namespace id；可不配置 KV，但要接受重复日志，不能宣称业务幂等。确认运行环境不绑定生产权益凭证。
5. 所有参数/Secrets 校验后才在批准的 config 增加 Custom Domain `[[routes]] pattern="waffopay.sunland.dev" custom_domain=true` 并发布。这会影响 Cloudflare DNS/证书/公开入口，属于明确外部变更。Workers.dev 保持关闭。
6. 在 Waffo **Test Mode** 新建 Raw 格式 Webhook，URL `https://waffopay.sunland.dev/webhook/waffo`，订阅 order.completed、refund.succeeded、refund.failed。核对当前 Test 公钥；不改生产 Dashboard。
7. 单独批准 Test checkout 验证后，用受控已认证测试调用创建 session，客户端不能传商品/金额/用户。**现配置 SUPABASE_URL 指向生产项目，既有 intent RPC 会创建/复用真实 payment intent；Test Waffo 并不自动隔离该 DB 写入。必须先批准这项具体写入，或选择另行审核的隔离 Supabase 测试环境。** 本轮从未调用真实 intent RPC。不得为了测试打开全站 Waffo 按钮。
8. CNY 一次性官方支持 WeChat，按 Test Mode 模拟流程验证，不能套信用卡样例。确认签名/mode/store/引用链及订单状态；只读比对 Pro 前后不变。成功页不算支付证明，模拟测试不算真实渠道验收。
9. 保存删敏证据并独立复审，再讨论生产商品/报价证明及正式 provider-aware migration。上述观测测试不授权生产开关，不执行当前 proposal。

命令模板仅用于下一阶段审查；WAFFO_TEST_CONFIG 必须指向审批后的配置，WAFFO_TEST_KEY_FILE 必须指向本机安全文件。当前文件 Store ID 为空，不能直接对外部署：

```sh
wrangler deploy --config "$WAFFO_TEST_CONFIG" # 首次仅无 route 的 Worker
wrangler secret put SUPABASE_ANON_KEY --config "$WAFFO_TEST_CONFIG"
wrangler secret put WAFFO_MERCHANT_ID --config "$WAFFO_TEST_CONFIG"
wrangler secret put WAFFO_PRIVATE_KEY_TEST --config "$WAFFO_TEST_CONFIG" # 安全交互输入
# 若拿到的是 PKCS1：本地转换并直接管道输入，勿输出/保存转换结果
openssl pkcs8 -topk8 -nocrypt -in "$WAFFO_TEST_KEY_FILE" | wrangler secret put WAFFO_PRIVATE_KEY_TEST --config "$WAFFO_TEST_CONFIG"
# 仅在批准需要 KV 时创建，然后将返回 id 写入配置
wrangler kv namespace create WAFFO_EVENTS --config "$WAFFO_TEST_CONFIG"
# 参数及 route 审批完成后再次发布最终配置
wrangler deploy --config "$WAFFO_TEST_CONFIG"
```

Test 阶段回退：关闭公开入口/相关 Test webhook，保持两个开关 false，必要时退回审定 Worker 版本；单独处理 route/DNS/KV/Secrets 的影响。无 DB migration 则不执行 DROP。不删除历史订单或真实权益。

## 本轮实际阅读的官方依据

- [Authentication](https://docs.waffo.ai/api-reference/authentication)：API 秒级时间戳、canonical、RSA 签名、私钥环境。
- [Webhooks](https://docs.waffo.ai/api-reference/webhooks)：raw body、毫秒 t、45 分钟/未来 1 分钟、平台共用公钥、事件与金额字段、10 秒响应/四次交付。eventId 为 PAY/REF 业务实体，不保证另有随机 delivery UUID。
- [Create Checkout Session](https://docs.waffo.ai/api-reference/endpoints/orders/create-checkout-session)：productId、currency、orderMerchantExternalId、priceSnapshot、data.checkoutUrl、幂等 key 24 小时。
- [Errors](https://docs.waffo.ai/api-reference/errors)、[Products](https://docs.waffo.ai/features/products)、[Create Product](https://docs.waffo.ai/api-reference/endpoints/onetime-products/create-product)：错误、商品/税务属性。
- [Test Mode](https://docs.waffo.ai/features/test-mode)、[Checkout Flow](https://docs.waffo.ai/checkout/checkout-flow)：API key 环境、CNY/WeChat、Done 跳转。
- [官方 TypeScript SDK](https://github.com/waffo-com/waffo-pancake-sdk-ts)，审计 commit `08300a45f5b5b8a2c489a40f86094d2a5cc564ce`（v0.25.0），与官方 Go SDK：签名/PKCS1-PKCS8/header/error/事件实现对照；未复制源码。
- [PostgreSQL CREATE FUNCTION](https://www.postgresql.org/docs/17/sql-createfunction.html)、PostgREST 函数缓存、Cloudflare Wrangler/Custom Domain 官方文档：重载/默认参数、ACL、缓存和部署边界。

官方税相关页面存在当前功能说明与 checkout 税预览描述的不一致，不能据此硬编码税额为零；真实 Store/产品税设置与付款报价仍属待确认项。
