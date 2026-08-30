# Cloudflare Workers KV 全链路审计报告

审计日期：2026-08-30（Asia/Shanghai）
范围：当前仓库 `main`、可见本地/远程 Git 分支、当前 Cloudflare 账号的 KV namespace 与已部署 `ai` Worker。
说明：没有执行生产部署、KV key 列举、KV 写入、Supabase 写操作、secret 更新或 Git push/merge。

## KV 使用总览

结论先行：本仓库的 `afdianpay` 不是本次 90% 告警的主要来源。告警来源已在 Cloudflare 线上侧确认到 `ai-code-store` namespace 及已部署的 `ai` Worker：

- `ai` Worker 的 `CODE_STORE` 与 `USAGE_KV` 两个 binding 指向同一个 `ai-code-store` namespace。
- 该 Worker 同时把登录验证码、验证码限流、普通 AI 日配额、AI 请求频率限制、标题日配额和标题频率限制写入这个 namespace。
- Cloudflare 只读 analytics 显示，2026-08-29 该 namespace 有 **911 writes、302 deletes、1,345 reads**。911 writes 已是免费套餐 1,000 writes/day 的 91.1%，与“达到 90%”告警精确吻合。
- 2026-08-30 截至查询时，该 namespace 有 216 writes、59 deletes、313 reads；用户提供的约 210 writes、59 deletes 与该时点的 Dashboard 数字一致，读数差异应由 Dashboard 时间窗口/延迟/四舍五入造成。
- 同一账号的 `ORDERS` namespace 在 2026-08-29 只有 2 writes，但有 5,530 reads；它解释不了 911 writes 或 302 deletes。
- 当前仓库内没有 `KV.delete()` 或 `KV.list()`。`functions/api/verify.js` 的 `VERIFY_RATE_LIMITER` 是 Cloudflare Rate Limiting binding，不是 KV。

当前账号可见 namespace：

| Namespace | 当前仓库 binding | 线上已部署 binding | 审计结论 |
|---|---|---|---|
| `ORDERS` | `workers/afdianpay/wrangler.toml` → `ORDERS` | `afdianpay` → `ORDERS` | 付款幂等账本；只有 get/put |
| `ai-code-store` | 无 | `ai` → `CODE_STORE`、`USAGE_KV` | 本次告警来源；验证码和 AI 配额共用 |
| `sunland-api-gateway-staging-code-store` | 无 | 本次日期范围无操作 | 可见但当前查询无流量 |
| `sunland-api-gateway-staging-usage` | 无 | 本次日期范围无操作 | 可见但当前查询无流量 |

## 所有 KV 调用点

### 当前 `main` 仓库

| 文件 / 函数 | Namespace | 操作 | 触发条件与单次请求次数 | 放大因素 / 热点 |
|---|---|---|---|---|
| `workers/afdianpay/worker.js` / `checkOrders` | `ORDERS` | read | 每 2 分钟 cron 或访问 `/test`；每个 `status === 2` 且有 `remark`/`custom_order_id` 的订单 1 次 get | cron 每天最多 720 次；每次会重复扫描订单列表，因此是稳定 read 热点；已处理订单仍需 get 做幂等判断 |
| `workers/afdianpay/worker.js` / `checkOrders` | `ORDERS` | write | Supabase 开通 Pro 成功后，每个新订单 1 次 put | 写入是幂等账本；Supabase 失败时不 put，下一次 cron 会重试，属于有意的业务重试，不是无意义重复写 |

本地改动前，缺少绑定的已支付订单也会先执行一次 `ORDERS.get()`。本次已将用户绑定校验提前，避免无绑定订单消耗 read；没有删除幂等 read，也没有改变 Pro 开通或失败重试逻辑。

本仓库确认没有以下本地 KV 调用：`.delete()`、`.list()`、其他 KV binding、Pages Functions KV binding、Cron/Scheduled 对 AI 配额的 KV 写入。

### Cloudflare 已部署 `ai` Worker（不属于当前仓库源代码）

只读部署元数据和当前版本源码显示，`ai` Worker 当前版本包含验证码、AI 网关和自动标题路由；当前版本部署于 2026-08-30。以下是实际线上调用点：

