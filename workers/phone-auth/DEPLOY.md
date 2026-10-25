# 独立 phone-auth Worker

状态：**已准备好受控部署候选包，尚未部署或发送真实短信**。生产 ai 的代码、配置、邮箱 KV、JWT 密钥均未修改；新 Worker 只接管 `api.sunland.dev/v1/phone/*`。无需邮箱 OTP RPC、独立邮箱屏障或 KV→RPC 切换。

## 交付与验证

- 入口 `standalone-entry.js`，配置 `wrangler.jsonc`；自身承载 PhoneAuthCoordinator，绑定 PHONE_AUTH_COORDINATOR、固定对象 sunland-phone-auth-v1。无 KV、service binding、邮件或 AI 供应商依赖，无 cron。
- 复用八个生产认证 helper（签名、验签、资料状态、RPC、JSON/CORS），来源为此前已只读核实对应生产 f405 的 Git `bc5489b6e2962f3e1306aa4de5b4292cecf7ca3d`。构建再次校验完整基线规范化摘要，再树摇去除原 default Worker 与无关模块；没有改相邻工程源码。本轮未访问生产。
- 三开关默认 false、发布模式 canary。只允许手机号注册/登录、status；邮箱再验、绑定、换绑、解绑及其发码用途均关闭。为避免 phone-only 账号失去注销路径，复用现有手机号再验和 delete-authorize，仅限 delete。
- 新号码创建独立 UUID、email=NULL，不合并邮箱账号、不继承其 Pro/聊天；同号码重复登录返回同一 ID。复用既有 SQL 唯一性/RLS、HMAC/AES-GCM、DO 限流预算、Turnstile 和一次消费协议，不新增数据库迁移。
- 1041/1041 全量测试通过。独立候选重点测试 7 项：真实本地手机号 SQL + Mock 供应商完成注册/登录/重放拒绝；原生产 ai 基线接受新 JWT，并完成刷新、身份/数据库 token、Free/Pro 用量和模拟 AI SSE；原 KV 邮件发送/消费、邮箱用户原 ID/Pro 不变。不是实际生产/真实供应商验收。
- `node scripts/test-phone-workerd.mjs --standalone`：真实本地 workerd + SQLite DO 默认关闭、独立管理鉴权、并发初始化一次、重启持久化、canary 3 次上限及并发重放拒绝通过，出站均 Mock。
- Wrangler 4.120.1 dry-run 通过：69.57 KiB / gzip 16.77 KiB。no_bundle 保证 dry-run 与冻结包逐字节相同；SHA256SUMS 三文件全部 OK。

候选目录：`/Users/liuxize/Developer/xixi/build/phone-auth-standalone/`。Worker SHA-256：`983c205dfdd7f47e69336fc8c5b9e8e493e157a05784ad180e1304c193f99a52`。可用 `node scripts/build-phone-auth-worker.mjs /absolute/new-directory --standalone` 重建；拒绝覆盖旧目录，生成独立 wrangler.json、manifest 与校验文件。不要使用旧的 AI/OTP 迁移候选配置。

## 最短上线清单（均需后续授权，本轮未执行）

1. **配置新 Worker 的 Secrets**：APP_JWT_LEGACY_SECRET 必须安全复制 ai 已认可的兼容签名值，不能另造一把 JWT key；不轮换 ai 密钥。配置 SUPABASE_SECRET_KEY、TURNSTILE_SECRET、PHONE_ALIYUN_ACCESS_KEY_ID/SECRET（STS 时另配 SECURITY_TOKEN）、PHONE_AUTH_HMAC_KEY、PHONE_AUTH_ADMIN_TOKEN、PHONE_IDENTITY_LOOKUP_KEY、PHONE_IDENTITY_ENCRYPTION_KEYS。全部经平台 Secret store/密码管理器，不进源码、参数或日志。
2. **配置 canary 参数**：PHONE_AUTH_HMAC_KEY_ID、PHONE_IDENTITY_LOOKUP_KEY_ID、PHONE_IDENTITY_ENCRYPTION_KEY_ID、SMS_SIGN_NAME、SMS_TEMPLATE_CODE；AUTH_POLICY 的号码/IP/全局限流与每日/累计预算按真实资费填写；SMS_CANARY_PHONE_HASHES 必须是 SMS HMAC key 对 `phone\0`+11位号码的摘要，不是 identity lookup 摘要。保持 canary，累计最多三次且失败不退。
3. **仅部署 phone-auth**：部署独立配置、SQLite PhoneAuthCoordinator 及更具体 `/v1/phone/*` 路由，ai 的 `api.sunland.dev/*` 和原全部绑定不变。三个功能开关先 false；首次 DO 不自动建账。
4. **初始化**：单独授权对既有 sunland_phone_auth_config 的 lookup canary/key ID 初始化；这不是邮箱迁移。通过 POST `/v1/phone/_admin/initialize`，使用独立 PHONE_AUTH_ADMIN_TOKEN，初始化新 DO 账本；重复初始化 409，禁止清零已有状态。`/_admin/status` 仅返回成本汇总，仍须同一管理鉴权。
5. **受限实测**：明确授权短信/计费后，仅对允许号码启用 SMS、identity、注册开关；核验真实 Turnstile、发送/消费/重放、原 ai 的 JWT/资料/权益通路及邮箱登录。失败关闭手机号开关，保留数据库映射、加密 key 和账本，不改邮箱。签名 key 配错会导致新 JWT 被 ai 拒绝，须在公开前排除。
6. **客户端入口**：网站已有 `p/js/phone-auth.js`，仍请求原 `https://api.sunland.dev/v1/phone/*`，无须换域名；验收后配置公开 Turnstile sitekey、仅开放登录页入口，绑定/解绑设置保持禁用。现有 Flutter lib 未发现手机号 API 调用，App 仍需接入手机号登录界面/请求；原 AI 和邮箱地址不变。本轮未修改或验收 App。

关闭 phone-auth 功能只影响手机号入口，不接管 `/send-code`、`/verify-code`、`/refresh` 或 AI 请求。已有邮箱用户不需要迁移、重新注册或更换 token。手机号密钥配置错误、过宽路由或错误操作数据库会产生实际风险，因此只部署上述独立配置；新账号独立导致“不继承原邮箱权益”是明确行为，不是数据丢失。
