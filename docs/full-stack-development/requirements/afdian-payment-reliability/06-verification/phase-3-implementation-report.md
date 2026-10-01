# Phase 3 Implementation Report：爱发电付款与 Pro 激活可靠性

报告日期：2026-09-30（Asia/Shanghai）。结论：**READY FOR PHASE 4 REVIEW**，仅表示本地候选具备进入生产准备评审的证据；**不表示可以部署、迁移生产数据库或补发真实订单**。全部支付、用户和身份测试数据均为隔离实验合成数据。本轮没有生产写入、部署、提交或推送。实际受影响用户的订单号、付款时间、平台事实仍未取得，因此不将本地复现等同于该用户事故的最终归因。

## 1. Baseline 与并发工作区

开始与结束的 `main` HEAD 都是 `c1dbad9893a3a2d8a5f5ad3f3f5e98d89476bdb2`。开始时 `git status --short` 仅显示 Phase 2 文档目录未跟踪；原有文件未被其他 Agent 意外改写。本轮没有使用 reset、restore、clean、stash、广泛暂存或提交。实验开始和结束的目标文件哈希相同，逐项见 [destructive-start.json](evidence/destructive-start.json) 与 [destructive-end.json](evidence/destructive-end.json)；初始哈希见 [starting-workspace.json](evidence/starting-workspace.json)。本任务各 Agent 的有计划修改已在重测前合入工作区，不计作意外漂移。`/Users/liuxize/sunland_ai_app` 既有 macOS、`Podfile.lock`、聊天相关脏改动均原样保留，本任务未编辑该仓库。

生产 Worker 的既有只读基线：源码提交 `32d0d58f9df2ffa09a75c440fd0bb82d4dbb8d6c`，线上版本 `13442a1f-4dce-4590-87b3-fcff297c203a`，bundle SHA-256 `61d2fdce390777cc7a53dda855b3c1cc69871eef49e6671cf9e5d1638d9b1d69`。这**不是**本轮候选的生产验证。本轮候选 Worker 源码 SHA-256 `3cb2ba3dd97c73e5a1da6f5e2688c1d21a7874320499d2fe095d8a11812a1d54`，`wrangler deploy --dry-run` 产物 SHA-256 `0dcad865132322cf731f74b7951a54d4a472e50a8ac6a03a7c87aef2fce197a0`。新 migration SHA-256 `13b39c0530e87390454c91aabfceb97194e0f1c0fec1c082ee59a76815473400`。完整候选文件哈希见 [源文件清单](candidate-source-manifest.json)，实验文件哈希见 [证据清单](evidence/sha256-manifest.json)。

先在原 main Worker 上运行真实 UUID 的 `custom_order_id` 回归，得到 `legacy !== intent` 红灯；只整合 UUID→intent 分类语义后绿灯。见 [红灯](evidence/uuid-red.log)、[绿灯](evidence/uuid-green.log)。没有合并整条 `claude/ghost-account-bug-in-login-registration-ecfeea` 分支。生产 catalog 于实施前重新只读抓取，包含 28 个函数、45 列、72 项 grant、3 项 RLS 标记、7 条 policy、2 个触发器与 12 个约束；完整源快照保存在本机 `/tmp/sunland-payment-phase3/production-catalog.json`（未写入仓库）。发现真正的手工函数名是 `sunland_resolve_pro_payment(text,text)`，不是 Phase 2 文档的 `..._order`；候选按实际签名处理。生产完整 `sunland_delete_account_business_data` 函数体及 account deletion guardrails 用于新 migration，未把旧 9 月 5 日函数覆盖到线上。触发器的生产 ACL 也单独核对后在 lab 中对齐。

## 2. Design Changes 与文件

