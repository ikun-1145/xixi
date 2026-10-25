# Phase 6：Worker 上线准备

2026-10-25，Asia/Shanghai。**本轮本地准备完成，生产部署仍阻断**：`PHASE6_LOCAL_PREPARATION_VERIFIED_PRODUCTION_BLOCKED`。没有部署、切流、修改生产 Secrets/数据库/Storage、发送真实邮件或短信；手机号入口继续关闭。Phase 4 核心恢复和 Phase 5 数据库验收保持有效，本轮未重复灾难恢复。

## 当前生产与候选版本

Cloudflare 只读 API 于 15:19:35 核对生产 `ai`；后续补查路由、DO 和 Turnstile；15:30:48 复核版本/100% 比例未变、workers.dev 与预览均关闭、cron 为 `*/5 * * * *`。证据见 [结构化记录](phase-6-evidence.json)。

| 项目 | 生产 | 本地候选 |
| --- | --- | --- |
| Worker | `f405a850-780d-483f-8942-83e1798711fe`，100%；2026-10-11 部署 | 固定来源提交 `3398d8801efe93a2063536b0a5d460974a8fc65f` 的 18 个源码/package/lock 摘要全部匹配，再包装 phone 路由 |
| 脚本摘要 | Cloudflare etag `b269182f278b2c145e0ba7a3400134c4d0d68cd882abae19d30037ab231dbd9d` | bundle SHA-256 `4d93848139a1a8b02be7f5b2559ba5157e479916cf62e0bdc0495a25ed80ea25`；二者格式/构建不同，不能直接作源码等价比较 |
| 邮箱 OTP | bundle 有 CODE_STORE，无 sunland_otp | 只认 sunland_otp 原子 RPC；无 KV 降级 |
| PHONE / DO | PHONE_* 绑定数 0，无 phone 命名空间 | 导出 PhoneAuthCoordinator；固定对象名 `sunland-phone-auth-v1`，本地 SQLite 验证通过 |
| 入口 | `api.sunland.dev/* → ai`；无独立 OTP gateway | 本地产物 routes=[]、workers_dev=false、preview_urls=false、crons=[] |
| 运行时日期 | 2026-03-21 | 保持 2026-03-21，不顺带升级生产兼容日期 |

本地候选还包含原工程尚未部署的 web-search 模块（生产 bundle 无 web_search 标记），不是只向旧线上 bundle 插入手机号代码。发布前必须确认候选的完整发布范围；不得将旧 bundle 覆盖当前本地权威源码。已有 quota RPC 的生产存在性也已只读核对，不能将 web-search 标记差异推断为全部源码差异清单。

## 邮箱兼容性与切换边界

Phase 5 实际提交和权限证据见 [数据库交付](PHASE-5-DELIVERY.md)。本轮再次只读核对 `sunland_otp`、cleanup、phone identity、user_onboarding 及三个 ai_quota RPC 均存在，service_role 有 EXECUTE；没有调用任何业务 RPC。主 OTP 参数与本地六参数契约匹配；`sb_secret_` 服务端 key 仅放 apikey，保留原数据库访问适配。

phone wrapper 在读取 body 前把非手机号请求和 OPTIONS 原样交给既有 Worker，并保留 scheduled。邮箱仍使用 GeeTest，手机号才使用 Turnstile。登录、刷新和数据库 JWT 复用原 helper、用户 ID 与响应契约；签发仍优先 APP_JWT_LEGACY_SECRET/JWT_SECRET，验签保留 PRIMARY/LEGACY/JWT_SECRET。部署不能顺带轮换密钥、改变优先级或移除既有绑定。

新 OTP 在发邮件前原子预留，消费一次；RPC 故障返回 503，不读旧 KV；Resend 超时/未知结果保留挑战和冷却，不自动重发。真实发码和登录没有执行，本地 Mock 不能证明生产凭据、邮箱投递或 PostgREST 网关有效。

**必须维护窗口**：KV 与 RPC 的验证码/HMAC/消费权威不兼容，禁止百分比分流或以 KV 作为失败回退。AI_MAINTENANCE 不覆盖 OTP，不能代替独立入口屏障。相邻工程的 `otp-maintenance-gateway.js` 已有默认 BLOCK/CANARY 实现，但生产无该 Worker/路由，当前配置 routes=[]。