| 路由 / 函数 | Namespace | 操作 | 触发条件与一次请求的操作数 | 放大因素 / 热点 |
|---|---|---|---|---|
| `/send-code` | `CODE_STORE` → `ai-code-store` | 1 read + 2 writes + 1 delete | 通过验证码且不在 60 秒 cooldown 时：读 cooldown，写 code、cooldown，删除 fail | 登录发送验证码热点；每次发送固定消耗 2 writes，即使 fail key 不存在，delete 仍计数 |
| `/send-code` | 同上 | 1 read | 命中 cooldown 时只读 cooldown 并返回 429 | 前端重发/用户重复点击会增加 reads，但不会增加 writes |
| `/verify-code` | `CODE_STORE` → `ai-code-store` | 通常 3 reads + 2 writes | 读 IP 限流并写限流键，读失败次数和验证码；错误验证码再写 fail 计数 | 错误尝试会持续写入；IP 限流写发生在参数和验证码校验之前 |
| `/verify-code` | 同上 | 通常 3 reads + 1 write + 2 deletes | 正确验证码：读限流、写限流、读 fail、读 code，成功后删除 code 和 fail | 每次成功登录贡献 2 deletes；这与 Dashboard 的 delete 数字直接对应 |
| `/` AI 主路由 | `USAGE_KV` → `ai-code-store` | 至少 3 reads | 读用户当日 usage、读 `blocked_keywords`、读 `rate:<user>` | 每个通过认证的 AI 请求都执行；即使 Pro 不受日配额限制，也仍读 usage |
| `/` AI 主路由 / `isRateLimitedKV` | 同上 | 1 write | 1.2 秒窗口内未命中时写 `rate:<user>`，TTL 60 秒 | 每个正常通过频率限制的请求多 1 write；快速重复请求只增加 reads |
| `/` AI 主路由 | 同上 | 1 write | 非 Pro 且上游返回成功时写 `usage:<user>:<day>` | 普通 AI 成功请求的 quota write；写入发生在把 SSE response 返回给客户端之前 |
| `/v1/title` / `handleConversationTitle` | `USAGE_KV` → `ai-code-store` | 成功时 2 reads + 2 writes | 读标题配额、读并更新标题频率限制、上游成功后写标题配额 | 每个首轮自动标题额外消耗；Pro 也会写标题配额 |
| `getBlockedKeywords` | `USAGE_KV` → `ai-code-store` | 1 read | 每次 `/` AI 请求读取 `blocked_keywords` | 当前没有内存/Cache API 缓存，因此是每请求固定 read |

线上 `ai` Worker 没有 `scheduled` handler；当前没有发现线上 Cron 高频写 KV。发布下载缓存使用的是 Cache API，不计入 KV。

### 明确排除的“看起来像 KV”代码

- `functions/api/verify.js` 的 `VERIFY_RATE_LIMITER.limit()` 是 Rate Limiting binding，不会产生 KV read/write/delete/list。
- `verify/server/model-adapter.js` 的两阶段核验会请求 `api.sunland.dev`，而不是本地 KV；但该外部请求实际会进入线上 `ai` Worker `/` 路由，所以会受到线上 AI quota KV 逻辑影响。
- `ai/app.js` 的登录、token refresh、激活码和会话状态主要走外部 API/Supabase；浏览器本身没有 KV API 调用。
- `ai-core.sunland.dev` 对应的本地 sibling repo 使用 Durable Object storage 和 Supabase，不是 KV；DO storage 的 `ctx.storage.get/put` 不计入 Workers KV analytics。
- 当前仓库可见分支 `codex-furry-event-source-migration` 没有新增 KV binding 或 KV 操作。

## 每次 AI 请求的 KV 操作链

### 普通聊天请求

真实调用链是：

`ai/app.js` 发送按钮 → `runDeepSeekRequest` → `authenticatedFetch` → token 必要时 refresh 一次 → `POST https://api.sunland.dev` → 线上 `ai` Worker 认证和 Supabase 用户状态 → 读取普通日配额 → 读取 blocked keywords → 读取用户频率键 → 上游 DeepSeek SSE → 成功后写普通日配额 → 将 SSE 返回浏览器。