Phase 2 的 Design A 只存 `paid + INTENT_NOT_FOUND`；当 intent 后来出现而爱发电查询暂不可用时，无法继续。Design B 持久保存**首次可信查询**得到的 `verified_binding_reference` 与 `binding_reference_verified_at`，同一已验证快照在 15 分钟内可重新解析本地 intent/profile；超时必须重新查询平台。隔离实验先付费、后出现 intent、期间 provider 不可用，B 在不增加 provider 请求的情况下激活；见 `I-Design-B-provider-offline`。这不是平台保证 15 分钟内不会退款的证明。引用只能由 service-role v2 事务写入；旧 webhook/RPC 不能设置。首个可信引用固定，后续矛盾记 `BINDING_CONFLICT`，绝不重绑；注销在删 intent 前清引用与时间，不保存完整平台 payload。PII 留存仅增一份引用和时间，注销/匿名化实验验证清除。其余 Phase 2 复杂配额/lane 字段暂缓，使用持久 lease、cursor、共享 provider backoff、订单原子 claim 和每次最多 8 单处理。

| 文件 | 本轮变化 |
| --- | --- |
| `workers/afdianpay/worker.js` | 唯一 provider 查询/验证管线；Webhook 只取已验签订单号为线索；recent/history/known retry；用户 reconciliation；结构化 trace；保留原有签名兼容协议。 |
| `supabase/migrations/20260929104134_verified_pro_payment_reconciliation.sql` | 独立付款事实、固定引用、事务 v2、持久队列/游标、旧 RPC 防旁路、实际手工入口防旁路、注销清理。 |
| `ai/pro-payment.js`、`ai/app.js` | 共享 UNKNOWN/FREE/PRO、身份 epoch、异步请求代际、有限自动检查与冷却；临时读取失败不误降级。 |
| `ai.html`、`ai_settings.html` | 两处购买入口和设置卡片接入共享状态；提供手动检查，处理账户切换/旧响应；现有布局不重做。 |
| `p/js/site-i18n-extra.js` | 新静态按钮七行六语言翻译；属于完成页面一致性所需的最小范围扩展。 |
| `tests/afdianpay-*.test.mjs`、`tests/afdianpay-lab.py`、`tests/pro-payment-*.test.mjs` | 可信事实、UUID、真实 HTTP/PG、权限、并发、崩溃和前端时序验证。旧测试中把未验证 webhook 字段、KV 游标和旧 RPC 直接授予当作正确行为的断言，改为新信任边界断言。 |

与 Phase 2 的另外两项差异：Webhook **线索成功持久化且重试状态可用时**，精确查询暂败返回 200，避免平台重复通知风暴；线索未持久化或重试记录失败返回 503。分页在整页 ID 已持久化并由 DB fencing 验证后即推进游标，随后只处理有界 8 单；未处理 ID 留在 due 队列，不让慢处理使租约过期后卡死页面。这两项依赖持久 hints/queue，已在 HTTP/PG 实验中验证。旧 `ORDERS` KV binding 未删除但新正确性不依赖它。

## 3. Migration、兼容与信任路径

`pro_payment_orders` 新增 `payment_status`（unknown/paid/refunded/cancelled）、`last_verified_at`、`next_retry_at` 和一对可空 verified reference/时间；旧订单初始为 unknown，原 `status` 枚举保持。`pro_payment_reconciliation_state` 只存 recent/history/retry/provider 四类调度行与 `next_page`、`cycle_id`、`lease_token`/期限、`generation`、成功时间和全局 provider backoff，不存权益或第二份付款账本。新增 due 部分索引与 verified reference 部分索引。旧 intents、profiles、orders 形状及现有前端合同保持；旧 unresolved 排入可信复验，activated/ineligible 不自动重开。

