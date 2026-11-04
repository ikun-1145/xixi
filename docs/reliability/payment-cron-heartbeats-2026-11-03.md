# 支付 Cron 业务心跳（候选代码，暂不上线）

> 本文档记录 **Draft PR** 中准备加入的业务可观测性信号。本 PR 不修改实际生产环境，不部署 Worker，不读写真实账单，也不会将密钥上传 GitHub。

## 为什么要做

Cloudflare Workers 的 `scheduled` 调用完成不等于成功完成支付业务。2026-11-03 的只读审计发现：

- 在 2026-11-02T04:00Z 至 2026-11-03T04:00Z，爱发电 Worker 的 HTTP 5xx 为 0，但结构化日志存在两条 `scan_failed`。
- 两条失败同在 2026-11-03T02:22:36Z，分别涉及 `cron_recent` 与 `cron_history`。
- 更早一条诊断标记 `provider_query_diagnostic(stage=fetch,reason_code=TIMEOUT)`，说明很可能是共享的单次上游请求超时影响了两条扫描通道。
- Waffo 已有异常日志，但过去的 Cron 没有一个能够区分“功能关闭、无订单、正常处理、部分处理失败”的完成信号。

## 代码变化

### 爱发电

在 `workers/afdianpay/worker.js` 的现有 `RECONCILIATION_INCOMPLETE` 错误检查**之后**，新增固定事件：

```json
{"event":"reconciliation_cycle_outcome","status":"no_observed_failure","rejected_tasks":0,"deferred_lanes":0,"retry_failures":0}
```

任务结束时记录结构化状态：`failed`（未捕获任务失败）、`partial_failure`（内部捕获的重试失败）、`deferred`（扫描租约被占用等情况）、`no_observed_failure`（没有观察到这些失败）。**最后一个状态不表示订单全部处理成功**：重试通道返回空数组，也可能是重试租约被其他执行占用。原有异常传播、租约、分页及支付权益逻辑不变。

### Waffo

`reconcileProductionOutbox` 仍使用完全相同的 D1 查询及 `processProductionEvent` 处理路径，但额外返回**非敏感汇总结果**：`status` 为 `disabled`、`completed` 或 `incomplete`，并携带 `due`、`processed`、`failed`、`unbound` 数量。

`scheduled` 的现有 `waitUntil` 观察这份汇总，发出：

```json
{"event":"waffo_production_outbox_cycle","status":"completed","due":0,"processed":0,"failed":0,"unbound":0}
```

`disabled` 不能算作成功；`incomplete` 标示至少一条待处理数据未完成（含未找到 intent），不能算作成功。上层异常仍沿用 `waffo_production_outbox_unavailable`，并非所有错误都转为“成功”。

**只记录状态和整数计数；不记录订单号、支付 ID、邮箱、用户身份、D1 原始数据、Webhook 内容、模型/支付密钥或异常堆栈。**

## 验证与上线门禁

- 在 Mock D1 和不含真实凭据的环境中覆盖未配置、空任务、未绑定 intent、无效待处理记录、事件脱敏、Waffo scheduled 结构化输出以及爱发电的失败门禁顺序。
- 全量运行仓库的 `npm test` 与相关 JS 语法检查。
- 在将来准备部署前，必须**先比较仓库源码与线上 Worker 当前构建版本及绑定**，确认可重复构建、回滚目标和密钥来源。
- 发布需要新的明确批准。不应将“合并 GitHub PR”等同于“支付 Worker 已安全发布”。
- **当前只增加诊断信号，不改变任何付款、退款、资格、金额、订单持久化、重试或实际权益开通策略。**

## 对应只读观测

配套的 [Draft PR #33](https://github.com/ikun-1145/xixi/pull/33) 提供只读聚合指标工具。该工具目前尚不能解析本 PR 的新事件；必须在本 PR 验收通过并具备实际生产日志后，再增量扩展其事件白名单，不能提前宣称生产已经有业务成功心跳。
