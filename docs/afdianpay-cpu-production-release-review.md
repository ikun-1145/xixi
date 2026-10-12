# afdianpay CPU 事故生产发布独立审查（2026-10-12）

**FINAL VERDICT：BLOCKED_NOT_DEPLOYED。发现可复现 P1，停止生产迁移与 Worker 发布。**

候选：`7e9516ba0ec64b7746193108a6e3aab00999a86e`。本轮从实际代码、SQL、独立执行和生产只读目录建立证据，没有采纳上一轮报告结论作为通过证明。没有创建真实支付订单、改动真实权益、修改 Waffo/Cron、升级套餐或回滚数据库。

## ROOT CAUSE

旧 Worker 的 recent/history 页面处理与 retry 处理缺少统一准入，最新一页在不同通道反复进入 verified RPC。旧页面路径先释放扫描租约，再逐笔提交；订单重试到期与终态复核策略被页面路径绕过。纯 JS MD5、重复外部查询、JSON/RPC/日志增加 CPU 工作，但没有生产 profiler，不能断言某个函数是唯一 CPU 热点。

本轮实际运行旧/新 Worker 合成模型：数据库 HTTP 112→52，外部 API 12→4，订单处理 68→4。生产只读聚合存在 4 笔 activated/paid，attempt_count 为 15,834–17,456；11 笔 unresolved/paid/INTENT_NOT_FOUND，attempt_count 为 2,198–15,581。它们支持重复处理仍在发生，不证明每次 attempt 的 CPU 归因或付款应当绑定谁。

## REVIEW

### P1：扫描租约失效后，批量 RPC 仍可授权

- `workers/afdianpay/worker.js:286` 调用批量 RPC，仅传订单、来源、trace；`supabase/migrations/20261011030000_afdian_scan_admission.sql:117` 没有扫描 state/token/generation 参数。
- 批量 RPC 只检查精确订单查询租约，未检查扫描租约。业务事实与权益先提交，Worker 随后在第 296–303 行完成游标时才检查扫描 token/generation。
- `fetchWithTimeout` 在响应头返回后清除计时器（Worker 第 479–487 行）；第 148 行的 `response.json()` 不受该计时器保护。缓慢响应体可以跨越三分钟扫描租约，因此旧扫描延迟提交有实际调用路径。

两名独立审查员及主代理均用实际完整迁移、内存 PGlite、合成用户复现：

| 顺序 | 实际结果 |
|---|---|
| generation 1 持有旧 paid 页；模拟租约过期 | 旧扫描失效 |
| generation 2 提交新 unknown | unresolved / PROVIDER_VERIFICATION_REQUIRED |
| 模拟两分钟重试到期后，旧 paid 批量提交 | processed=1，activated，pro=true |
| generation 1 完成游标 | advanced=false / LEASE_FENCED |

游标拒绝已经晚于授权提交。该复现没有访问生产，没有证明真实用户已遭遇此情形。已记录 refunded/cancelled 的墓碑仍阻止旧 paid 恢复；本问题针对 unknown，不能描述成明确退款墓碑被绕过。

最小后续修复范围：批量 RPC 接收扫描 state/token/generation，并在业务处理同一事务中锁定、校验有效扫描租约；失效批次不得写付款事实。补充替代扫描先提交新事实、失效扫描随后提交旧事实的回归，以及响应体停滞路径。**本轮没有实施该修复。**

### 其他审查与测试

新订单查询 finish/fail 的订单锁、随机 token、expiry 检查与 verified 调用在同一事务内；新增 RPC 均为 SECURITY INVOKER、固定 search_path、仅 service_role 执行。未发现新增提权、错误身份绑定、重复授权、明确退款墓碑失效或 Waffo 来源隔离问题。P1 存在时，不能确认候选整体不会造成权益错误。