原 runbook 仍标记 `legacy_before_gateway=UNKNOWN`：旧版本缺完整持久准入/终态记录，固定等待、日志计数或新版 100% 不能证明所有旧调用/后台 continuation 排空。本轮没有构造排空证明；实际切换前必须落实可审查的入口覆盖及排空/终止证据，否则停在 BLOCK，不冒险开放新权威。CANARY 还需专用邮箱、可信操作者出口及平台侧拒绝 Worker 子请求；不能只靠请求头判断。参见相邻工程 `worker/otp-maintenance.md`。

## 配置核对

| 类别 | 准备要求 | 当前证据 |
| --- | --- | --- |
| 关闭开关 | PHONE_IDENTITY_ENABLED、PHONE_SMS_ENABLED、PHONE_NEW_REGISTRATION_ENABLED 严格字符串 true 才开启 | 生产均缺失；本地准备配置显式 false。login/settings 的 phone-ui-enabled 仍 false，sitekey 为空 |
| 身份 Secrets | PHONE_IDENTITY_LOOKUP_KEY、PHONE_IDENTITY_ENCRYPTION_KEYS、PHONE_AUTH_HMAC_KEY、独立 PHONE_AUTH_ADMIN_TOKEN | 全部缺失；本轮未生成或设置；lookup key 不得随意轮换 |
| Key ID / canary | LOOKUP_KEY_ID、ENCRYPTION_KEY_ID、AUTH_HMAC_KEY_ID 与数据库/账本一致 | 缺配置；Phase 5 数据库 canary 未初始化，需单独数据库写入授权 |
| 阿里云 | PHONE_ALIYUN_ACCESS_KEY_ID/SECRET、必要时 SECURITY_TOKEN；SIGN_NAME、TEMPLATE_CODE | PHONE 项全部缺失；RAM、模板、签名、资费没有真实验收 |
| 发布策略 | PHONE_RELEASE_MODE=canary；PHONE_SMS_CANARY_PHONE_HASHES 为号码 HMAC allowlist；PHONE_AUTH_POLICY、PHONE_API_TIMEOUT_MS | 缺配置；首轮不得 public，canary 累计最多 3 次，失败也计数 |
| Turnstile | TURNSTILE_SECRET、PHONE_TURNSTILE_HOSTNAME；前端专用 action | 已有 TURNSTILE_SECRET 绑定及允许 sunland.dev 的 widget，但未验证 secret 配对；PHONE hostname 缺失 |
| Durable Object | PHONE_AUTH_COORDINATOR → PhoneAuthCoordinator；SQLite class lifecycle | 生产无绑定/命名空间；本地配置及 workerd 验证通过，云端未验收 |
| 既有依赖 | JWT/Resend/GeeTest/Supabase key、CODE_STORE/USAGE_KV、路由、cron、version metadata、vars | 绑定名称存在，origin/project 匹配；未读取/导出 Secret 值，不能据名称声称凭据有效 |

完整 PHONE 名称见源码及 Phase 1/2 契约。独立账本 `/initialize`、`/status` 只在内部 DO 接口，公开 `/v1/phone/*` 不转发管理操作；未来需另审的内部运维通路及操作授权，不能直接向公网 URL POST 初始化。本地配置不能替代生产配置；生产应在完整保留既有配置的基础上审核新增项，不能用本地空 KV/cron/routes 覆盖 ai。

## 安全检查与实际测试

- Turnstile 校验 success、hostname、用途 action 和 300 秒时间窗，之后才预留付费预算；号码/IP/全局请求限流及每日/总预算先持久扣留，供应商失败不退。
- 同号全局冷却 600 秒，挑战 300 秒、最多 5 次验证；绑定号码、用途和可信会话；PASS 才认证。超时/未知发送结果保持隔离，不自动降级或重试发送。
- 敏感变更使用当前因子、会话绑定的一次性 grant 和幂等 operation；手机号模块不记录明文号码/OTP/凭证。CORS 继承原 Worker 固定 origin；它不是身份验证或原生客户端安全边界。
- 无配置/绑定/账本、密钥 ID 不符、账本损坏、时钟回退均失败关闭。初始化拒绝已有状态，不提供清零预算恢复；丢账本或未知上游状态须独立审核恢复。

