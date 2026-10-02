# Waffo Test 隔离后端设计（2026-09-30）

> ⚠️ 方案已更新（2026-10-01 PATCH 003 已执行）：**最终采用「复用现有 Supabase + 完全隔离 `waffo_test` schema + 标准 GoTrue `authenticated` token」**：checkout = 测试用户 token + `waffo_test.test_subjects`；ingest = 专用 GoTrue ingest bot token + `waffo_test.ingest_principals` 白名单（与 test_subjects 互斥）。旧 `waffo_test_checkout` / `waffo_test_ingest` 角色保留但无任何 waffo_test 权限。不再创建独立 Supabase Test 项目。权威实现以 `schema.DRAFT.sql`、`workers/waffopay/worker.js`、`verify_design.py`、`tests/waffopay-worker.test.mjs` 为准。本文档下方「推荐独立项目」等描述为早期设计探讨，保留作背景；凡与代码冲突处，一律以代码为准。RPC 实名为 `waffo_test.get_or_create_intent()` / `waffo_test.record_event(...)`，角色均为 `authenticated`（非 `service_role`），由白名单 + RLS 区分身份；Worker 用 `Content-Profile: waffo_test` 选择该 schema。隔离边界靠白名单 + RLS + 完全限定对象名 + `security invoker` 保证，见 §同项目 namespace 方案。

本轮阶段：设计与本地静态验证。未创建远程资源、未连接生产 Supabase（含只读）、未执行任何 SQL/seed/migration，未改 Afdian、前端或现有 proposal。此文件和 schema.DRAFT.sql 不构成部署授权。同项目隔离方案的 schema/角色/API 配置本身即属生产项目变更，仍需后续单独授权并核对目标项目 ref/连接后才能执行。

## 推荐方案及边界

独立 Test Supabase（Postgres + Auth + Data API）提供最小后端，独立 Waffo Test Worker 只持有该项目凭据；由受控 harness 使用测试账号 access_token 发起 checkout。不复制生产 Auth/JWT signing key、用户、profile、订单、secret、生产 migrations 或 provider-aware proposal。

独立项目比裸 Postgres 更适合当前实现：Worker 已使用 PostgREST RPC 和用户 Bearer token；裸数据库还需部署认证/API 网关、实现 issuer/JWT 校验与 RPC 适配，减少表数量却增加新服务。官方本地 Supabase 栈可用于后续运行验收，但需容器和 Auth/API 服务；本轮没有启动它，也没有执行本地 SQL。无需为纸面验证创建远程项目或克隆生产数据库。

测试认证是独立项目标准 Supabase Auth UUID，使用 auth.uid()；生产 Sunland 的自建 JWT id 是另一套身份，不能交换或复用。当前 ai/pro-payment.js 和 database-token-client.js 仍要求生产身份链，故 Test 使用独立 harness，不修改 localStorage/token，不调用 api.sunland.dev，不打开 WAFFO_ENABLED。测试 Auth 禁用公开注册；允许名单由管理员在新项目内登记，不能依赖用户可编辑 metadata。

## 实际依赖与最小 schema

| 当前代码路径 | 实际依赖 | 是否已有 |
| --- | --- | --- |
| POST /checkout/waffo | test-role 用户 token + `POST /rest/v1/rpc/get_or_create_intent`（`Content-Profile: waffo_test`），body `{}`，返回 UUID payment_reference 和 pending status | Worker 已实现，走隔离 schema |
| POST /webhook/waffo | Test 公钥、mode/store、原始 body、日志，可选 WAFFO_EVENTS KV | 已有；没有 Supabase RPC/表调用 |
| Test 事件持久化 | 下述 event_ledger 和 `waffo_test.record_event(...)` RPC（`Content-Profile: waffo_test`，`authenticated` ingest bot） | Worker 已实现 test-mode 落账；SQL 草案待授权后执行，未执行前 RPC 不存在 |

独立项目新增三张应用表，Supabase 自带 auth.users 不复制生产数据：