| 本轮实际命令/范围 | 结果 |
|---|---|
| 五文件支付专项（Worker/准入数据库/迁移/策略/UUID） | 75/75，0 跳过 |
| `AFDIAN_DOCKER_PG=true node tests/afdianpay-concurrency-lab.mjs` | PostgreSQL 16 多连接 47 项通过，自有容器已删除 |
| `node tests/afdianpay-load-comparison.mjs` | Before/After 断言通过 |
| 候选 git archive 隔离副本，串行全套 | 795/795，0 跳过 |
| 候选隔离副本，默认 `npm test` | 794/795；既有 ai-beta-diagnostics-ui 时序失败 |
| 当前 HEAD，默认及串行全套 | 均 797/799；后续 download 文案两项 i18n 回归 |
| 新增 P1 standalone 复现、语法、`git diff --check` | 通过；通过意味着准确复现候选缺陷 |

现有扫描过期测试覆盖“批次先提交、游标随后失效”，遗漏上述相反时序。旧 REST/物理崩溃实验仍拦截 `sunland_process_verified_pro_order`，未适配新 finish RPC，不能作为新路径真实 PostgREST/物理进程终止恢复证据。没有跳过、修改或抑制失败测试。

## MIGRATION

通过 `supabase db query --linked` 执行 `BEGIN READ ONLY` 的目录查询，项目限定为 `klyrasrqgxijwrxuoevj`。目录采集时间为 `2026-10-12T11:01:47.442606Z`；补充付款权威目录时间为 `11:07:04.821065Z`。

- 前置 `20261005122300` 已记账；候选 `20261011030000` 未记账，新租约表与批量 RPC 不存在。
- 9 个 reconciliation RPC 函数体与前置迁移一致；两表 29 列、12 项约束、5 个索引、RLS/service-only 策略匹配。
- 扫描补丁的 `p_state_key = 'recent'` 恰好两处，30 秒租约锚点存在，生产补丁前提成立。
- activation 两个重载与 Waffo 五个函数体匹配本地前置迁移/fixture。ACL、search_path、invoker/definer 符合预期；Waffo 五表 RLS 开启，仅 postgres 有表 ACL。
- 新 claim 有意把 unresolved 领取冷却从 20 秒改为两分钟，并增加 token/租约；签名兼容，但不能称为仅增加返回字段。

未发现直接依赖范围的生产漂移；没有执行候选迁移。正确依赖顺序仍为先数据库、后 Worker；事务中锁超时/锚点断言失败应整笔中止。混合版本期间旧 Worker 可以绕过新 wrapper，必须核验旧 invocation 排空；退回旧 Worker 不能保留新 fencing 保证。报告现有恢复说明未完成可操作的生产恢复演练，不能计为门槛通过。禁止删除新租约表、回退已承载真实订单的账本结构或盲目重放订单。

## DEPLOYMENT

Cloudflare 只读 API 核验：

- 当前部署 `f1ae0c79-b3a2-4594-be1d-957516c7d66d`，100% 版本 `457a3e69-307a-4c4c-a26e-fa1cd3c0e580`，部署时间 `2026-10-07T10:41:50.395837Z`。
- 单一 production 环境，compatibility_date=2026-09-05，usage_model=standard；版本/设置未返回显式 CPU limits。
- 身份服务绑定 ai/production、ORDERS KV、Supabase URL 和公开变量符合配置；只读取 secret 名称，没有读取或输出 secret 值。
- schedules API 仅有 `*/2 * * * *`。账户 11 个 Worker 的设置未发现指向 afdianpay 的 service binding；这不能排除直接 HTTP 调用或 Cloudflare 内部调度异常。

没有部署新版本。Worker 部署源码没有逐字核验，版本与配置一致不能替代源码一致证明。

## OBSERVATION

**本轮没有部署，因此以下均为旧生产版本基线，不能作为修复后验收。**

48 小时窗口：`2026-10-10T11:00:57Z` 至 `2026-10-12T11:00:57Z`。Cloudflare GraphQL 实际返回：

| 状态 | requests/errors | CPU P50/P95/P99 |
|---|---:|---:|
| exceededResources | 2,069 / 2,069 | 10 / 10 / 10 ms |
| success | 1,653 / 0 | 17.941 / 45.855 / 58.324 ms |

