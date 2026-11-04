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

1. **配置新 Worker 的 Secrets**：APP_JWT_LEGACY_SECRET 必须安全复制 ai 已认可的兼容签名值，不能另造一把 JWT key；不轮换 ai 密钥。配置 SUPABASE_SECRET_KEY、TURNSTILE_SECRET、PHONE_ALIYUN_ACCESS_KEY_ID/SECRET（STS 时另配 PHONE_ALIYUN_SECURITY_TOKEN）、PHONE_AUTH_HMAC_KEY、PHONE_AUTH_ADMIN_TOKEN、PHONE_IDENTITY_LOOKUP_KEY、PHONE_IDENTITY_ENCRYPTION_KEYS。全部经平台 Secret store/密码管理器，不进源码、参数或日志。
2. **配置 canary 参数**：PHONE_AUTH_HMAC_KEY_ID、PHONE_IDENTITY_LOOKUP_KEY_ID、PHONE_IDENTITY_ENCRYPTION_KEY_ID、PHONE_SMS_SIGN_NAME、PHONE_SMS_TEMPLATE_CODE；PHONE_AUTH_POLICY 的号码/IP/全局限流与每日/累计预算按真实资费填写；PHONE_SMS_CANARY_PHONE_HASHES 必须是 SMS HMAC key 对 `phone\0`+11位号码的摘要，不是 identity lookup 摘要。保持 canary，累计最多三次且失败不退。
3. **部署已完成**：独立 Worker、SQLite DO 迁移及精确路由已登记。补齐配置后保持三个开关 false，先复核配置；不重新部署 ai，不重复迁移，首次 DO 不自动建账。
4. **初始化**：单独授权对既有 sunland_phone_auth_config 的 lookup canary/key ID 初始化；这不是邮箱迁移。通过 POST `/v1/phone/_admin/initialize`，使用独立 PHONE_AUTH_ADMIN_TOKEN，初始化新 DO 账本；重复初始化 409，禁止清零已有状态。`/_admin/status` 仅返回成本汇总，仍须同一管理鉴权。
5. **受限实测**：明确授权短信/计费后，仅对允许号码启用 SMS、identity、注册开关；核验真实 Turnstile、发送/消费/重放、原 ai 的 JWT/资料/权益通路及邮箱登录。失败关闭手机号开关，保留数据库映射、加密 key 和账本，不改邮箱。签名 key 配错会导致新 JWT 被 ai 拒绝，须在公开前排除。
6. **客户端入口**：网站已有 `p/js/phone-auth.js`，仍请求原 `https://api.sunland.dev/v1/phone/*`，无须换域名；验收后配置公开 Turnstile sitekey、仅开放登录页入口，绑定/解绑设置保持禁用。现有 Flutter lib 未发现手机号 API 调用，App 仍需接入手机号登录界面/请求；原 AI 和邮箱地址不变。本轮未修改或验收 App。

关闭 phone-auth 功能只影响手机号入口，不接管 `/send-code`、`/verify-code`、`/refresh` 或 AI 请求。已有邮箱用户不需要迁移、重新注册或更换 token。手机号密钥配置错误、过宽路由或错误操作数据库会产生实际风险，因此只部署上述独立配置；新账号独立导致“不继承原邮箱权益”是明确行为，不是数据丢失。

## 受限短信实测前准备（2026-10-25，只读复核）

结论：**WAITING_FOR_USER_CONFIG**。生产版本、模块摘要、路由、SQLite DO 绑定与上文一致；三开关仍 false，DO 对象数 0。空 JSON 发码/验码请求均 503 / IDENTITY_DISABLED，OPTIONS 204，CORS 为 https://sunland.dev。本轮没有生产写入，没有创建用户、发送邮件/短信或初始化账本。未修改业务代码，不重复已通过的 1041 项测试或重建相同候选包。

### 六项专用 Secret（仅查询名称，六项均缺失）

| 准确名称 | 用途与格式要求 |
|---|---|
| PHONE_ALIYUN_ACCESS_KEY_ID | 阿里云号码认证服务 RAM AccessKey ID；仅授予所需发送/核验权限 |
| PHONE_ALIYUN_ACCESS_KEY_SECRET | 对应 AK Secret；走 Cloudflare Secret store，禁止放入命令参数、源码、日志 |
| PHONE_AUTH_HMAC_KEY | 短信号码/IP/会话/操作 HMAC，字符串至少 32 字符；与下面密钥分别生成 |
| PHONE_AUTH_ADMIN_TOKEN | 独立账本管理 Bearer，UTF-8 32–512 字节，不得复用 HMAC/lookup/供应商/Turnstile 密钥 |
| PHONE_IDENTITY_LOOKUP_KEY | 身份号码索引 HMAC，字符串至少 32 字符；建立映射后不能随意更换 |
| PHONE_IDENTITY_ENCRYPTION_KEYS | JSON 对象，key 为加密 key ID，value 为 32 字节 AES key 的规范无填充 base64url；最多 16 项；保留独立可取回副本 |