| 表 | 最小字段/约束 | 权限 |
| --- | --- | --- |
| waffo_test.test_subjects | user_id UUID FK 新项目 auth.users；label（A/B/disabled）；enabled | authenticated 仅读取自己；登记/停用由测试项目管理员执行 |
| waffo_test.payment_intents | payment_reference 服务器随机 UUID；user_id 唯一；status 只能 pending；requested_product_id、CNY、1500 分；created_at | RLS 只读本人、仅已登记启用账号可插入本人 intent；无更新/删除权 |
| waffo_test.event_ledger | test mode、Store、eventType、eventId、deliveryId、ORD/PAY ID、reported_reference、派生 bound_reference、body SHA-256、观测代码、时间 | 仅 Test 服务端 SELECT/INSERT，不允许 authenticated 写入；无更新/删除权 |

event_ledger 合并订单和事件观测，不另建订单状态投影或激活账本。唯一键是 store/eventType/eventId，区分同 REF 的 succeeded/failed，mode 固定 test。保留首次 deliveryId，不记录每次交付历史/重试计数；如后续需要全交付追踪，另加 deliveries 表。无 pro、activated、激活 RPC、生产 profile FK 或触发器。

requested_product_id/expected_price_minor 表示计划购买的商品及价格，不是支付商品证明。金额资格不在该测试 DB 中计算；Worker 已有严格金额验证，只传受控观测代码和原文 SHA-256。账本不存完整 payload、JWT、签名/密钥或用户文本。

## RPC / 权限契约

`waffo_test.get_or_create_intent()`：零参数，与 Worker 路径/返回兼容，位于隔离 `waffo_test` schema，不覆盖任何生产同名函数。SECURITY INVOKER、search_path=pg_catalog、限定 waffo_test 表，且要求 `current_user = 'authenticated'`。jwt_uid() 非空且已登记启用，否则 42501。INSERT ON CONFLICT DO NOTHING 后读取本人，返回同一个 UUID 和 pending；没有 activated 分支。禁用账号即使保留旧 JWT 也被允许名单检查拒绝，不推论为通用 Auth 撤销机制。

表位于不暴露到 Data API 的 waffo_test schema，API Exposed schemas 只保留 public；public 只暴露两个 RPC。authenticated 的底层 SELECT/INSERT 授权仅用于 invoker RPC，private schema 不提供直接 REST 表入口。RPC 本身无 user_id/reference/product/amount 入参，引用默认由服务器生成。若将来暴露 private schema，将破坏这个入口约束，不能这样配置。

`waffo_test.record_event(...)`：Worker test-mode 落账使用，所有参数必填（可空的字段传 JSON null），要求 `current_user = 'authenticated'`、jwt_uid() 为 ingest_principals 中 enabled 的 bot 且不在 test_subjects（非 service_role）；拒绝 prod/null mode，不接受客户端 user_id。bound_reference 只从 Test intent 查询，找不到记录 unbound，绝不猜账号。唯一约束先 INSERT；重复正文/引用一致返回 duplicate，正文 hash 或引用不同返回 conflict，不覆盖原绑定。观测代码限定 valid_observation/invalid_observation/unbound，绝不接权益层。

所有表启用 RLS；显式从 PUBLIC/anon/authenticated/service_role 及两个旧 test 角色撤销初始表权限后，仅向 `authenticated` 最小授权，行级访问由 test_subjects / ingest_principals policy 决定（普通 authenticated 读 0 行、写被拒）。每个 RPC 撤销默认 EXECUTE 后仅授 `authenticated`，函数内再校验白名单。Worker ingest 用 bot 的 GoTrue password grant token（≤1h，每 isolate 缓存，refresh token 丢弃），不持 signing key、不持 service_role；bot 调 checkout RPC / 直写 intent 均被拒。

SQL 草案放在本目录，未进入 supabase/migrations：CREATE 无 OR REPLACE，撞名即失败；显式确认标记及 production 表存在检测用于防误执行，但不能代替核对项目 ref/连接目标。**绝不能在生产执行草案。** 后续仍须实测 PostgreSQL/RLS/ACL、PostgREST、Auth、并发和 schema cache；本轮解析通过不证明上述运行行为。

## 最小 seed 方案（尚未执行）