CPU 单位已通过 Cloudflare GraphQL schema introspection 确认为微秒，表中已换算为毫秒。sampleInterval 分别约 1.0132/1.0166，因此数量属于自适应采样估计；exceededResources 也不能直接等同精确 exceededCpu。不得将 2,069 宣称为最近 48 小时精确 CPU 超限次数。

临时只读 telemetry 查询及 keys 接口返回 403；subscription 接口返回 403；account entitlements 未给出 Workers CPU 配额。两次 live tail 均 ECONNRESET、无有效事件。**精确 exceededCpu 数、实际 CPU 配额是否为 10ms，以及历史每分钟/双执行的原因仍未证实。**错误分位数为 10ms 支持 CPU 配额推断，但不是套餐或实际配置证明。官方说明低 CPU 请求可能形成 rollover，成功超过 10ms 也不能反向证明配额更高。[CPU 限制与 rollover](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/)

最近 15 分钟 `10:51:42Z–11:06:42Z` 的分钟聚合，sampleInterval=1，10:52/54/56/58、11:00/02/04/06 各一次 success，符合每两分钟节奏。当前正常节奏不解释此前双执行；配置修改已远超官方最多 15 分钟传播窗口，不能以传播解释旧异常。[Cron 传播说明](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

数据库聚合时间 `11:05:23.282423Z`：recent/history 的 last_success_at 分别为 11:04:03.414245Z / 11:04:03.424725Z、next_page=1、lease_until=null；5 笔 unresolved 到期。没有完成新版本历史周期或待重试推进观测。没有触发手动 reconcile，也没有用测试改变真实付款事实。

## PAYMENT SAFETY

生产只读聚合：22 个 Pro profile；活跃 entitlement sources 为 legacy 21、other 1、waffo 1；Waffo 有一笔 granted。这是现状快照，不是本轮真实付款验收。明确的退款/取消墓碑、可信身份绑定、账户保护和来源隔离在本地实际 SQL 与生产函数定义中保留；过期扫描 P1 仍使整体支付安全门槛失败。

无真实下单、权益改动、补发、撤销、人工重放、Waffo 改动、Cron 改动或套餐升级。

## FINAL VERDICT

**BLOCKED_NOT_DEPLOYED。**未解决 P1 已足够阻断；此外精确 CPU/历史调度来源、真实新 RPC 集成/崩溃路径与恢复演练也不能计为通过。本轮交付独立审查、隔离复现和只读生产基线，未实施新的开发修复。

Git 起始为 main / `e454e5dc8c44d77e33df26dfb2f8ad11b959dfb9`，干净且唯一 worktree；候选之后两个提交仅涉及下载，无支付文件漂移。GitHub 只读查询确认候选存在，远端 main 仍指向候选。此次仅提交本文与审查证据，没有改 Worker、迁移、测试或其他 Agent 文件，也没有 push。

## 可复核证据

持久证据目录：[`production-review-20261012`](full-stack-development/requirements/afdian-worker-resource-fix/06-verification/evidence/production-review-20261012/)。目录 JSON 包含本轮实际查询结果、签名/ACL/定义摘要及复现输出，不包含密钥或真实订单/终端用户标识。完整生产函数定义的临时只读副本留在 `/tmp/afdianpay-production-review-20261012/`，未写入 Git。

从仓库根目录复现候选缺陷（内存合成数据库，无网络/生产访问）：

```sh
AFDIAN_PGLITE_PATH=/tmp/afdian-admission-db/node_modules/@electric-sql/pglite/dist/index.js node docs/full-stack-development/requirements/afdian-worker-resource-fix/06-verification/evidence/production-review-20261012/stale-scan-repro.mjs
```

该依赖已在本机存在，没有新增项目依赖。断言检查的是缺陷确实存在；不能将脚本 exit=0 当成候选安全通过。完整 QA 日志位于 `/tmp/afdianpay-qa-{focused,concurrency,load,npm,serial,candidate-npm,candidate-serial,i18n-focused}.log`。
