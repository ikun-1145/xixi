# Phase 6 受控部署交付与 Runbook

2026-10-25，Asia/Shanghai。结论 **BLOCKED**。本轮本地实现、配置、构建、校验、dry-run、测试已完成；唯一未解决的准备阻断是：安装屏障之前的生产旧 KV OTP 请求没有完整库存，也没有可证明它们全部结束的外部证据。不得把本地计数 0 当作历史排空。需要生产维护窗口中的平台终止/完整终态证据；本轮权限无法产生它。没有新增完整灾难恢复要求。

未部署 Worker/网站，未配置生产 Secrets、KV、DO、数据库或路由，未启用屏障、未发送验证码。Phase 4/5 结果不重做、不降级。新 Secrets、DO 建立及真实验收是下一次授权后的执行步骤，不因本轮禁止生产写入而要求额外一轮本地准备。

## 已完成的候选审计

只读生产仍为 `f405a850-780d-483f-8942-83e1798711fe` 100%。最新配置清单读取时间为 19:12:56；19:34:27 再次只读确认版本和 100% 比例未变。完整唯一 JS 模块已离线读取并比对分块摘要，UTF-8 SHA-256 为 `5f301dc9548735615c6f84f0f918e4f9820da082544d002798c35bb1a9fd67a2`。未读取或保存生产绑定中的秘密值。

从 Git `bc5489b6e2962f3e1306aa4de5b4292cecf7ca3d` 重建整个 Worker，经 esbuild 0.28.1 去空白/注释规范化后，与下载生产模块完整相等：`73217b53fa4f0424ee31634000ebbc74e046cb41408290fa8ce7897ab592d645`。这是完整规范化代码相等，原始字节不同。构建器每次硬校验此摘要，依赖或基线漂移即拒绝。

| 相对生产未部署变化 | 本轮处理 |
| --- | --- |
| index.js 的 web-search import 及五处业务接入、web-search.js | **全部排除**，不进入任何包 |
| OTP 输入/类型检查及 GeeTest 字段校验 | 纳入主包和 RPC 回退包 |
| email-otp.js、原子 reserve/delivery/challenge/consume、cleanup | 纳入主包和 RPC 回退包；两个来源文件校验既有固定 SHA |
| 原独立 otp-maintenance-gateway.js、staging-maintenance.js | 不进入业务包；以本轮配对的持久准入屏障替代旧无库存屏障 |
| 原 JWT、刷新、数据库 token、onboarding、Pro、AI quota、OC、chat、admin 等 | 九个业务源码均取生产对应 Git 基线；只对 index 做三处有唯一锚点的 OTP 区间替换和一处 cleanup 插入，其余不替换 |
| phone 模块与受控准入包装 | 手机号必需新增；原自建 JWT/user_id 体系保留，不引入第二套身份 |

没有覆盖相邻工程权威源码。基线/补丁 manifest 独立于此前完整 3398d88 候选，不冒称两个版本是同一源码。构建生成配置保留原 CODE_STORE/USAGE_KV 的实际 namespace ID、cron、version metadata、路由及 keep_vars；不带生产 Secret 值。

## 冻结产物与验证

目录：`/Users/liuxize/Developer/xixi/build/phone-controlled-deploy-20261025-verified/`。源构建器为 `scripts/build-controlled-phone-release.mjs`，只允许新绝对目录，拒绝覆盖、不自动部署。

| 包 | 邮箱权威 / 手机号 | SHA-256 |
| --- | --- | --- |
| main.mjs | RPC；三个开关默认 false，后续开启另行授权 | `4b275b177b7356a67da386a1fc9910bca11a7014e66953f954ff80c4c16962b5` |
| rollback.mjs | RPC；无论环境如何，强制关闭全部手机号路径 | `4b9aaa6186acb646126e26532fe6eba56430c4a76f9b60a34a1b9057587b9b94` |
| legacy-bridge.mjs | 旧 KV；仅切换前预备/取消切换使用，手机号强制关闭 | `5be842277e5883fe5e7539240c218db95966251cd2b484e8ea1cfe3dd2ed0c8e` |
| gateway.mjs | 独立屏障，默认 BLOCK；不持有数据库/Resend/JWT 密钥 | `1c37844830f2cf209cf0092c1a7c89baaf1e3eaebc1dee1c9d53e989cbee2246` |

三个业务包均导出同一 PhoneAuthCoordinator、保留相同绑定和 `phone-auth-v1` migration；均要求同一独立 OTP DO 的签名与一次性 claim，legacy-bridge 也不能绕过屏障。gateway-stage.json 先不绑定尚未创建的 PhoneDO，解决首次部署依赖环；gateway.json 是后续带内部 phone 管理绑定的配置。两份均 routes=[]、workers.dev/preview 关闭。