线上 `/` 路由的 KV 计数如下：

- 免费用户成功请求：**3 reads + 2 writes**。
  - reads：`usage`、`blocked_keywords`、`rate`；
  - writes：`rate`、`usage`。
- Pro 用户成功请求：**3 reads + 1 write**；Pro 不写普通 `usage`，但仍写频率键并读取其他两个键。
- 1.2 秒内被频率限制的重复请求：通常 **3 reads + 0 writes**，然后返回 429。
- 上游失败但已通过频率限制：通常 **3 reads + 1 write**；quota write 在上游确认成功后才执行。
- SSE 每收到一个 chunk **不会写 KV**。线上 quota write 在 SSE Response 创建前执行一次；浏览器逐 chunk 解析也没有 KV 调用。
- 非视觉模型失败时线上可能再尝试一次 fallback 上游，但不会重新执行 quota/rate KV 段；同一次 Worker invocation 仍只经过一套 KV 检查。

### 自动标题

当前仓库 `ai/app.js` 的 `generateTitleFromAI` 在首个 DeepSeek 对话完成后调用同一个 `https://api.sunland.dev` 根路径，并发送 `stream:false`。它不是本仓库中的 `/v1/title` 调用。因线上根路由按请求路径处理，这个标题请求当前会再次进入 `/` 的 usage/rate 逻辑：

- 免费用户：额外约 **3 reads + 2 writes**，并可能额外消耗普通 AI 日配额；
- Pro 用户：额外约 **3 reads + 1 write**。

线上已部署 Worker 同时存在 `/v1/title` 路由；若线上前端版本改为调用该专用路由，则一次成功标题请求是 **2 reads + 2 writes**，而不是上述根路由计数。这个“仓库前端与线上路由不一致”应在单独变更中确认，不能在本次 KV 审计中擅自改动 AI 协议。

### 信息核验页

前端流程是：

`verify/verify.js` → `POST /api/verify stage=extract` → `verify/server/model-adapter.js` 请求 `api.sunland.dev` → 如有 claims 再 `POST /api/verify stage=judge` → 第二次请求 `api.sunland.dev`。

因此一次成功且有 claims 的免费用户核验，通常会在外部 `ai` Worker 产生 **2 次 `/` AI 请求 = 6 reads + 4 writes**；无 claims 或第一阶段失败则少于两次。`VERIFY_RATE_LIMITER` 本身不贡献 KV，但外部 AI gateway 的 usage/rate KV 会贡献操作数。

### 登录验证码

登录页发送和验证不是普通 AI 请求，但共用同一个 `ai-code-store`：

- 一次成功发送验证码：1 read + 2 writes + 1 delete；
- 一次错误验证码：通常 3 reads + 2 writes；
- 一次成功验证：通常 3 reads + 1 write + 2 deletes。

因此 Dashboard 中的 deletes 更符合验证码流程，而不是 `afdianpay`；当前仓库没有任何 delete 调用。

## 最可能导致 90% 告警的代码

已确认最可能且有直接数值证据的是线上 `ai` Worker 对共享 `ai-code-store` 的写入：

1. 2026-08-29 的写入数为 **911/1,000 = 91.1%**，正好跨过 90% 告警线。
2. 普通免费 AI 成功请求固定有 `rate` 和 `usage` 两次写；1000 次写入只相当于约 500 次成功的免费主请求，还未计算标题、核验和验证码。
3. 验证码发送、错误验证和成功验证也写同一 namespace；验证码成功验证贡献 2 deletes，解释了 2026-08-30 的 59 deletes 以及 2026-08-29 的 302 deletes 的来源方向。
4. 自动标题是额外请求。当前仓库前端首轮 DeepSeek 回复后会额外调用根 API；如果上游成功，它会再次走普通 usage/rate KV。
5. `ORDERS` 只有 read/put，没有 delete；其 2026-08-29 写入仅 2 次，不能是 90% write 告警的来源。