新 `sunland_process_verified_pro_order(jsonb,text,uuid,boolean)` 为固定 search_path 的 `SECURITY INVOKER`，撤销 PUBLIC/anon/authenticated 执行，仅 service_role 可执行。数据库再次验证订单 ID、状态、商品、整数分、币种、绑定和 active 身份；先取订单 advisory transaction lock，再读 ledger、候选归属和 `profile FOR UPDATE`，重新核对 intent/身份/账本，最后在**同一事务**写账本、`profile.pro=true`、intent activated。已激活归属不变；退款只更新付款事实，可表达 `payment_status=refunded,status=activated`，不自动撤销可能来自其它来源的 Pro。因缺 intent/暂时故障的 unresolved 可再次处理；退休、注销、匿名化、冲突与已消费历史付款保持阻断。`pro_activations(source='payment',order_id)` 的旧记录仍是已消费归属证据，不因 profile 当前为 false 而重复授予。

新 hint、精确查询 claim、失败记录、backoff、扫描 claim/complete/release RPC 及调度表也仅 service_role 可写/执行；普通角色实测不能读全局账本、改 Pro 或调用新 RPC。新表启用 RLS，并有 service_role 策略。原 `sunland_get_or_create_pro_payment_intent` 的认证/active guard、原账户删除的业务清理步骤、既有 profile 字段权限均保留。旧六参数、二参数付款 RPC 与实际手工入口保留签名和幂等返回，但不再凭未经查询的调用直接授予；未激活时只提供 verification-required/hint。新 migration 在隔离空库应用成功，**未在生产应用**。

| 处理类 | 典型原因与行为 |
| --- | --- |
| retryable | `PROVIDER_VERIFICATION_REQUIRED`、`PROVIDER_QUERY_FAILED`、`INTENT_NOT_FOUND`、`USER_NOT_FOUND`；保留已确认事实，设置下一次查询/本地重试时间。 |
| blocked | `ACCOUNT_DELETING`、`ACCOUNT_RETIRED`、`OWNER_ANONYMIZED`、`DATA_DELETED`、`INVALID_BINDING`、`BINDING_CONFLICT`、`PROVIDER_FACT_CONFLICT`、`AMOUNT_MISMATCH`、`HISTORICAL_PAYMENT_ACTIVATION`；不自动猜归属或再授予。 |
| terminal | 合格且已激活、已确认非目标商品、已确认退款/取消的未激活付款；账本 `status` 与付款轴分离，已激活退款仍保留 activated。 |

`PROVIDER_QUERY_FAILED` 是查询失败/零匹配/不合约响应的可重试业务状态，不能写成永久的 `PROVIDER_FACT_CONFLICT`。后者仅用于**已有可信事实**之后遇到计划/金额矛盾。新调用的 `attempt_count`、处理 source、trace、前后状态和理由由 v2 返回或 Worker 结构化日志记录；不输出密钥或完整付款 payload。

信任链：`RSA webhook/order ID、Cron 或手工线索 → 固定 HTTPS query-order + 服务端凭据签名 → HTTP/ec/schema/精确唯一 order_id → 共享 provider policy → service-only v2 → 事务原子授予`。未签名的 webhook `custom_order_id/remark/status/amount/product` 不参与授予。查询零匹配、重复匹配、schema/网络失败排队重试；金额只接收十进制字符串并转整数分，拒绝指数、过长精度、负数和溢出；固定 CNY 商户/方案契约，显式外币拒绝。官方尚未确认的数字退款枚举记 unknown 而不猜测。`POST /payment/reconcile` 只接受空对象，经现有 `/v1/account/identity` 验证 Bearer，调用方不能指定 user/order/paid/amount，响应是 membership + payment_sync + retry_after_seconds，读取故障为 unknown。前端显示不授予权益。

