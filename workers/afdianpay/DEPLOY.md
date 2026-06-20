# afdianpay 部署（wrangler）

> 爱发电付款 → cron 轮询 query-order → 写 Supabase `user_profiles.pro=true`。
> 敏感密钥（SUPABASE_KEY=service_role、TOKEN=爱发电）不入库，用 `wrangler secret` 注入。

## 前置
```bash
npm i -g wrangler        # 或用 npx wrangler
wrangler login           # 浏览器授权；或设 CLOUDFLARE_API_TOKEN 环境变量
cd "workers/afdianpay"
```

## 一次性步骤

### 1. 建幂等 KV，并把 id 填回 wrangler.toml
```bash
wrangler kv namespace create ORDERS
```
把输出里的 `id = "xxxxxxxx"` 复制，替换 `wrangler.toml` 中的 `PASTE_KV_ID_HERE`。

### 2. 部署 worker（含 cron + vars + KV 绑定）
```bash
wrangler deploy
```

### 3. 注入两个密钥（交互式，粘贴值后回车）
```bash
wrangler secret put SUPABASE_KEY   # 粘贴 Supabase service_role key
wrangler secret put TOKEN          # 粘贴爱发电 API token
```
> 这两个值在 CF 后台 afdianpay → Settings → Variables 里能看到原值。
> 注入后再确认一次仍能跑：`wrangler deploy`（secret 会保留）。

### 4. 删除易支付半成品
```bash
wrangler delete --name create-order
wrangler delete --name pay-notify
```

## 验证
```bash
# 手动触发一次对账
curl https://afdianpay.<你的子域>.workers.dev/test
# 看实时日志
wrangler tail afdianpay
```
然后真实下一笔 1 元单，日志里应出现：`✅ 已开通永久Pro: <userId>`。
若出现 `⚠️ 订单无 remark` → 爱发电公开页 `?remark=` 没回填，改用 `?custom_order_id=`
（前端 `ai_settings.html` 那一行同步改），worker 已兼容两者。