所以，本次告警不是存储容量问题，也不是当前仓库 AI 前端直接写 KV；它是外部线上 `ai` Worker 把多种高频状态集中到 `ai-code-store`，在某个 UTC 日内累积了写入。告警对应的操作类型是 **write**；delete 数字来自验证码流量，read 数字则主要来自 AI 请求的多重 KV 检查。

## 理论每日操作量估算

Cloudflare 免费套餐按操作类型分别限制：reads 100,000/day，writes 1,000/day，deletes 1,000/day，lists 1,000/day；每天 UTC 00:00 重置。超过某一类型后，该类型操作会失败。

官方依据：[KV Pricing](https://developers.cloudflare.com/kv/platform/pricing/)、[KV Limits](https://developers.cloudflare.com/kv/platform/limits/)、[KV Metrics and Analytics](https://developers.cloudflare.com/kv/observability/metrics-analytics/)、[How KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/)。

### 用户给定场景：100 用户 × 每人每天 20 条消息

消息数为：

`100 × 20 = 2,000 条消息/天`

如果只按用户提出的简化 quota 模式 `KV.get(counter) → counter + 1 → KV.put(counter)` 计算：

- 约 2,000 reads；
- 约 2,000 writes；
- 已明确超过 1,000 writes/day，达到免费写入额度的 2 倍。

按当前线上 `ai` Worker 的真实普通 AI 路径计算，且假设都是免费用户、上游成功、没有标题和验证码附加流量：

- **约 6,000 reads/day**：每条 3 reads；
- **约 4,000 writes/day**：每条 2 writes；
- writes 是免费额度的 4 倍，必然触发写入限制。

如果每个用户每天只产生一次首轮自动标题，并且当前仓库前端仍调用根路径：

- 额外约 300 reads + 200 writes；
- 合计约 **6,300 reads + 4,200 writes/day**。

如果每个用户每天完成一次有 claims 的信息核验，还可能额外增加最多：

- 200 次外部 AI 调用；
- 约 600 reads + 400 writes。

### 当前 `afdianpay`

`workers/afdianpay/wrangler.toml` 的 `*/2 * * * *` 等于每天 720 次调度。设每次爱发电 API 返回 `N` 个已支付且已绑定订单，设当天首次成功处理的订单数为 `P`：

- 每日 reads ≈ `720 × N`；
- 每日 writes ≈ `P`；
- `/test` 手动调用会再增加一轮扫描。

2026-08-29 的 `ORDERS` analytics 为 5,530 reads、2 writes，约等于每轮 7.68 个已支付订单，远低于 100,000 reads/day，也没有接近 1,000 writes/day。

### 什么时候会撞额度

- 仅按真实线上免费主 AI 路径：约 **500 次成功消息/天** 即用完 1,000 writes；标题、核验、验证码会进一步降低阈值。
- 100 用户 × 20 条消息 = 2,000 条，必然超过写入额度。
- 只按简化的“1 read + 1 write” quota 逻辑：约 1,000 条成功消息即可撞写入额度；2,000 条仍然超过一倍。
- 验证码操作还可能独立把 delete 推高到 1,000/day；当前 302 deletes 尚未超过删除额度，但已经证明 delete 流量来自外部 `ai-code-store`，不是当前仓库。

## 风险等级

**高：线上 `ai-code-store` 的写入预算存在再次耗尽的现实风险。**

- 该风险已经在 2026-08-29 实际发生到 91.1%，不是理论问题。
- 写入限制会影响普通用户 quota 更新、频率键、标题计数和验证码状态。当前线上主路由对 quota `put` 使用了总 catch，KV 写入异常可能表现为 500；频率限制本身也会对快速重复请求返回 429。因此不能把“KV 达限”简单等同为单一 429 表现。
- 用户给定的 Dashboard 数字是当前时点快照，不代表每个 UTC 日的峰值；应以 Dashboard 的 namespace + date + actionType 或 GraphQL analytics 逐日查看。
- `ORDERS` read 热点本身不危险：当前量约 5K/day，相对 100K reads/day 仍有余量；它的 writes/deletes 不是告警根因。

另有一项安全风险：本次只读 `wrangler versions view` 返回了线上部署环境变量的明文值。值未写入仓库、报告或本回复，但已经出现在本机命令输出/工具日志中。应立即轮换 `ai` Worker 涉及的 API、认证、邮件、验证码和服务端密钥，并检查本机 Wrangler/终端日志保留范围；本次没有自动执行轮换。

## 建议优化方案

### 可立即确认并安排的线上修复

1. 先在 Cloudflare Analytics 固定查询 `ai-code-store`，按 UTC 日期和 `actionType` 分开看，保留 2026-08-29 的证据；不要再用 KV key list 作为诊断手段，因为 list 也是计费操作。
2. 给线上 `ai` Worker 增加脱敏的聚合诊断日志，例如每次 invocation 只输出 route、operation group、read/write/delete 次数和结果类别；绝不输出 token、Authorization、邮箱、完整 userId、验证码或订单号。
3. 将普通 AI quota 从“KV read-modify-write”迁移到具备原子增量语义的既有 Supabase quota RPC、D1 原子计数或按用户 Durable Object 串行计数。不能简单删除 write 或用内存缓存代替，否则会破坏并发计数和每日限额。
4. `ai-code-store` 中验证码和 AI quota 共用 namespace，建议后续拆分 binding 以便归因和隔离故障；这本身不会消除账号总操作量，仍需降低 writes。
5. 评估自动标题是否必须再发一次模型请求。可以改为客户端确定性标题、复用首轮响应或使用专用 title 路由，但这会涉及外部 Worker/API 契约，不能在当前仓库直接盲改。
6. 校验验证码流程是否需要每次 `/send-code` 都 delete 不存在的 `fail` key，以及 `/verify-code` 是否应在参数校验前写 IP rate key；这些是明确的写/delete 优化候选，但属于线上认证逻辑，需单独做安全评审后再改。

### 当前仓库已实施的最小优化

`workers/afdianpay/worker.js` 已将订单绑定字段检查移到 `ORDERS.get()` 之前：无用户绑定的已支付订单不再浪费一次 read。幂等 read、Supabase Pro 更新、`put` 时机和失败重试全部保留。

没有在当前仓库添加线上 `ai` instrumentation，因为告警来源已经由线上版本、binding 和逐日 analytics 直接确认；对不属于本仓库的 Worker 添加日志必须在其源代码和发布流程中完成，且需要另行部署授权。

### 是否需要迁移

- `afdianpay` 的 `ORDERS`：暂不需要迁移；它是低频、简单、适合 KV 的幂等账本。
- 登录验证码：KV 仍可使用，但应先限制无效请求写入、减少无意义 delete，并监控 delete/write 日额度。
- AI 每日 quota：不建议继续用 KV 做高频 read-modify-write；优先评估已有 Supabase 原子 RPC，其次是 D1 原子计数或 Durable Object 串行化。迁移前必须保留 Pro 无限额度、每日重置、并发一致性和现有 API 响应协议。
- `ai-core.sunland.dev` 的 DO/Supabase 数据：当前没有证据需要迁移到 KV，也不应为本次告警改动。

## 验证结果与本地 diff

本次执行：

- `npm test`：通过；
- `node --check`：`workers/afdianpay/worker.js`、`functions/api/verify.js`、`functions/copilot.js`、`verify/verify.js`、`ai/app.js` 通过；
- 新增 `tests/afdianpay-worker.test.mjs`：通过，确认无绑定订单不会调用 `ORDERS.get()`，绑定订单仍执行 get + Supabase + put；
- `npx wrangler pages functions build --outdir <临时目录>`：通过；
- `npx wrangler deploy --dry-run`（`workers/afdianpay`）：通过，仅显示 `ORDERS` KV binding；没有部署；
- Wrangler 配置：通过，`afdianpay` 只有一个 `ORDERS` KV binding，cron 为每 2 分钟；
- `git diff --check`：应作为交付前最后检查；
- 当前项目没有 lint/typecheck npm script。

本地修改只有：

- `workers/afdianpay/worker.js`：提前校验订单绑定，减少无效 KV read；
- `tests/afdianpay-worker.test.mjs`：增加调用次数回归测试；
- `docs/kv-audit-report.md`：保存本审计报告。

未执行生产部署、`wrangler secret put`、Supabase 写操作、push、merge 或 deploy。