| Pro Grant Surface（生产 catalog + 代码） | 调用者 | 可授予？ | 与可信支付路径的关系 |
| --- | --- | --- | --- |
| 新 v2 付款 RPC | service_role | 是，受事务条件限制 | 唯一候选支付授权入口；Worker 必须先 query-order。 |
| 旧六参数、二参数付款 RPC、实际 `sunland_resolve_pro_payment` | service_role | 新候选中否；已激活可幂等返回 | 原有形状保留，未验证输入不能授予。 |
| `sunland_claim_activation_code` | 当前生产仅 postgres 有 EXECUTE；网站入口 410 | 数据库函数自身有独立合法 Pro 逻辑 | 不属于付款，保持既有禁用/权限状态，未替它发布新入口。 |
| 管理员赠送/人工修改 | 可信管理员或持 service/postgres 凭据者 | 高权限主体在技术上可直接写 | 本地 Worker 无对应 mutation route；外部管理系统端到端未在本轮验证，不能宣称被本补丁封闭。 |
| 普通 authenticated profile 客户端 | authenticated | 否 | 仅有已有头像/名字列 UPDATE；Pro 列 UPDATE 与 INSERT 实测拒绝。 |
| 注销清理与 sanitize | 服务端删除流程 | 只能清为 false | 合法删除，不是支付授予。 |

service_role/postgres 是信任边界：拥有高权限密钥者可直接写表，数据库 ACL 不能抵御该密钥被攻破。支付路径“只有 v2”指**此候选 Worker 和保留的付款 RPC**，不扩大为所有高权限操作者的密码学保证。

## 4. PostgreSQL 并发与隔离权限

独立数据库 `sunland_payment_phase3_lab` 使用本机 PostgreSQL 17.6；初始空 payment 表、schema-only 克隆、只读生产完整函数/ACL overlay，未复制任何客户行。PostgREST 为仅连接该 lab 的独立本机容器/端口 54329。测试连接逐个核对 `current_database()`、`application_name=sunland-payment-phase3:*` 和注册的 backend PID；只终止归自己测试注册的 lab 进程。lab 专用 pause 函数/触发器**不属于候选 migration**。每组 PG-1～PG-12 皆有 A/B 两个真实 session，B 等待时采集 `pg_locks` 和 `pg_stat_activity`，再检查 RPC、前后订单/profile/intent 行及交错时间线；完整逐行证据见 [pg-lab-results.json](evidence/pg-lab-results.json)。JSON 中 `session_A_timeline` 是包含 A、B 事件的合并时间线，按键 `A`/`B` 区分；并非只有 A 的记录。

| 实验 | 实际结果 |
| --- | --- |
| PG-1 同订单同用户 | 两 session 串行完成，单一 ledger/owner、Pro=true、intent activated。 |
| PG-2 同订单不同候选用户 | 首次合法 owner 固定；第二次返回 `BINDING_CONFLICT`，B 的 Pro=false、intent pending。 |
| PG-3 webhook 与 Cron | 同订单锁等待，幂等激活。 |
| PG-4 webhook 与人工查询 | 同订单锁等待，幂等激活。 |
| PG-5 双 Cron | 同订单锁等待，幂等激活。 |
| PG-6 不同订单同用户 | 同一 profile 行锁串行，两个 ledger 激活且一个 Pro。 |
| PG-7 付款先于删除 | 删除在付款锁后执行，最终 retired、Pro=false，订单 owner/reference 清空，状态保留历史 activated。 |
| PG-8 删除先于付款 | 后到付款被 `ACCOUNT_RETIRED` 阻断，无重新授予。 |
| PG-9 绕过删除前置 guard | 正常 active profile 上调用业务清理返回真实 SQLSTATE `42501`，数据不变。 |
| PG-10 旧 RPC 与 v2 并发 | 旧入口只记录 unresolved 线索；v2 再经可信事实激活。 |
| PG-11 已匿名化订单重复尝试 | 两次均不重绑，owner/reference 仍空、退休 profile=false；既有 activated 账本保持。 |
| PG-12 候选绑定与删除竞争 | 删除先清关联引用/intent；等待中的 v2 复核后返回 `DATA_DELETED`，不授予/不重绑。 |

