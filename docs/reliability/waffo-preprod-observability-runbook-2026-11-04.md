# Waffo 隔离预发布 Gateway：一次性、可观测的云端健康排障

> 2026-11-04。仅用于 Draft PR #35 的非生产验收。**不是生产发布许可**。
> 本文定义下一次测试执行规范，不代表下一轮云端 E2E 已经执行或通过。
> 当前确认的状态：原 Waffo 测试 Worker、Mock 已恢复已审版本；无临时公网入口；生产 **NO-GO**。

## 1. 已知证据与未解决的问题

- Cloudflare Access 登录已获服务器审计允许（`allowed=true`）。
- 先后在 hostname- 和 Worker-scoped Access 下，用户 GET `/__preprod/health` 均得到 `{"ok":false}`。即使部署了按**精确健康路径**暴露有限原因的诊断版本，前端仍未拿到 `reason`。
- 当时临时 Gateway 的 Workers Logs 与 Traces 均未开启，缺少请求实际落入哪一个 Gateway 分支、HTTP 状态码、Cloudflare Worker 运行错误的证据。Cloudflare 的 Access 认证日志不能代替 Workers 执行日志。
- 可能的分支包括：不完全一致的路径 / 查询参数 / 方法、Access 运行时身份对象不符、内部 Token 拒绝、私有 Worker 自身就绪失败、上游响应不符。**尚不能认定根因**。
- PR #35 增加了 `traceProbe(request,env,stage,status)`，在显式设置 `WAFFO_PREPROD_DIAGNOSTICS_ENABLED=true` 时，对全部关键成功 / 失败分支记录一个**固定阶段**和安全分桶；具体的响应仍按现有安全策略拒绝，未弱化任何身份校验。

## 2. 可观测性隐私约束

唯一允许在自定义 `console.info` 阶段日志出现的字段：

```json
{
  "schema": 1,
  "stage": "route_rejected",
  "status": 404,
  "route": "health",
  "method": "GET",
  "extraParams": true
}
```

- `stage` 来自源代码固定枚举；`status` 为网关对外 HTTP 状态。
- `route` 仅可为 `health/webhook/cron/other/invalid`；`method` 仅为 `GET/POST/OTHER`；`extraParams` 为布尔。
- **禁止输出**真实 URL、路径片段、查询参数及其值、邮箱、用户 ID、IP、Cookie、Authorization、Access JWT、签名、密钥、原始请求体、原始下游响应、D1 行值、异常堆栈。
- 不得因安全诊断把具体的鉴权错误、内部路由数据暴露给未认证请求。健康接口原有有限的静态 `reason` 仅在条件匹配时存在，`traceProbe` 是服务端日志，不会添加其他客户端数据。
- 仅给临时 Gateway 开启 Workers Logs。避免部署到正式 Worker，避免全账号级 Logging 设置变更；完成后删除 Gateway，避免留下持续日志采集。

### 临时 Gateway 观测配置示意

上传**临时** Worker 时（或在控制台逐项确认）：

```json
{
  "observability": {
    "enabled": true,
    "head_sampling_rate": 1,
    "logs": {
      "enabled": true,
      "head_sampling_rate": 1,
      "invocation_logs": false
    },
    "traces": { "enabled": false }
  }
}
```

`invocation_logs=false` 是为了优先记录手写的脱敏阶段消息，不采集完整自动请求日志；必须在部署后 GET 实际设置再次确认。若当前 API / 计划不支持上述限制，**停止测试，不改为打开原始请求日志**。

Cloudflare 官方文档：
- https://developers.cloudflare.com/workers/observability/logs/workers-logs/
- https://developers.cloudflare.com/workers/observability/query-builder/
- https://developers.cloudflare.com/workers/configuration/cloudflare-access/

## 3. 云端执行前的逐项门禁