1. 新项目禁用公开注册，用该项目 Dashboard/Admin Auth API 创建三个完全虚构的测试账号 A/B/disabled。可用保留 example.test 地址并管理员确认，无邮件/OAuth 外部登录依赖；账号及强密码现场生成，绝不复制生产 identity。不要直接 INSERT auth.users。
2. 取得新项目返回 UUID，经独立项目确认后，在 test_subjects 插入 A/B enabled=true、disabled enabled=false。此时只有允许名单三行，intent/ledger 空表。
3. A/B 分别登录，通过新项目 Auth 发出的 session.access_token 调 Test Worker。token 仅内存保存，不打印或写仓库。禁止使用生产登录页或生产 database-token 兑换。
4. 第一次 RPC 创建 UUID intent；同账号重试复用，两个账号引用不同。disabled/未登记/匿名/过期 token 应被拒绝。订单与事件由 Waffo Test 模拟流产生，不预造“已付订单”，不预设任何权益。

seed 行数最多三个是当前最小验收数据集，不是生产用户模型；需要更多测试账号时再放宽 label 约束。删除测试账号目前 FK RESTRICT，以免账本绑定静默消失；清理需另行设计 Test-only 清理步骤，不能套生产 account-deletion RPC。

## Worker 的 Test-only 配置

当前 worker.js/wrangler.toml 本轮完全未改。现有 toml 的 SUPABASE_URL 仍指生产，**不可直接作为 Test 部署文件**。下一阶段需要单独配置文件，不能回写 Afdian/共享站点配置。

| 变量/凭据 | 下一阶段来源与规则 |
| --- | --- |
| SUPABASE_URL | 新独立项目 HTTPS URL，必须与生产 ref 不同；不默认回落现 toml |
| SUPABASE_ANON_KEY | 对应新项目 publishable/兼容 anon API key，使用当前变量名；用户 Bearer token 单独来自 Test Auth |
| WAFFO_ENVIRONMENT | test，必须精确值 |
| WAFFO_MERCHANT_ID | 用户从 Waffo 取得 MER_...，安全注入；当前未知 |
| WAFFO_STORE_ID | 实际 Test 商品所属 STO_...，不可猜测；当前未知 |
| WAFFO_PRIVATE_KEY_TEST | 所属环境确为 Test 的 API 私钥，PKCS8；安全 Secret 注入，绝不贴聊天 |
| WAFFO_WEBHOOK_PUBLIC_KEY_TEST | 已有用户确认公钥；部署前对照 Dashboard Test 公钥指纹 |
| WAFFO_PRODUCT_ID / WAFFO_CURRENCY | 保持确认商品 ID / CNY；另核对商品在 Test Store 中确实存在且一次性 15 元，不能假设 Live ID 自动可用 |
| WAFFO_PRODUCTION_ENTITLEMENT_ENABLED | false；保留代码硬阻断 |
| WAFFO_ALLOWED_ORIGINS | 受控 harness 的精确 Origin；命令行无 Origin 仍需有效 Test Auth token |
| WAFFO_SUCCESS_URL | 计划 `https://waffopay.sunland.dev/test/done`，仅 Test Worker 返回无脚本的静态完成文本，不调用任何 Supabase。当前代码仅允许 sunland.dev/www，所以该路径/白名单尚需后续 Test-only 实现，不回落生产设置页/首页 |
| WAFFO_EVENTS | 可选且独立的 Test KV；未来 DB 持久化成功之前不能标记 KV 已处理 |
| WAFFO_TEST_LEDGER_KEY | **未来 adapter 新变量，当前代码不使用**；只允许新项目服务端凭据，绝不注入生产 service_role |
| WAFFO_TEST_PROJECT_REF | **未来 URL/issuer 防错守卫的新变量，当前代码不使用**；必须非生产、与 URL 相符，无缺省回落 |
| WAFFO_TEST_SUCCESS_ORIGIN | **未来 Test 完成页白名单变量，当前代码不使用**；仅审批后的 Worker HTTPS origin，必须与 successUrl 同源，不接受客户端传入 |

当前 webhook 无 DB 落账，所以初期 checkout + 日志观测无需 service_role。完整持久化验收才加入 Test-only ledger adapter：先验签/时间/mode/store，再规范化/金额观测分类，调用 ledger RPC，收到 recorded/duplicate 才 200/标记 KV；conflict 或 DB 错误返回 503，不跳过落账确认。错误商品/金额只记 invalid_observation，不开 Pro。未知/坏 UUID 传 null + 拒绝观测代码，不能猜引用。