另外，真实 `anon` 与 `authenticated` 角色不能执行 v2/scan 各 overload、读 ledger/state 或修改/插入 Pro；service_role 可按策略处理。真实 PostgREST JWT 的 anon/authenticated v2 请求亦拒绝。12 个并发 signed replay 只能取得 1 次精确 provider 查询 claim；12 个并发用户 reconciliation 只触发 1 次 recent 请求。证据分别在 [PG](evidence/pg-lab-results.json) 与 [REST](evidence/rest-lab-results.json)。

## 5. 八点 Crash 与 COMMIT unknown

所有 crash 都先持久化 synthetic hint，并在中止后检查 ledger/profile/intent，最后用相同 order ID 恢复。第 1、2 点还真正 SIGKILL 了自有 Node Worker 子进程，见 [物理进程证据](evidence/worker-physical-crash-results.json)；第 3～8 点通过**仅安装在 lab 的** PostgreSQL pause hook/触发器和已登记 PID 中止会话，非生产 Worker 物理进程。完整前后行、活动状态、中止记录、恢复 RPC 在 [PG 证据](evidence/pg-lab-results.json)。这些是隔离故障注入，不是 Cloudflare/真实平台故障验证。

| 点 | 故障位置 | 中止后观察 / 恢复 |
| --- | --- | --- |
| 1 | provider 查询前 | unknown/unresolved、Pro=false；重启精确查询后同事务激活。 |
| 2 | provider 查询后、v2 前 | 同上；已查询的内存事实不作持久付款证明。 |
| 3 | BEGIN 后锁前 | DB 回滚；同订单重试激活。 |
| 4 | 订单锁后 | DB 回滚；锁释放，同订单重试激活。 |
| 5 | ledger 写入后 | ledger 写入回滚、Pro=false；重试三处一起激活。 |
| 6 | `profile.pro=true` 后 | grant 回滚、ledger 未激活；重试三处一起激活。 |
| 7 | activated 写入后、COMMIT 前 | 三处全部回滚；重试三处一起激活。 |
| 8 | COMMIT 后、HTTP 回包前 | 三处均已提交；重试只得幂等结果。 |

另用本机 TCP 代理构造“客户端确实发送 COMMIT，连接断开”：一种将 COMMIT 转发给 PG、丢回包，数据库已提交；另一种在转发前断开，数据库回滚。两者调用方都收到不确定结果，下一次按同一 ID 的权威行状态重试；没有猜测提交成败或换 ID/owner。真实 Worker/PostgREST 还模拟成功提交后丢失 RPC 响应，Worker 重试返回 `already_processed`。这分别是 [PG `COMMIT-UNKNOWN-*`](evidence/pg-lab-results.json) 与 [REST `REST-Worker-commit-response-lost-*`](evidence/rest-lab-results.json)。

## 6. 前端、回归、构建与人工检查

共享模块以 `identityVersion`、credential epoch、`requestGeneration` 拒绝旧响应，测试覆盖 A→B→A 同 ID ABA、旧支付窗口、当前身份失效与旧身份失效。成功 true→PRO、false→FREE；同身份临时故障保留 PRO/FREE 并 stale；无历史为 UNKNOWN；logout/换身份为 UNKNOWN；明确 `PRO_REQUIRED` 才合法 FREE。`ACCOUNT_NOT_ACTIVE` 当前身份清 token cache/回 UNKNOWN，普通临时 403 不把旧 PRO 降 Free。设置页 Pro 卡在资料 503 后保持可见，确认 Free 时恢复购买卡。自动检查最多 5 次/10 分钟，手动/焦点/自动共用冷却，`Retry-After` 整数秒优先；模块的可选 10 分钟支持提醒回调独立且一次性，页面沿用现有静态申诉链接而未接入弹窗。页面关闭、换设备时已持久的 hint/扫描/重试仍在服务端，**不依赖 localStorage 存续**。六语言按钮和共享文案一致。

