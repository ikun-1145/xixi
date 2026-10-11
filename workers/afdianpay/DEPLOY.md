# afdianpay 部署与对账

该 Worker 使用两条独立链路处理付款：爱发电 Webhook 实时处理，以及每 2 分钟的 `query-order` 对账。订单幂等与最终状态保存在 Supabase 的 `pro_payment_orders`，扫描游标、代次和租约保存在 Supabase `pro_payment_reconciliation_state`；KV 绑定为历史兼容配置，不承担当前游标或付款幂等。

## 固定上线顺序

1. 应用 `supabase/migrations/` 中的付款账本迁移。
2. 配置并部署本目录的 Worker。
3. 在爱发电创作者后台配置 Webhook。
4. 观察一次完整历史分页扫描，把无法自动绑定的成功订单交给支持人员核验。
5. 最后发布引用付款入口和 `pro_activation_support.html`。

不要在数据库迁移完成前发布只认识 UUID 付款引用的前端；旧 Worker 也不能在新付款入口启用后回滚使用。

## 配置与部署

```bash
cd workers/afdianpay
npx wrangler deploy --dry-run
npx wrangler deploy
```

`wrangler.toml` 仅含公开配置。以下值必须使用 Worker secret，绝不写入仓库或命令历史：

```bash
npx wrangler secret put SUPABASE_KEY  # Supabase service_role key
npx wrangler secret put TOKEN         # 爱发电 Open API token
openssl rand -hex 32 | npx wrangler secret put ADMIN_TOKEN
```

`ADMIN_TOKEN` 只用于受保护的精确订单重查。把生成值保存在团队的受控密钥库；Worker 不会记录它。

## 爱发电 Webhook

在爱发电开发者后台把 Webhook 地址设置为：

```text
https://afdianpay.sunland.dev/webhook/afdian
```

Webhook 使用爱发电公开 RSA-SHA256 规则验证签名。只有付款订单已经写入账本（已激活、重复、待核验或不符合方案）后，Worker 才会返回 `{"ec":200,"em":""}`；临时故障会返回失败，以便爱发电重试。

## 对账与历史回放

- 每轮读取最新一页及一页历史（当前响应最多50笔）。最近与历史同页时，只在本次 invocation 内共享新鲜官方响应。
- 历史游标逐轮推进，到 `total_page` 后回到第一页；全部ID先成为持久hints，批量处理成功后才通过token/generation完成扫描。故障保留游标，未处理新订单进入due重试队列。
- 新迁移 `20261011030000_afdian_scan_admission.sql` 只供审查，须单独批准并先应用数据库、后部署Worker；新Worker依赖批量准入及带token的完成/失败RPC。上线前必须核验生产函数定义与ACL，不能把仓库迁移视为活跃目录证据。
- unchanged unresolved遵守next_retry_at；稳定activated/ineligible/blocked至少间隔24小时后，在扫描再次遇见时复核。付款事实变化进入既有可信校验；活跃精确查询租约保护扫描重叠。订单预算为每批8笔，按变化和最老核验排序，避免固定前8导致历史尾部饿死。
- 既有商品/金额/绑定、退款墓碑和权益来源校验保持不变。退款记录付款事实，不直接设置pro=false；异常不会被网络失败误判为付款失败。
- 精确查询有2分钟token租约；扫描租约3分钟。重试lane有20秒冷却及45秒软预算，预算耗尽的订单仍保持due。
- Cron改变官方最多约15分钟传播。2026-10-11只读审计发现API的 `*/2 * * * *` 与真实scheduled的 `* * * * *` 不一致已持续超出该窗口，原因待Cloudflare核查；禁止凭此删除触发器。对照 `reconciliation_started` 的controller信息、平台requestId/version和触发时间。
- 检查 `payment_scan_processed` 的observed/processed/skipped，以及数据库历史next_page/cycle_id/last_success_at，完成整个周期才确认历史恢复。不能只看一次cron outcome=ok。

如需按订单号立即重查（例如支持申诉），使用受保护接口：

```bash
curl -X POST "https://afdianpay.sunland.dev/admin/reconcile" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"out_trade_no":"爱发电订单号"}'
```

旧的公开 `/test` 入口已删除，访问它应得到 404。通过 `npx wrangler tail afdianpay` 查看结构化汇总日志；日志不应包含用户 ID、订单内容、令牌或付款资料。

## 人工补发

人工处理必须先核验官方付款事实与可信用户绑定，通过现有受控服务流程重新查询；旧 `sunland_resolve_pro_payment` 不能替代新鲜官方付款证明。任何真实权益补发、撤销或改动需单独授权。service-role key 与付款RPC不得暴露给浏览器。

本次本地修复的生产证据、性能模型和验收边界见 [审查报告](../../docs/afdianpay-cpu-reconciliation-audit.md)。