APP_JWT_LEGACY_SECRET、SUPABASE_SECRET_KEY、TURNSTILE_SECRET 已以 secret_text 存在，本轮未读取明文。STS 凭据另需 PHONE_ALIYUN_SECURITY_TOKEN；普通长期 AK 不设置该项。现有 JWT 配置复用证据见部署记录；本轮没有额外签发生产 token。

### 尚缺配置及已核实的行为

- 缺 PHONE_AUTH_HMAC_KEY_ID（1–32 位字母数字/下划线/短横线）、PHONE_IDENTITY_LOOKUP_KEY_ID、PHONE_IDENTITY_ENCRYPTION_KEY_ID（各 1–64 位；加密 ID 必须在 keyring 内）。这些 ID 不是阿里云 AccessKey ID。
- 缺 PHONE_SMS_SIGN_NAME、PHONE_SMS_TEMPLATE_CODE。使用**号码认证服务 PNVS 的短信认证**，Endpoint dypnsapi.aliyuncs.com，版本 2017-05-25；不是 dysmsapi 的 SendSms。控制台需确认服务已开通、签名模板获准并可用于目标号码，RAM 允许 dypns:SendSmsVerifyCode、dypns:CheckSmsVerifyCode（Resource=*）。模板变量必须兼容 code/min，代码固定传 {"code":"##code##","min":"5"}；六位数字、300 秒、Interval=60、DuplicatePolicy=1、ReturnVerifyCode=false、AutoRetry=0。登录 SchemeName=sl-login-v1，发送和核验保持相同；核验仅 Model.VerifyResult=PASS 成功。没有凭据，未访问阿里云账户或核实套餐/签名审批/实际单价。
- 缺 PHONE_SMS_CANARY_PHONE_HASHES：JSON 数组，首轮仅一个经用户确认的号码；HMAC-SHA256(PHONE_AUTH_HMAC_KEY, UTF8("phone" + NUL + 11位本地号码))，小写 hex。不得用 +86 号码或 lookup 摘要替代。实际号码、摘要均不写本报告。
- 缺 PHONE_AUTH_POLICY：八个正安全整数 perPhoneDaily、perIpDaily、dailyLimit、unitCostMicros、dailyBudgetMicros、totalBudgetMicros、ipRequestsPerMinute、globalRequestsPerMinute。费用单位为微元；以用户确认的真实含费单价上界 U 配置。首轮建议发送类上限最多 3，日/累计费用最多 3U；这只是待批准方案，本轮没有设定/扩大预算。分钟请求上限需容纳发送及核验，但不会放大发送上限。
- DO 全局账本持久累计最多三次 canary 预留，跨天/重启不重置；失败也不退配额与预算。号码服务端锁 600 秒，重复登录测试等至少 10 分钟；验证码 300 秒、最多五次核验、成功一次消费。供应商超时/结果未知保持隔离，停止实测，不自动重试、清账或换对象绕过。
- Turnstile 已有公开 widget 0x4AAAAAAC_W2Wj2YdkrQiMf，域名含 sunland.dev，模式 non-interactive。生产配置 PHONE_TURNSTILE_HOSTNAME=sunland.dev；代码核对 hostname、phone_login action、challenge_ts（最长五分钟、未来最多 30 秒）。Secret 存在不证明与此 widget 配对，明天须实际完成验证；今晚未调用 siteverify。
- 数据库只读确认：五张手机号业务表均 RLS 开启，无 anon/authenticated 表权限；service_role 对四张状态表 CRUD、配置表仅 SELECT。sunland_phone_identity(text,jsonb) 与 lifecycle 为 SECURITY INVOKER、固定 search_path，只有 service_role 可调用。两函数 prosrc MD5 分别 892b79b851ca1d06dcd4d7da064ef119 / 2673cddbf76b53348beedff9422730a3，与本地迁移函数体逐字节一致；号码唯一约束、user_id 主/外键有效，资料生命周期触发器启用。lookup_key_id、lookup_check 仍 NULL，runtime 无权自行初始化；没有执行 RPC 或读取用户内容。
- 新账号 SQL 创建独立 user_id、email=NULL，生产资料默认 pro=false、identity_status=active、is_banned=false、onboarding=0/1；无邮箱合并。签名、状态查询、刷新、数据库 token 与用量通路复用原 ai 契约，已有本地证据；此次未创建生产账号，真实登录/资料/权益读取仍待实测。
- 公开 sunland.dev/login.html 尚无手机号模块；公开 /p/js/phone-auth.js 当前返回首页 HTML（200 text/html），不能将 HTTP 200 当作脚本已发布。本地 login.html 与客户端已包含正确 api.sunland.dev/v1/phone/*，UI 开关 false、公开 sitekey 空。首轮用受控浏览器将 sunland.dev 的静态页面/依赖仅在本机映射至本仓库，并仅在该浏览器响应副本启用 UI/sitekey，保持真实 origin/hostname；不要从 file:// 或 localhost 直接请求冒充 sunland.dev，也不要先公开网站或绑定/解绑入口。公开网页实测需另行网站发布授权。

### 明天最短执行顺序（本轮均未执行）

1. 用户安全提供/配置阿里云 AK、确认已开通的签名模板与实际单价、确认唯一测试号码；新应用密钥在本地安全生成并独立保管，不经聊天传递。单独授权新 Worker 配置、数据库配置行初始化、DO 建账、canary 开关及短信费用/测试账号创建，ai 与邮箱继续不变。
2. 保持三开关 false，安全配置六 Secrets 和上述 ID、签名模板、一个号码白名单、明确预算；验证 Turnstile widget 配对，准备受控浏览器中的本地登录页面。配置修改会产生新版本，重新记录版本与仍相同的模块 SHA-256。
3. 仅在配置行仍为 NULL 且无已有手机号映射时，以绑定参数、单事务条件更新既有 singleton 行：lookup_key_id=选定 ID；lookup_check=HMAC-SHA256(lookup key, UTF8("sunland-phone-index-canary:v1" + NUL))。要求恰好更新一行并回读验证；已有不同值立即停止，禁止覆盖或改表/权限。
4. 在 canary 模式以独立管理鉴权 POST /v1/phone/_admin/initialize，JSON {}；预期 200、schema=1、enabled=true、test_reserved/total_micros/day_count/day_micros=0。初始化不需要开启短信开关；409 表示已有状态，立即停下，不换对象、不清账。不得提前调用 status：它也会实例化 DO，不能当作零副作用的健康检查。
5. 获准后仅开启 canary 的 identity/SMS/registration，先只做一次真实注册发送/核验，响应不写日志；确认 null-email 独立资料、原 ai 验签/刷新、数据库 token 与免费权益读取。间隔至少 10 分钟再做同号登录，验证同 ID、重放拒绝；最多三次预留，不自动补发。真正 AI 对话另需明确允许模型调用/用量写入，可先只读权益。
6. 任何异常立即将新 Worker 的三个开关恢复 false，停止发码；不删除映射、轮换身份密钥、重置 DO 或更改 ai/邮箱。结束后同样恢复 false，网站公开入口保持关闭，保存不含号码/token/密钥的结果。

依据：[阿里云发送接口](https://help.aliyun.com/en/pnvs/developer-reference/api-dypnsapi-2017-05-25-sendsmsverifycode)、[核验接口](https://help.aliyun.com/zh/pnvs/developer-reference/api-dypnsapi-2017-05-25-checksmsverifycode)。所有缺失值留待安全配置，没有填入占位生产值。

## Relay 模式（本地实现，未部署）

默认 `PHONE_SMS_PROVIDER=aliyun`，未设置时同样使用原 PNVS 的
`SendSmsVerifyCode` / `CheckSmsVerifyCode`。显式设为 `relay` 才启用中转；
空值、未知模式或所选模式缺少配置直接失败，不自动回退或切换供应商。

仅配置独立 `phone-auth` Worker：

| 配置 | 类型 | 含义 |
|---|---|---|
| PHONE_SMS_PROVIDER | 普通变量 | `aliyun`（默认）或 `relay` |
| SMS_RELAY_URL | 普通变量 | 经确认的 HTTPS 接口 URL，不含 URL 用户名、密码或 fragment |
| SUNLAND_SMS_RELAY_KEY | Secret | 平台 Secret store 配置，不放入 vars、源码、命令参数或日志 |

Relay 非敏感配置示例（地址须替换为已确认的实际端点）：

```json
{
  "PHONE_SMS_PROVIDER": "relay",
  "SMS_RELAY_URL": "https://sms-relay.example.invalid/send"
}
```

`SUNLAND_SMS_RELAY_KEY` 和阿里云 AK 均为按 provider 条件必需的 Secret，不列入全局 required 清单；
分别由对应适配器在调用前严格检查。阿里云模式仍要求原阿里云凭据及模板；relay 新发送不依赖阿里云凭据。
切换后若仍需校验在途阿里云 challenge，须保留阿里云配置。不要删除历史身份密钥。
原 identity/SMS/registration 开关、Turnstile、HMAC/key ID、canary 白名单和预算仍适用；
`unitCostMicros` 必须覆盖中转实际收费上界，不能假定接口内部无重试或额外计费。

中转只接收 POST JSON 的 `api_key`、11 位 `phone`、六位字符串 `code`、`scene`。
现有首次注册与登录共用 `purpose=login`，统一映射 `scene=login`；手机号再验
`purpose=reauth` 也使用 `scene=login`，内部 challenge/HMAC/会话仍按 reauth 隔离。
**上线前必须确认中转模板允许登录、首次注册及注销所需的手机号再验用途。**
不增加独立 register API；relay 拒绝 bind/change/unbind 发码，不静默降级。

仅 HTTP 2xx 且 JSON `ok === 1` 成功；不转发供应商 msg/request_id 或原始错误。
固定 8 秒总超时（包括响应体），禁止重定向、不自动重试。非成功响应、异常 JSON、
网络错误和超时都保留已预留费用及号码隔离；中转返回失败也不视为“确定未发送”。
隔离没有自动恢复接口，不按 TTL 解锁、不退款、不清账重试。

本地验证码使用 Web Crypto 安全随机数和拒绝采样生成；DO 仅保存绑定
challenge ID、手机号 HMAC、purpose 的带域 HMAC，不保存明文验证码、号码或 API Key。
保留 300 秒有效期、最多 5 次校验和原事务消费协议。每条 challenge 保存 provider，
校验按记录分流；历史缺 provider 的记录按 aliyun 处理。模式切换只影响新发送。
现有开关、配额和隔离均保留；不新增全局错误率熔断器。

### 本地验证（全部 Mock 出站）

```bash
node --test workers/phone-auth/tests/relay.test.mjs
node --test tests/phone-auth-provider.test.mjs tests/phone-auth-service.test.mjs tests/phone-release-policy.test.mjs tests/phone-auth-routes.test.mjs
node scripts/test-phone-workerd.mjs --standalone
node workers/phone-auth/tests/relay-workerd.mjs
```

workerd 验收使用临时本地 SQLite，测试结束删除临时目录；不连接生产 DO 或短信端点。
原本地 workerd 测试保持阿里云默认模式，新测试验证 relay 并发、重启、再验、模式切换、
预算及隔离。Node Mock 另覆盖失败/异常 JSON/HTTP/8 秒超时/过期/五次错误/摘要绑定。

### 部署与回滚边界

本轮不执行部署、配置 Secret、生产初始化或真实短信。之后如获单独部署授权，
沿用独立构建入口，输出到新候选目录，仅部署 phone-auth；保持原 DO 绑定、类名、
固定对象名及账本，不新增 DO 迁移、不重新 initialize，不部署主 ai Worker。

优先在这份兼容新旧 challenge 的代码上将 `PHONE_SMS_PROVIDER` 切回 `aliyun`，
恢复/保留原阿里云配置。此时在途 relay challenge 仍本地校验，旧阿里云 challenge
仍走 PNVS，不重置累计预算或号码锁。

紧急关闭使用 `PHONE_SMS_ENABLED=false`，必要时同时关闭
`PHONE_IDENTITY_ENABLED` / `PHONE_NEW_REGISTRATION_ENABLED`。关闭不能撤销已送达中转的请求。
若需回退到不认识 relay challenge 的历史代码，先关闭手机号入口，确认所有在途发送
终止且最后一次预留后至少 300 秒的 challenge 有效期已过，再回退并保持关闭复核。
不要在尚有 relay challenge 时直接回退旧代码：旧代码只会调用阿里云校验。
任何回滚均不得清空/重建 DO、退款配额、删除隔离记录或修改身份数据库/JWT。