基线从不可变 HEAD 归档运行：**364/364**；最终 `npm test -- --test-concurrency=1`：**411/411**；其中 provider/Worker/SQL 静态 **37/37**、前端定向 **37/37**。真实隔离 PG/ACL/并发/crash/commit unknown 共 **40/40** 记录；真实 PostgREST/Worker **10/10**，另真实 Node Worker SIGKILL **2/2**。UUID/策略/前端关键用例保留先红后绿记录。原测试为安全行为变更而更新，不将伪造 webhook 可授权、旧 RPC 可授予或 KV 当作正确性。日志见 [基线](evidence/baseline-head-tests.log)、[最终](evidence/full-regression-final.log)、[定向 Worker](evidence/unit-provider.log)、[定向前端](evidence/frontend-final.log)、[PG](evidence/pg-lab.log)、[REST](evidence/rest-lab.log)。`git diff --check`、相关 JS/HTML inline 语法及 Python 语法通过；Wrangler 4.103.0 的 `deploy --dry-run` 成功，未上传，见 [构建日志](evidence/worker-build-final.log)。仓库没有独立根 `build` 脚本。

本机 Edge 浏览器合成路由检查设置页 1280×900 / 390×844 各 PRO/FREE/UNKNOWN，共 6 组，无横向溢出；PRO 场景再使 profile 请求 503，状态仍为 PRO。截图：[桌面 Pro](evidence/settings-1280-pro.png)、[桌面 Free](evidence/settings-1280-free.png)、[桌面 Unknown](evidence/settings-1280-unknown.png)、[移动 Pro](evidence/settings-390-pro.png)、[移动 Free](evidence/settings-390-free.png)、[移动 Unknown](evidence/settings-390-unknown.png)；机器可读结果见 [browser-results.json](evidence/browser-results.json)。浏览器控制台存在 `Supabase browser runtime is unavailable`；同一错误在不可变 HEAD 基线浏览器探针中复现，属于既有问题，不能宣称页面无错误或真实登录设备验收通过。未做真实 OAuth、真实客户支付、真实设备、线上功能或发布验证。

## 7. R1～R10 通过范围

| 要求 | 本轮证据 / 范围 |
| --- | --- |
| R1 | 合法 active owner、可信合格 paid 的新订单，ledger/intent/profile 同事务激活：真实 Worker→REST→PG 和 crash 回滚；不涵盖历史已消费/退休/缺失 owner 的自动重授。 |
| R2 | 同 ID 重放与 COMMIT unknown 只产生一笔逻辑激活；PG-1/3～5 与 REST 已核验。 |
| R3 | 同订单异用户 PG-2 固定第一个可信引用，第二个冲突不重绑；正确性仍依赖平台最初映射事实。 |
| R4 | unresolved 经 provider 恢复或 15 分钟可信缓存可续处理；设计 B 与 REST 零匹配后恢复。 |
| R5 | history 两轮实际顺序 `1,2,3,4,1,2,3,4`；第 3 页失败是 `1,2,3,3,4`。 |
| R6 | REST 使用 RSA 有效但篡改未签名字段的 webhook，最终 owner/商品取主动查询，不取回调字段。 |
| R7 | 前端临时数据库/身份 503 保留 UNKNOWN 或 stale/PRO，设置浏览器实测。 |
| R8 | 服务端 hint、due 队列和 cursor 持久，不依赖浏览器 pending；真实 Worker 进程中止恢复。 |
| R9 | 旧 6/2 参数及实际 manual 函数直接调用无未经 provider 的 Pro 授予；真实角色 ACL。 |
| R10 | PG-7/8/9/11/12 删除竞争、拒绝绕过与引用清理后不复活。 |

## 8. G1～G10 不变量判定