| 实际执行 | 结果与范围 |
| --- | --- |
| `npm test` | 1024/1024，0 失败/跳过；含 provider、路由、默认关闭、SQL/实际原 Worker 包装集成、限流/重放/超时/CORS 回归 |
| 相邻原 Worker 邮箱/输入/身份/引导及 OTP gateway 五个测试文件 | 81/81，0 失败；全部 Mock 网络 |
| `node scripts/test-phone-workerd.mjs` | 真实本地 workerd + SQLite：默认关闭、缺账本关闭、独立管理鉴权、并发初始化只一次、重启保留账本/成本/canary 计数、3 次 cap、并发消费只成功一次；出站全部 Mock，未连接生产 |
| `wrangler deploy --dry-run`，仅 local-only 配置 | 通过；441.70 KiB / gzip 109.61 KiB；退出码 0，无 upload/deployment |
| Node 语法、JSON、`git diff --check` | 通过 |
| 独立只读审查 | 原安全链路、邮箱兼容/维护边界及新增两个本地脚本均完成；未发现新的可复现阻断性源码问题 |

本地依赖为 Wrangler 4.120.1、esbuild 0.28.1、已安装的 Miniflare 5.20260804.0-alpha（使用其 V4 兼容转换，持久路径按当前 API 配置）。未安装/升级依赖。此本地运行时证据不等于 Cloudflare 云端 DO、真实 JWT 网关或真实供应商验收。

## 可复用产物

新增 `scripts/prepare-phone-worker.mjs` 仅生成新绝对目录，mkdir/wx 拒绝覆盖，输出权限 0600、目录 0700；不执行 Wrangler、不读取 Secrets。用法：`node scripts/prepare-phone-worker.mjs /absolute/new-directory`。需要既有固定内容的相邻 Worker 工程及其依赖，可用原 SUNLAND_AUTH_WORKER_ROOT 指定。

本轮产物位于 `/Users/liuxize/Developer/xixi/build/phone-auth-phase6-20261025T072358Z/`：worker.mjs、manifest.json、wrangler.json 和 dry-run 输出。build 目录 Git 忽略，代码不含生产凭据；源生成器和测试纳入提交。local-only 配置无公网路由、无云端绑定 ID、无生产 URL/Secrets；不得直接当作 ai 生产部署配置。

## 下一次生产操作的最短安全顺序

1. **先解决技术阻断并取得明确授权**：确认完整候选发布范围、生产合并配置、独立 OTP 屏障和旧请求排空/终止方案；冻结现版本、绑定清单及兼容恢复包。技术证据未齐不得进入切换。
2. **DO 生命周期预备单独处理**：优先在保持旧邮箱权威的兼容包中预建 SQLite DO 类/绑定，三开关保持 false，短信不发、新账户不建。该兼容包须先本地审查冻结，当前只有计划，没有伪造其已完成产物。首次 class lifecycle 改变与邮箱权威切换应拆开；没有必要为关闭状态强制先配置所有供应商 Secrets。
3. **邮箱维护窗口**：部署并覆盖全部 OTP 入口的独立 BLOCK，验证 OPTIONS/CORS、不影响刷新/已登录业务，完成旧调用终止证据。然后把经过审核的兼容 Worker 切到 100%（不能 KV/RPC 混跑），通过专用邮箱 CANARY 的发送/消费/重放、既有用户 ID/Pro、refresh/数据库 JWT 验收后才 OPEN。真实邮件测试需要授权。
4. **手机号后置开启**：另行授权设置 PHONE Secrets/参数、数据库 lookup canary 及内部 DO 首次建账；核对不可重置的成本账本和实际单价。先 canary allowlist 与 3 次上限，真实短信/计费、JWT/PostgREST、Turnstile、CORS、移动设备通过后，再授权网站入口和新注册。此步不与邮箱首次切换捆绑。

**回退**：先 BLOCK OTP、停止新流量并确认在途状态；数据库加法对象和 DO 账本保留，不执行 DOWN、不删 namespace/清零成本。新 RPC 权威用过后不能直接 OPEN 旧 KV，也不能无屏障百分比回滚；优先修复前滚或部署保留 RPC/DO 的兼容版本。出现 phone-only 用户后必须保留手机号登录/注销能力。

Cloudflare 明确 class lifecycle 改变后不能回滚到该改变之前的版本，所以不能承诺直接一键回到旧 f405。正式首次 DO 部署前必须冻结保留同一 DO 类/namespace 的回退代码和配置。依据：[官方 DO 部署限制](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/with-durable-objects/)、[SQLite DO 配置](https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/)。本地产物沿用已安装 Wrangler 支持的 new_sqlite_classes，不混用新 exports 配置模型。

## 最终停止点

本轮上线准备和本地验证完成；**生产部署授权、OTP 切换屏障/排空、DO 兼容回退包、PHONE 配置/初始化及真实链路验收仍未完成**。不声称手机号已上线或邮箱新权威已生效。Git 提交见本报告历史；原有 Codex 配置改动与备份保留，不纳入提交。
