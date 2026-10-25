# 独立 phone-auth Worker

状态：**已受控部署至生产，手机号入口保持关闭，未发送真实短信**。生产 ai 的代码、配置、邮箱 KV、JWT 密钥均未修改；新 Worker 只接管 `api.sunland.dev/v1/phone/*`。无需邮箱 OTP RPC、独立邮箱屏障或 KV→RPC 切换。

## 交付与验证

- 入口 `standalone-entry.js`，配置 `wrangler.jsonc`；自身承载 PhoneAuthCoordinator，绑定 PHONE_AUTH_COORDINATOR、固定对象 sunland-phone-auth-v1。无 KV、service binding、邮件或 AI 供应商依赖，无 cron。
- 复用八个生产认证 helper（签名、验签、资料状态、RPC、JSON/CORS），来源为此前已只读核实对应生产 f405 的 Git `bc5489b6e2962f3e1306aa4de5b4292cecf7ca3d`。构建再次校验完整基线规范化摘要，再树摇去除原 default Worker 与无关模块；没有改相邻工程源码。该基线代码在本次生产部署前后均已只读复核，未修改 ai。
- 三开关默认 false、发布模式 canary。只允许手机号注册/登录、status；邮箱再验、绑定、换绑、解绑及其发码用途均关闭。为避免 phone-only 账号失去注销路径，复用现有手机号再验和 delete-authorize，仅限 delete。
- 新号码创建独立 UUID、email=NULL，不合并邮箱账号、不继承其 Pro/聊天；同号码重复登录返回同一 ID。复用既有 SQL 唯一性/RLS、HMAC/AES-GCM、DO 限流预算、Turnstile 和一次消费协议，不新增数据库迁移。
- 1041/1041 全量测试通过。独立候选重点测试 7 项：真实本地手机号 SQL + Mock 供应商完成注册/登录/重放拒绝；原生产 ai 基线接受新 JWT，并完成刷新、身份/数据库 token、Free/Pro 用量和模拟 AI SSE；原 KV 邮件发送/消费、邮箱用户原 ID/Pro 不变。不是实际生产/真实供应商验收。
- `node scripts/test-phone-workerd.mjs --standalone`：真实本地 workerd + SQLite DO 默认关闭、独立管理鉴权、并发初始化一次、重启持久化、canary 3 次上限及并发重放拒绝通过，出站均 Mock。
- Wrangler 4.120.1 dry-run 通过：69.57 KiB / gzip 16.77 KiB。no_bundle 保证 dry-run 与冻结包逐字节相同；SHA256SUMS 三文件全部 OK。

候选目录：`/Users/liuxize/Developer/xixi/build/phone-auth-standalone/`。Worker SHA-256：`983c205dfdd7f47e69336fc8c5b9e8e493e157a05784ad180e1304c193f99a52`。可用 `node scripts/build-phone-auth-worker.mjs /absolute/new-directory --standalone` 重建；拒绝覆盖旧目录，生成独立 wrangler.json、manifest 与校验文件。不要使用旧的 AI/OTP 迁移候选配置。

## 生产受控部署记录（2026-10-25）

- 候选提交 `1127d0b`；部署时间 `2026-10-25T13:25:10.19719Z`（北京时间 21:25:10）。线上下载模块与冻结 worker.mjs 的 SHA-256 完全一致，摘要见上。
- Worker `phone-auth`，版本 `79957a68-b21d-44d1-a9d7-5af2ce47131b`，流量 100%；部署 ID `4569abf5-a812-4eae-9363-6b69e641c60b`。
- SQLite DO `PhoneAuthCoordinator`，绑定 `PHONE_AUTH_COORDINATOR`，命名空间 `83d0cc9be98a49f0b3348232fc762a38`；生产迁移标签 `phone-auth-v1`。对象列表为 0；只验证类、命名空间、绑定及迁移登记，没有创建对象或初始化付费账本，真实初始化尚未验收。
- 新路由 `api.sunland.dev/v1/phone/*` → `phone-auth`，路由 ID `cbc36273e0634a5bbc6ccf22d1410972`。原 `api.sunland.dev/*` → `ai`（ID `ec92ac1edd5c46658b66ebd0ee578a89`）保持原样；workers.dev 和预览 URL 均关闭。
- 三开关全部为字符串 `false`，发布模式 `canary`。仅为新 Worker 配置 APP_JWT_LEGACY_SECRET、SUPABASE_SECRET_KEY、TURNSTILE_SECRET 三项 Secret，安全复用 ai 已有对应兼容配置，不改变 ai。其余六项手机号专用 Secret 尚缺，不填假值，不允许启用功能。
- ai 仍为 `f405a850-780d-483f-8942-83e1798711fe`、100%；部署前后原模块 SHA-256 均为 `5f301dc9548735615c6f84f0f918e4f9820da082544d002798c35bb1a9fd67a2`。没有修改 ai、邮箱 KV/RPC、数据库、网站或生产预算。
- 生产 curl 实测：POST `/v1/phone/send-code`、`/verify-code`、`/status`（均带完整 phone 前缀、空 JSON）均返回 **503 / IDENTITY_DISABLED**；phone OPTIONS 返回 **204**。邮箱 `/send-code`、`/verify-code`、`/refresh` OPTIONS 均 **200**；无凭据 POST `/refresh` 和 AI `/` 均 **401 Unauthorized**。未调用邮箱发码/消费、未发送验证码、未创建用户。Python urllib 探测曾统一返回 403，改用 curl 后取得上述应用响应；不将该探测拦截误记为业务故障。
- JWT 配置使用 ai 当前认可的同一兼容签名值，源码兼容性已有本地验证；此次没有完成生产真实用户 JWT/AI/权益链路验收，留待获授权 canary。关闭状态检查不能代替短信、Turnstile、DO 实例初始化或真实登录验收。