| 不变量 | 判定 | 证据与条件 |
| --- | --- | --- |
| G1 已验证合格付款最终 Pro | **CONDITIONAL** | 新合法 active owner 的原子 grant、缓存恢复已证；需平台事实稳定、映射存续、基础设施恢复与持续公平重试。 |
| G2 webhook 永久丢失仍可发现 | **CONDITIONAL** | recent/history/user 共享扫描已测；无平台留存/稳定分页保证，不能承诺所有订单。 |
| G3 Cron 暂停后可续 | **CONDITIONAL** | PG cursor、lease、fencing 与 3 页失败不跳页通过；长停机后订单保留未知。 |
| G4 Supabase 暂时失败 | **CONDITIONAL** | 已持久 hint/retry 可恢复；完全宕机时无法写 hint，只能依赖通知重投和平台扫描。 |
| G5 任意 crash 不破坏已入账原子性 | **CONDITIONAL** | 8 点、实际 Worker SIGKILL、COMMIT unknown 通过；首次线索入库前崩溃仍受 G2 限制。 |
| G6 等价重复只激活一次 | **PASS** | PG/REST 重放、订单锁、唯一账本、幂等 D；范围是可信服务路径。 |
| G7 同订单不同绑定最多一人 | **PASS** | PG-2/12；仅证明不会二次重绑，首次平台映射正确性属于 G1 条件。 |
| G8 Activated 不倒退 | **PASS** | 退款独立于权益，已激活不会重开授予；合法注销可清全局 Pro。 |
| G9 读取失败不误降级 | **PASS** | 前端三态、ABA、503、浏览器卡片检查；明确服务端拒绝可改变状态。 |
| G10 UI 不能越权开启所有 Pro 功能 | **FAIL** | 此支付 RPC/Pro 模型路径有服务端校验；外部 `api.sunland.dev` 的 `deep=true` gate 仍缺独立修复与实测。 |

## 9. Remaining Risks 与 Phase 4 评审条件

1. 爱发电历史订单留存、非快照分页位移、订单重排/消失、商户 API 速率和实际流量容量未被平台合同证明。固定每次 8 单与 2 分钟 Cron 在极端增长下可能追不上；需在 Phase 4 取得官方限制、制定监控/告警和容量接受界限。示例查询端点、`status=2` 与 `product_type=0` 合同参照[爱发电开发者指南](https://guide.afdian.com/creator/developer)；数字退款枚举尚未确认。平台若改变 metadata，首次已验证引用保持固定并进入冲突审查，不能静默更正 owner。
2. `currency` 缺省时采用固定 CNY 商户/方案契约；显式其它币种拒绝。这要求上线前确认当前商户实际结算与 API 字段行为。query-order 完成至 DB COMMIT 之间没有跨平台事务；退款/metadata 在这段时间变化无法以本地锁消除。退款后不自动撤销多来源 Pro，属于明确的后续权益来源建模工作。
3. 真实“已付款但未激活”的客户 order ID/时间、平台 query-order 响应、线上 trace 尚缺；当前候选解决已确认的本地恢复缺陷，不证明每个历史用户能自动补发。上线前需要按具体订单只读核对，不可拿 pending intent 当付款证据。
4. 外部 `deep=true` 服务端权益门仍未独立修复/验收，G10 为 FAIL。`/Users/liuxize/sunland_ai_app` 有其他未提交修改；本轮仅定位外部 canonical `worker/src/index.js` 相关 gate，不覆盖他人代码。外部管理赠送链路亦未做端到端验收。
5. 发布顺序/回滚必须专项评审：先部署 schema 和服务端兼容路径、验证权限/函数指纹，再考虑 Worker 与网页；旧 Worker 对新 migration 只可视为收集线索，不能当完整业务回滚。需再核对生产 catalog 漂移、密钥**名称**/binding、真实部署版本、运行监控与安全回滚候选。当前没有任何生产授权。

独立 QA 和安全审查对最终候选未发现尚未修复的本地 P1 阻断；两类审查无法替代生产验证。自动 full-stack lifecycle MCP gate 未提供可调用工具，已按其规范生成手工证据报告，**不声称自动门禁通过**。Phase 4 应以本报告的 CONDITIONAL/FAIL 为审查输入；只有独立解决发布阻断并获新的明确授权后，才能考虑生产变更。
