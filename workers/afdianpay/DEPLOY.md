# afdianpay 部署与对账

该 Worker 使用两条独立链路处理付款：爱发电 Webhook 实时处理，以及每 2 分钟的 `query-order` 对账。订单幂等与最终状态保存在 Supabase 的 `pro_payment_orders`，KV 只保存分页扫描进度。

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

- 每轮都会读取最新一页（每页 100 条）。
- 每天从第一页开始并按 `total_page` 续扫所有历史页；进度在 KV 中保存。分页过多或 KV 暂时不可用时，下一轮会从安全的重叠页继续，订单账本不会丢失。
- 只会给 `status=2` 且固定方案 ID 的订单激活 Pro；金额非 ¥10 倍数、无绑定或异常订单会持久化为 `unresolved`，不会静默跳过。
- Cloudflare 新增或更新 Cron 可能需要最多约 15 分钟才会在全网生效。部署后等待该时限，再检查 `pro-reconcile:last-full-scan-day` 与 `pro-reconcile:next-page` 两个 KV 键，并通过 `wrangler tail` 确认存在 `reconciliation_complete` 汇总日志，才可认定历史回放已经启动。

如需按订单号立即重查（例如支持申诉），使用受保护接口：

```bash
curl -X POST "https://afdianpay.sunland.dev/admin/reconcile" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"out_trade_no":"爱发电订单号"}'
```

旧的公开 `/test` 入口已删除，访问它应得到 404。通过 `npx wrangler tail afdianpay` 查看结构化汇总日志；日志不应包含用户 ID、订单内容、令牌或付款资料。

## 人工补发

支持人员仅可在确认订单后，通过受控的 service-role 环境调用 `sunland_resolve_pro_payment(order_id, user_id)`。它只能处理账本中指定方案的 `unresolved` 订单，并在同一事务中开通 `user_profiles.pro`、记录绑定用户与解决时间。不要把 service-role key 或该 RPC 暴露给浏览器。