所有配置均 `no_bundle=true`；五份配置 dry-run 退出码 0。四个 dry-run JS 与对应冻结包 **逐字节一致**，不会在部署前被 Wrangler 再打包成不同摘要。manifest 含配置摘要，SHA256SUMS 的十个文件全部核验 OK。完整机器证据见 [受控部署证据](phase-6-controlled-evidence.json)。

- 最终 `npm test`：**1034/1034，0 失败/跳过**，新增受控包/屏障重点测试 10 项；覆盖全部手机号前缀关闭、无签名邮箱直连拒绝、主/回退真实本地 OTP SQL 的发送/消费/重放，以及原 ID/JWT/刷新/数据库 token。
- 真实本地 workerd + SQLite：准入先记账、错权威和重复 claim 拒绝、close 阻止新准入、在途完成才减计数、未知状态重启保留、关门再开门的代次隔离、phone 管理鉴权/只初始化一次通过。所有出站请求为 Mock，未连接生产。
- 独立只读审查发现并修复 control 丢失假归零、legacy 绕过和签名重放三项；回归通过。Pro 合成对象未变的断言只是本地证据；既有业务兼容性还依赖原业务源码保持生产基线，未声称真实会员账户已验收。

## 排空合同

独立 OtpMaintenanceGate 保存 mode、authority、generation、admitted/terminal/pending/unknown 和未完成记录；不保存邮箱/正文/验证码。请求正文仅保存带域隔离的 HMAC 摘要，不留可离线猜测六位验证码的裸摘要。

OTP 在任何上游副作用之前先持久准入；正文、路径、ID、代次和 legacy/rpc 权威绑定。来源 Worker 验签后必须原子 claim，重复/错权威拒绝。close 与准入使用同一事务；仍在读正文的旧请求不能在关门再开门后混入新代次。缺 control 但有残留记录、损坏状态均关闭，不重建零账本。

只有已 claim 且上游返回完整非 5xx 响应才终结；已审 OTP 分支没有未等待的 waitUntil continuation。传输/响应读取失败、5xx、终态保存失败保持 pending/UNKNOWN，**无 TTL 清零、无超时当完成**。供应商结果未知仍沿原 RPC 策略保留码/冷却，不能自动重发。

进入 RPC 切换的条件同时满足：

1. 独立入口 BLOCK 生效；workers.dev、preview、其他域名/路由、service binding 绕过已核清，不能只验证浏览器入口。
2. 当前 generation 固定，pending=0、unknown=0、admitted=terminal；这些只证明屏障登记后的请求。
3. 对安装前 `f405` 执行取得覆盖全部入口/地区及后续工作的权威终止记录，或完整请求终态审计；由获授权操作者审查并登记真实外部证据引用。`attest-legacy` 只是登记人工证明来源，**动作本身不是证明**，不能填本地测试的 synthetic 引用。

历史未知不能被新部署、安静日志、100% 流量或固定等待消除。目前第 3 条没有证据，所以本报告保持 BLOCKED。若平台不能提供，只能停止 RPC 切换并向用户报告；不得无限尝试或擅自降低标准。

## Secrets / canary / 内部账本清单

执行前使用 `node scripts/check-phone-deployment.mjs <冻结产物目录> <本次只读清单.json> --phone-canary`。它校验包/配置摘要、初始版本 100%、旧 KV ID、DO 回退配置、关闭开关与 cron；只输出缺失的名称，不读取/打印秘密。生产初始版本漂移则停下重新审查，不强行覆盖。它不假装证明 Secret 值有效。

- 邮箱闭门部署最小新增：独立高熵 OTP_GATEWAY_ADMIN_TOKEN（屏障）及 OTP_GATEWAY_AUTH_KEY（屏障和三个来源包配对）。通过平台 Secret store/密码管理器配置，至少 32 字节高熵，不复用 JWT、phone 或供应商密钥；现有 JWT/邮箱/Supabase 密钥不轮换。
- phone canary 后置：PHONE_ALIYUN_ACCESS_KEY_ID/SECRET，按需 SECURITY_TOKEN；PHONE_AUTH_HMAC_KEY/KEY_ID、PHONE_AUTH_ADMIN_TOKEN；PHONE_IDENTITY_LOOKUP_KEY/KEY_ID、ENCRYPTION_KEYS/ENCRYPTION_KEY_ID；PHONE_RELEASE_MODE=canary、SMS_CANARY_PHONE_HASHES、AUTH_POLICY、SMS_SIGN_NAME/TEMPLATE_CODE、TURNSTILE_HOSTNAME，已有 TURNSTILE_SECRET 须核配对。完整名称由预检输出。
- 策略八个正安全整数：perPhoneDaily、perIpDaily、dailyLimit、unitCostMicros、dailyBudgetMicros、totalBudgetMicros、ipRequestsPerMinute、globalRequestsPerMinute；unitCostMicros 用经核实的实际资费，不能用测试单价。固定对象 `sunland-phone-auth-v1`、账本 key `account`，首次建账需要独立 phone 管理令牌；已有状态一律不能重新初始化。
- 数据库 lookup canary 仍按 Phase 5 为 NULL；初始化是明确的后续数据库写入授权，不在本轮。lookup HMAC ID/canary 必须匹配，不允许运行时自动创建或轮换。新注册始终 false，首轮短信累计最多 3 次且失败不退预算。