1. 确认 PR #35 仍为 Draft、未合并；Isolation Gate、Reproducible Build 两项 CI 全绿，且每项诊断安全测试通过。
2. 记录并 GET 核实原审核 `waffopay-preprod-isolated` 当前 100% 版本 `26863803-021d-46bd-b3d5-49c15abbfe90`，`waffopay-preprod-mock` 当前 100% 版本 `39fd33fd-173c-481d-ba99-03740c1a5574`；原来源 Commit 注解须匹配 `e670f7ba43c1089ac1268d72bf1364fd65c1b45b`。版本不符就停止。
3. 先创建**一次性**受 Access 保护的测试应用，指定 Cloudflare Worker ID 作为 `destinations:[{type:"worker",worker_id:"..."}]`；仅允许事先确认的**单一精确邮箱**，不要使用 Everyone、Bypass、邮箱域通配符、公开服务 Token，也不要启用全账号保护。
4. 仅创建临时 Gateway，`workers.dev=false`、Preview disabled、Cron 0，且只有一项私有 Service Binding `WAFFO_PREPROD_TARGET → waffopay-preprod-isolated`，无 D1/Provider/RPC 绑定。固定变量 `WAFFO_PREPROD_GATEWAY_ENABLED=true`、`WAFFO_PREPROD_ISOLATED=true`、`WAFFO_PREPROD_ENTITLEMENTS_ENABLED=false`、`WAFFO_PREPROD_ALLOW_WEBHOOK=false`、`WAFFO_PREPROD_ALLOW_CRON=false`、`WAFFO_PREPROD_DIAGNOSTICS_ENABLED=true`；Access AUD 精确匹配该临时应用。
5. 由于 Secret 不可读，**仅在确需内部健康调用时**将新生成的随机、测试专用 Gate Token 通过 Secret Binding 同步到 Gateway 与原私有 Worker。绝不打印、外传、提交 GitHub 或尝试读取已有 Secret。再次核实其他密钥、Mock、D1 绑定不变。此操作会创建并部署一个未经原始 commit 注解确认的临时版本，须留存临时版本 ID 以便精确回滚。
6. 经 GET 核实 Access App、唯一允许规则、Worker 级目的地、Secret Binding 类型、日志设置、Webhooks/Cron 关闭、版本单一 100%、无其他公网入口后，才短暂绑定**唯一临时 Custom Domain**。
7. Cloudflare Browser Rendering 对该 URL 的匿名请求必须进入 Cloudflare Access 登录页；匿名请求直接返回任何 Gateway JSON 都属于严重安全失败，立即解除域名。
8. 只有上述全部 PASS，才由已授权的浏览器/审查人**一次**完成 Access 身份验证，并 GET `/__preprod/health`。**不可触发 Webhook/Cron，不发送合成或真实付款请求**。如仅返回统一 `{"ok":false}`，不再要求重复登录或刷新。

## 4. 失败定位与判定

通过 Cloudflare Workers Observability Query Builder（或同等受限的 Observability API）按：

- Dataset：`cloudflare-workers`
- `$metadata.service`：**精确临时 Gateway Worker 名称**
- 时间范围：本次请求前后极短窗口
- 自定义事件：`waffo_preprod_gateway_diag`

只读取上述 6 个允许字段。不要把原始请求日志、登录会话、原始查询结果或敏感数据写入 GitHub。

| stage | 说明 / 下一步 |
| --- | --- |
| `config_rejected` | 配置门禁，核对诊断版、开关及 Secret Binding 存在性 |
| `access_rejected` | 真实 `ctx.access` 校验失败，核对目的地 Worker ID、AUD 和运行时身份 |
| `route_rejected` | 检查 `route/method/extraParams` **分桶**，不读取或公开查询值 |
| `private_target_unavailable` | Service Binding 子调用异常；检查 Service Binding 配置和私有 Worker 部署，不回显异常 |
| `private_non_200` | 私有 Worker 403/503/其他；结合对外状态检查内部 Gate Token 与就绪条件 |
| `private_json_invalid` / `private_health_mismatch` | 内部健康响应内容不符合白名单 |
| `health_pass` | Gateway 经真实 Access 和内部 Service Binding 返回健康成功；仍不等于支付 E2E 通过 |
| `webhook_disabled` / `cron_disabled` | 应当始终生效，不是健康测试失败 |

如果没有任何自定义事件，首先验证**确实已启用临时 Gateway 的 Workers Logs**、诊断标志为 `true`、查询的是精确 Worker 及正确时窗；然后在受控浏览器查看 HTTP 状态码。不要首先去轮换密钥或开放原本私有的 Worker。

## 5. 结束后的必做清理

无论健康检查 PASS 或 BLOCKED，都执行并 GET 核验：

1. **首先撤销临时 Custom Domain**，确认临时 DNS/Zone Route 均为 0，`workers.dev` 和 Preview 始终关闭。
2. 删除临时 Gateway Worker、临时 Access 应用及其 Allow 策略、专为本轮创建的临时 OTP IDP。
3. 将原私有预发布 Worker 恢复为 **单一 100% 原审核 Version** `26863803-021d-46bd-b3d5-49c15abbfe90`。如果 Cloudflare 返回 **10220**，说明 Secret 已变，只有在第一步已经确认断网、且目标版本及原 Commit 注解一致时才可显式使用 `?force=true`；不能无条件强制回滚。
4. 再次 GET 核验原两个私有 Worker 的 Version ID、Secret Binding **类型和名称**、Mock 和 D1 指向、0 Cron、无公网入口。
5. D1 只读检查 `payment_intents=1`、`event_ledger=0`、`production_outbox=0` 是否仍与本轮基线一致。记录差异，但不要直接清库修正。
6. 确认正式 `waffopay`、`afdianpay` 版本不变，生产 D1、会员权益未被本轮操作。
7. 将结果与仍未完成的真实支付 E2E 门禁追加到 Draft PR。保留非生产云端运行的最小安全阶段日志，清理任何意外敏感字段；不得将本阶段误标为生产支付 PASS。

**无论诊断结果是什么，生产支付始终 NO-GO，直到签名 Webhook、幂等 D1、Mock/RPC 及权限边界的真实云端 E2E 单独通过。**