## 最短上线清单（尚未执行部分需后续授权）

1. **配置新 Worker 的 Secrets**：APP_JWT_LEGACY_SECRET 必须安全复制 ai 已认可的兼容签名值，不能另造一把 JWT key；不轮换 ai 密钥。配置 SUPABASE_SECRET_KEY、TURNSTILE_SECRET、PHONE_ALIYUN_ACCESS_KEY_ID/SECRET（STS 时另配 SECURITY_TOKEN）、PHONE_AUTH_HMAC_KEY、PHONE_AUTH_ADMIN_TOKEN、PHONE_IDENTITY_LOOKUP_KEY、PHONE_IDENTITY_ENCRYPTION_KEYS。全部经平台 Secret store/密码管理器，不进源码、参数或日志。
2. **配置 canary 参数**：PHONE_AUTH_HMAC_KEY_ID、PHONE_IDENTITY_LOOKUP_KEY_ID、PHONE_IDENTITY_ENCRYPTION_KEY_ID、PHONE_SMS_SIGN_NAME、PHONE_SMS_TEMPLATE_CODE；PHONE_AUTH_POLICY 的号码/IP/全局限流与每日/累计预算按真实资费填写；PHONE_SMS_CANARY_PHONE_HASHES 必须是 SMS HMAC key 对 `phone\0`+11位号码的摘要，不是 identity lookup 摘要。保持 canary，累计最多三次且失败不退。
3. **部署已完成**：独立 Worker、SQLite DO 迁移及精确路由已登记。补齐配置后保持三个开关 false，先复核配置；不重新部署 ai，不重复迁移，首次 DO 不自动建账。
4. **初始化**：单独授权对既有 sunland_phone_auth_config 的 lookup canary/key ID 初始化；这不是邮箱迁移。通过 POST `/v1/phone/_admin/initialize`，使用独立 PHONE_AUTH_ADMIN_TOKEN，初始化新 DO 账本；重复初始化 409，禁止清零已有状态。`/_admin/status` 仅返回成本汇总，仍须同一管理鉴权。
5. **受限实测**：明确授权短信/计费后，仅对允许号码启用 SMS、identity、注册开关；核验真实 Turnstile、发送/消费/重放、原 ai 的 JWT/资料/权益通路及邮箱登录。失败关闭手机号开关，保留数据库映射、加密 key 和账本，不改邮箱。签名 key 配错会导致新 JWT 被 ai 拒绝，须在公开前排除。
6. **客户端入口**：网站已有 `p/js/phone-auth.js`，仍请求原 `https://api.sunland.dev/v1/phone/*`，无须换域名；验收后配置公开 Turnstile sitekey、仅开放登录页入口，绑定/解绑设置保持禁用。现有 Flutter lib 未发现手机号 API 调用，App 仍需接入手机号登录界面/请求；原 AI 和邮箱地址不变。本轮未修改或验收 App。

关闭 phone-auth 功能只影响手机号入口，不接管 `/send-code`、`/verify-code`、`/refresh` 或 AI 请求。已有邮箱用户不需要迁移、重新注册或更换 token。手机号密钥配置错误、过宽路由或错误操作数据库会产生实际风险，因此只部署上述独立配置；新账号独立导致“不继承原邮箱权益”是明确行为，不是数据丢失。