未来配置守卫必须在任何 fetch 前检查：test 模式、新项目 ref/URL 白名单、无生产凭据/公钥/生产身份交换入口；需要测试验证误配被拒绝。现 Worker 尚无该 Supabase URL 守卫，不能把计划写成已实现。Test `/test/done` 及同源成功页白名单也未实现：当前不能直接使用建议的 successUrl，且不导航生产页面以免它们发起生产 Supabase 请求。测试后端也不证明用户生产绑定或真实渠道付款接受。

## 同项目 namespace 方案（已采用）

**这是最终采用的方案，本轮完成代码/SQL/测试，但远程执行仍需后续单独授权。** 新 schema `waffo_test`、新表、隔离 RPC 名 `waffo_test.get_or_create_intent()` / `waffo_test.record_event(...)`（不覆盖现生产同名 RPC）；Worker 用 `Content-Profile: waffo_test` 选择该 schema。private 数据表不暴露、函数 schema 单独审核暴露，只授两个 test-only 角色必要权限。

要保证正常测试调用不碰生产表：专用 NOLOGIN/非 BYPASSRLS 角色，只授 Test schema/table/function；完全限定对象名，固定 search_path，禁止动态 SQL/跨 schema FK/触发器/生产激活函数；对 public 及生产表无写授权。用专用 PostgREST/API 实例只暴露 Test schema 并只允许该角色；数据库中不存在从测试对象引用生产表的依赖。身份凭据必须独立于生产 signing key，不能把项目 service_role 交给测试 Worker。实际角色有效权限、PUBLIC 继承授权、所有者/definer权限、对象依赖和 Auth/JWT 信任配置都须审核，表名前缀不构成隔离。

须正视的残余风险：同库仍共享数据库、备份、Auth/管理员信任、资源配额；项目 owner/service_role 天然可跨界，无法承诺任意误配置下绝不影响生产。新 schema/角色/API 配置本身即属生产项目变更，且测试调用仍连接生产数据库。因此隔离靠「专用 NOLOGIN/NOINHERIT/非 BYPASSRLS 角色 + RLS + 完全限定对象名 + `security invoker` + 对生产表零写授权 + 权限自检 DO 块」多重保证，并要求执行前核对项目 ref/连接目标、Test Worker 绝不持有 service_role/生产签名密钥。**本目录 SQL 草案（`schema.DRAFT.sql`）即为本方案而写；执行前须显式设置 `waffo_test.target_ack`，且必须另行授权。**

## 后续批准后的创建与部署顺序 / 副作用起点

| 顺序 | 操作 | 外部副作用 |
| --- | --- | --- |
| 0 | 本轮设计、SQL 解析、已有单测、指纹核对 | 仅本地文件/本地进程，无远程变更 |
| 1 | 用户批准后创建全新 Supabase Test 项目（不是 clone/branch/restore 生产） | **第一项真实外部副作用**：远程资源/潜在计费 |
| 2 | 确认 ref/URL/新凭据，在独立项目批准执行最小 schema，配置 Auth/创建测试账号/登记 seed | Test DB/Auth 写入；不执行现有 provider-aware proposal |
| 3 | 后续单独实现 Test 配置守卫/harness/ledger adapter/无脚本完成页与同源白名单，验证权限、绑定、重放、故障、并发；无公网验证可先本地 mock | 本地实现；连 Test 项目验收会写 Test intent/ledger |
| 4 | 冻结指纹，审批 Cloudflare account/waffopay-test 目标；先创建无 route 的 Test Worker，安全注入 Secrets/KV | Worker/Secret 版本/KV 外部写入；secret put 也会发布版本 |
| 5 | 批准后创建 ASCII Custom Domain waffopay.sunland.dev | DNS/证书/公网入口变化；先确认无现有服务冲突 |
| 6 | Waffo Dashboard Test HTTP/Raw webhook 指向 https://waffopay.sunland.dev/webhook/waffo，订阅三个事件 | Dashboard 外部写入 |
| 7 | 批准后 harness 使用 Test Auth 创建真实 Waffo Test checkout，按 CNY 模拟渠道支付 | 写 Test intent / Waffo Test session/order / Test event ledger，不是真实资金交易 |
| 8 | 只读核对 Test 绑定、重放去重/冲突/退款观测及不存在权益写入路径 | 测试证据；不授权任何生产切流 |