## 最短生产 Runbook（本轮不执行）

**一次授权应明确覆盖**：新 Secret 配置、独立屏障和业务 Worker 部署、路由/service binding/SQLite DO 生命周期、受控管理调用，以及专用邮箱真实验收。数据库 canary、真实短信/计费和网站入口仍需明确纳入授权，不能推定包含。约定邮箱 OTP 维护窗口；刷新和已登录业务不整体停机。

1. 核对最新生产版本、完整绑定/路由/入口与 manifest，保留当前配置。安全配置两个新网关密钥，来源与网关共享正确的 AUTH_KEY；确认配置工具不会顺带发布其他未审版本。
2. 先以 **gateway-stage.json** 部署无路由屏障和其 SQLite DO，不绑定不存在的 PhoneDO。经批准挂接 `api.sunland.dev/send-code*`、`api.sunland.dev/verify-code*`、`api.sunland.dev/__ops/*`；首次状态必须 BLOCK。核对 OTP POST 返回 503/no-store，OPTIONS/CORS正常、`/refresh` 与非 OTP 业务不变，并核清其余入口。
3. BLOCK 下部署 **legacy-bridge.json**，建立 PhoneDO 类及同一 migration，邮箱仍为 KV、phone 强制关闭。再部署 gateway.json 补内部 phone 管理绑定。真实计数与来源 claim 从此有完整合同。首次 DO 创建后不要尝试一键退回不含 DO 的 f405。
4. 取得并审查历史外部终止证据，登记后执行 close，确认三个排空条件。**没有证据就停止**。若取消此次迁移，可保持 legacy-bridge、在新登记 pending/unknown 均为 0 时由操作者调用 resume-legacy 恢复相同旧权威，历史 UNKNOWN 仍在，不能据此切 RPC。
5. 排空通过后，可再等待旧码原有 300 秒有效期结束，并提示用户重新获取验证码；这只是旧码过期窗口，不能代替前一步排空证明。保持 BLOCK，部署 **main.json 到 100%**，核对代码/绑定/phone 关闭；执行 switch-rpc，核对 authority=rpc、新 generation。禁止 KV/RPC 百分比分流。错误权威即使误部署也不能 claim。
6. 用安全平台配置专用测试邮箱及操作者出口，执行 canary。测试请求必须带独立 OTP 管理 Bearer，同时匹配邮箱/IP；仍运行真实 GeeTest、邮件限流和消费。验收发送/消费/重放、原用户 ID、Pro、刷新及数据库 token。再 close 并核对 pending/unknown=0，按当前 generation 调用 open。
7. 邮箱稳定后才按授权配置 phone Secrets/策略/canary 和数据库 lookup canary；通过 `POST /__ops/phone/initialize`（PHONE_AUTH_ADMIN_TOKEN）只初始化新账本，409/503 都停查，绝不清零。`/status` 只读汇总合同虽为 POST，仍是 DO 管理操作。完成真实 DO/网关/Turnstile/CORS/短信与设备验收后，最后另行开放新注册和网站。

管理端点均在独立屏障的 `/__ops/otp/` 下，POST JSON；凭据仅经安全 HTTP 客户端内存头传递，不放 URL、命令行参数或日志。status/close 用空对象；canary/open/switch-rpc/resume-legacy 要求 status 返回的当前 generation；attest-legacy 要求固定 f405 version 和**真实已审**外部 reference。普通浏览器请求不能自行切模式。phone 管理只允许 initialize/status，独立令牌再由 PhoneDO复核。

## 失败与回退边界

- 默认/异常均 BLOCK，不自动清理 UNKNOWN 或重复发码。未知结果先保存版本、代次和聚合状态，停止推进；本轮未提供“清零修好”的入口。
- 尚未 switch-rpc：可以取消切换后恢复 **相同 KV 权威**，仅使用严格准入的 legacy-bridge 和 resume-legacy；这不是证明历史已排空。
- 已 switch-rpc：只允许 **rollback.json（RPC）**，同一 DO 类/绑定/migration、同一网关继续保留；不得回到 KV，resume-legacy 会被代码拒绝。BLOCK → 核实在途 → 部署兼容回退 → 专用邮箱验收 → 重新 OPEN；数据库加法对象和成本账本不删除、不重置。
- 已出现 phone-only 用户后，强制关闭 phone 的回退包及这些初次部署关闭配置不再适用；需保留手机号登录/注销能力前滚修复。这是既有用户保护边界，不扩大本轮为灾难恢复项目。

本轮交付完整；唯一准备阻断仍为历史 f405 OTP 请求的终止/完结证据。其余为已列明、必须在后续授权中执行的生产步骤。Git 提交见本报告历史和最终回复，原 Codex 配置改动及备份保留。
