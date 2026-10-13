# Afdian CPU incident: fenced candidate and conditional release

## ROOT CAUSE

上一候选先提交页内付款事实，再验证扫描游标租约。批量 RPC 没有扫描凭证，失效 generation 能写入旧 paid，甚至授权 Pro。HTTP 超时只覆盖响应头，停滞响应体还能使任务超过租约。

原 Worker 的重复核验/小批量回查造成高请求及处理量；请求计数只用于负载比较，不作为 Cloudflare CPU 证明。

## P1 FIX / TRANSACTION SAFETY

- 新 batch 参数为既有三项加 `p_scan_state_key`, `p_scan_token`, `p_scan_generation`。
- 扫描行先 `FOR UPDATE`，取得锁后验证 lane/source、token、generation、`clock_timestamp()`；订单锁取得后以及全部业务写入后复验。过期抛 `55000`，位于逐订单 `22023` 隔离之外，整批回滚。
- complete 同样先锁行再验证时间；finish 在业务锁等待后复验订单租约，过期回滚。
- 原 verified 业务正文原样移入 `afdian_private`，撤销 service/普通角色的直接访问。旧公开签名固定失败关闭。只有两个仅 service_role 的 SECURITY DEFINER 包装能够进入原业务；固定 search_path，输入校验、显式 schema 引用，无动态业务 SQL。其他 RPC 保持 INVOKER。
- `last_verified_at` 使用业务等待后的数据库接受时间；早领取扫描不能覆盖领取以后已核验的订单。scheduled 在两条 lane 都完成领取以后才开始共享 API 请求，保留共享查询优化。
- 扫描资格、官方 API 事实权威性、数据库接受顺序是三种保证。没有 provider 版本号，不能宣称推断任意跨请求事实的新鲜度；退款墓碑、绑定冲突与原幂等规则保持。
- 完整 body 读取受同一 AbortSignal/计时器保护。429/408/5xx 不读取无需使用的 body，保留原状态分类和共享退避。

真实 PostgREST 控制实验揭示 `40001` 的服务端序列化重试：2,006ms 超时内 sequence 增长 10,189 次；`55000` 对照仅一次。因此租约失效使用 `55000`，Worker HTTP 500 沿原策略最多三次重试同一凭证。

## TEST RESULTS

- PostgreSQL 16.15 独立多连接：86 checks，通过。覆盖原 P1、四类锁等待过期、批次尾部全回滚、接受时间排序、重复 Cron、退款墓碑、实际 Waffo 来源与权限隔离。
- PostgREST 14.14 真实 HTTP：15 cases，通过。六参数 batch、finish、旧入口拒绝、失效 batch 无残留 active RPC；历史 12 hints→8 batch+4 due retry，三并发 Cron 仅 12 次唯一授权；响应体真实停滞约 8,009ms 后 socket 关闭。
- 物理 SIGKILL：3 cases，通过。查询前、查询后/finish 前、数据库提交后响应丢失；租约有效时不能重新查，到期后恢复且只授权一次。
- 付款 Worker/Waffo/PGlite focused suite：344/344，无跳过；原生 Node HTTP body 取消与 429 退避单独覆盖。
- `npm test` 已执行；全仓 serial 811/813，通过的付款测试不受两项既存 site-i18n 下载文案失败影响。默认并行另有既存设置测试竞态，未修改或隐藏。
- 同模型保持 DB HTTP 112→52、外部 API 12→4、订单处理68→4。稳定12单×4次的 PostgreSQL server clock：17.858ms→5.004ms；包含 SQL/锁时间，排除客户端及网络，不等于 Worker CPU。Node surrogate CPU、HTTP 次数、真实 SQL 时间和生产 CPU 独立记录。

证据目录：`docs/full-stack-development/requirements/afdian-worker-resource-fix/06-verification/evidence/fencing-fix-20261013/`。实验均为自有随机 owner 标记、tmpfs 和隔离 Docker 网络；没有生产凭据，清理前检查所有权。

## MIGRATION / DEPLOYMENT

2026-10-13 00:01:30 UTC 新生产目录与前轮基线一致：两表29列、12约束、5索引、2策略、12付款函数、12迁移记录；Waffo/activation 业务定义独立比对一致。当前候选迁移未应用。

发布顺序：记录基线 → 精确暂停旧 verified EXECUTE → 只读确认旧相关 SQL 排空 → 单事务应用候选及迁移历史 → 目录/ACL/旧入口拒绝核验 → 维护 Worker → 核验版本/绑定/Cron/完整维护闸 → 开放新 Worker → 仅观察正常扫描/补偿。

恢复演练验证：迁移内注入失败回滚全部 DDL和历史，保留事先暂停的权限；成功后保留原业务正文、Waffo 及永久旧入口关闭。已承载订单的结构禁止逆向回滚；异常时维持维护 Worker与新 schema，前进修复，不复活旧直接付款入口。

生产执行结果及部署 ID：待记录。当前未执行生产写入。

## CPU OBSERVATION

刷新48h窗口：2026-10-11T00:03:22Z–2026-10-13T00:03:22Z。GraphQL `exceededResources` 1,719 requests/errors，sampleInterval≈1.01058；CPU P50/P95/P99=10/10/10ms。success839，CPU=24.059/55.885/62.596ms，sampleInterval≈1.02192。这是自适应采样估计，不能称为精确 exceededCpu 数量。

当前线上仍为旧 deployment `f1ae0c79-b3a2-4594-be1d-957516c7d66d`，version `457a3e69-307a-4c4c-a26e-fa1cd3c0e580`，Cron只有 `*/2 * * * *`。配置无显式 cpu_ms；订阅读取403，不能把10ms错误桶冒充套餐配额确认。历史每分钟/双执行成因未证明。

新版本指标须严格从开放部署时间开始，排除维护/旧版本窗口；观察不足只能 DEPLOYED_PENDING_OBSERVATION。

## PAYMENT SAFETY / FINAL VERDICT

未创建真实支付订单、未修改真实用户权益进行测试、未删除订单、未清空游标、未重置付款事实、未改 Waffo、未升级套餐。

当前：候选修复和隔离实验已通过，生产写入仍待最终门禁及执行证据。不得据此宣称 FIXED_AND_VERIFIED。

参考： [PostgreSQL 时间函数](https://www.postgresql.org/docs/16/functions-datetime.html)、[事务隔离](https://www.postgresql.org/docs/16/transaction-iso.html)、[Cloudflare CPU limits](https://developers.cloudflare.com/workers/platform/limits/)、[采样指标](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/)。