账号、seed、Secrets、Webhook 配置不是无副作用操作，均属于下一阶段授权范围。未发送任何实际 Waffo API/checkout 请求，不用成功页当验证证据。

## 用户仍需手工取得/确认

- Merchant Short ID、实际 Test Store ID；该 Store 内 Product ID、15 CNY、一次性类型、税费/折扣设置。
- Test API private key 及 Dashboard 明确 Test 环境；不要发送到聊天，后续确定目标后安全 wrangler secret put。API key 所属环境不能靠 env 字段或 X-Environment 覆盖。
- 已有 Test Webhook public key 本轮从当前配置计算 SPKI DER SHA-256：`e39c3c78806dfc0f56b6debfb1fad650fa341fc671a4fb4900e8e263bbdf914b`。部署前对照 Dashboard Test 公钥；官方文档没有公布可直接比对的 PEM，本轮未访问 Dashboard，不能宣称已完成远程核对。未知生产公钥本轮无需取得/注入。
- Cloudflare account、Test Worker 目标、域名归属/是否占用。必须用 ASCII `waffopay.sunland.dev`；`waﬀopay` 的连字字符不是同一个域名。
- 将来新 Test Supabase ref/URL/API key、独立测试账号；本轮不要求提前创建。

## 验证记录和禁止项

schema.DRAFT.sql 本机 pglast 解析通过：27 条 SQL、3 个 PL/pgSQL 块；verify_design.py 的 11 个危险变异样本全部被拒绝（关闭 RLS、definer、生产表写入、客户端 ledger 权限、prod mode、覆盖函数、客户端 user_id、公开 ledger RPC、漏撤销默认 EXECUTE、读取跨用户 intent、客户端指定引用）。独立安全复审指出原检查器未覆盖后四项，已补逐 RPC signature/ACL、grant 允许集合、policy 所有权谓词及零参/插入列约束。只检查语法与明确的静态约束，不是完整 SQL 语义证明。没有执行 SQL，不能宣称 RLS/Auth/RPC/并发实际通过。

本轮重新运行已有 Waffo/Afdian/UI/i18n 定向测试，127/127 通过；git diff --check 通过。没有修改应用 JS/HTML/CSS，本轮无需重跑整个 UI 全量。定向日志 `/tmp/waffo-test-design-regression.log`。新文档受既有 `*.md` ignore 规则忽略，SQL/Python 草案为 untracked，本轮未改变 ignore 或暂存。

禁止：生产 Supabase 连接/写入、生产表/用户/订单/secret 复制、任何 migration 执行、现 provider-aware proposal 执行、改 Afdian/生产 RPC、真实支付退款/Pro、生产 API key/生产 service_role 注入、开两个开关、生产商品 publish/sync、commit/push/deploy/远程资源创建/Dashboard/DNS/route 变更。

## 官方依据（本轮重新查阅）

- [Supabase Custom Schemas](https://supabase.com/docs/guides/api/using-custom-schemas)：exposed schema 与授权分别配置；不复制示例 GRANT ALL。
- [Database Functions](https://supabase.com/docs/guides/database/functions)、[RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)：invoker、安全 search_path、明确 revoke/grant、auth.uid 与所有权。
- [Local Development](https://supabase.com/docs/guides/local-development)：官方本地栈提供 Auth/Postgres/Data API，非裸 DB。
- [官方 user-management 示例](https://github.com/supabase/supabase/blob/master/examples/user-management/nextjs-user-management/README.md)：独立 Auth UUID 与最小用户表思路；未复制代码/依赖。
- [PostgREST Schemas](https://docs.postgrest.org/en/stable/references/api/schemas.html)：Content-Profile 选择 exposed schema，不是隔离身份根。
- [Waffo Test Mode](https://docs.waffo.ai/features/test-mode)、[Webhooks](https://docs.waffo.ai/api-reference/webhooks)、[Authentication](https://docs.waffo.ai/api-reference/authentication)：Test/Live 数据与 API key 环境、平台共享公钥、真实 Test 回调。确认 Test 商品 ID，禁止为测试自动 publish 到生产。
- 查阅最新 Supabase changelog 及 2026-09-25 Postgres 升级说明；此草案不使用 ltree/btree_gist/legacy pgcrypto/custom operator，不执行生产检测或升级。
