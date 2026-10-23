# 中国大陆手机号认证：Phase 0 审计与阻断说明

> 2026-10-24 更新：A Team 已非破坏性初始化并提交 `be0422e`，Supabase 只读元数据查询已恢复；下文此前的工作流/连接阻断属于历史记录。当前实况证据见 `supabase-schema-evidence.json`，Phase 1 实施与验证见 `PHASE-1-DELIVERY.md`。旧会话方案疑问已由用户明确解决，不迁移 Supabase Auth。Phase 2 继续不在本轮实施范围。

> 2026-10-21 续开发需求更新：用户已明确保留现有应用 JWT、数据库令牌及 `user_profiles.user_id`，禁止迁移到 Supabase Auth。下文关于“是否要求原生 Supabase Auth session”的待确认事项已解除，以本更新和 `00-stage.json` 为准。数据库访问缺失只阻断依赖当前结构的身份映射和迁移，不应阻断独立短信封装；但本轮另遇下述必需工作流阻断，尚未开始实现。
>
> 当前可调用工具仍没有 Supabase 元数据查询能力；现有 `.codex/config.toml` 已配置限定项目 `klyrasrqgxijwrxuoevj` 的只读连接，无须提供 service-role 密钥或开放写权限。只需恢复该连接，查询表、约束、索引、触发器、RLS、RPC 和相关迁移状态，不读取真实用户行。
>
> A Team 当前强制要求实施与审查专家通过名单校验，但项目缺少 `INIT.md`、`.agent-sync/TEAM.md`、`.agent-sync/ROUTING.md` 和 `scripts/roster.py`；实际执行 `python3 scripts/roster.py verify` 因脚本不存在退出，不能派发必需专家。需先由用户批准初始化该工作流；本轮未创建团队配置、执行代码、数据库迁移或生产变更。独立 Phase 1 在此工作流恢复后可先实施，真实短信发送保持关闭。

日期：2026-10-21。基线：`main`，`f73dbe1c2b098b5494a07fd2fa6c28c561615f1a`。

更新：用户重启后，Cloudflare MCP 已恢复；已读取实际认证 Worker。原“无法审计后端”阻断已解除，剩余方案差异与数据库证据见第 7 节。此前审计提交为 `00687f2`。

结论：**暂停进入 Phase 1–4，尚未交付手机号认证功能，不具备上线条件。**

附件明确要求：不能安全兼容原身份、不能建立兼容真实会话时先暂停报告。本次仅保存审计和阶段状态，不更改认证、页面、Worker、迁移或云端配置。没有发送短信、使用真实 AccessKey、查询用户行数据、执行生产迁移或修改 Flutter。

## 1. 实际架构与证据

| 审计项 | 当前代码证据 | 对手机号接入的影响 |
| --- | --- | --- |
| 邮箱注册/登录 | `login.html` 调用 `/send-code`、`/verify-code`；Cloudflare `ai` Worker 的 `getOrCreateLoginUser` 按邮箱查询 active profile，新建时生成 UUID | 已从实际 Worker 核实，原账号键取 `user_profiles.user_id`；详见第 7 节 |
| 人机验证 | `login.html` 的 `runCaptcha()` 使用 GeeTest v4 | 不是 Turnstile；不能假定可复用为短信风控 |
| 登录持久化 | `login.html` 保存 `localStorage.token/user`；`ai/verified-identity.js` 通过远端 `/refresh` 确认身份 | 本地 user 缓存不是可信身份，不能用手机号或客户端 user_id 替代 |
| 刷新与竞态 | `ai/verified-identity.js` 的 `_resolveFromServer` 校验服务端结果与 token 身份一致；`ai/app.js` 使用会话 generation 和请求上下文隔离 | 新流程必须复用这些保护，支持账号切换、登出和同用户续期 |
| Supabase Auth | `p/js/supabaseClient.js` 的 `supabase` 管理 OAuth session；`donate.html` 使用 `supabase.auth.getSession()` | OAuth 体系不能直接当作 AI 邮箱登录体系 |
| AI 数据凭证 | 同文件另建 `supabaseData`，通过 `SunlandDatabaseToken.get()` 获取凭证；`ai/database-token-client.js` POST `/v1/database-token` | 当前已不是文档所述的单纯 anon 数据访问；不能沿用旧文档推断生产 RLS |
| 数据 token 声明 | `ai/database-token-client.js` 要求 `role/aud=authenticated`、`id` 等于应用 user ID、有效 `exp` | 普通 Supabase Auth session 是否可通过现有校验，没有证据 |
| 用户 ID | `ai/user-identity.js` 接受受限字符串；实际 Worker 使用 profile 现有 user_id，首次创建使用 `crypto.randomUUID()` | 登录路径不创建 Supabase Auth 用户；UUID 外形不代表与 `auth.users.id` 建立关联 |
| 用户资料 | `ai_settings.html` 按 `user_id` 访问 `user_profiles`；`ai/app.js` 按用户隔离 profile 缓存 | 必须保持原键、头像、昵称和用户状态 |
| 聊天/历史 | `ai/history-sync.js` 的 `HistorySync` 按 `this.userId` 过滤记录并通过 RPC 同步；`ai/app.js` 按已验证用户创建同步上下文 | 创建另一身份会形成另一数据命名空间；不能通过复制记录补救 |
| Pro/激活码 | `supabase/migrations/20260905014430_pro_payment_activation_reliability.sql` 用 `auth.jwt()->>'id'` 关联用户；`workers/afdianpay/worker.js` 信任远端 `/v1/account/identity` | 必须由同一身份权威返回原 user ID，不能修改权益归属 |
| 注销 | `supabase/functions/sunland-account-delete/index.ts` 的 `handleAuthorize` 强制邮箱格式并调用 `/verify-code`，比较验证码身份与当前身份；另依赖 `/v1/account-delete/*` | 无邮箱手机号用户目前无法完成注销，须同步支持手机二次验证和删除绑定 |
| 登出 | `ai/account-menu.js` 清理本地 token/user、调用 `clearVerifiedSession()`；OAuth 使用独立退出流程 | 不能声称本地退出已吊销所有设备；服务端多设备语义须审计 |
| Worker 中间件/JWT 签发 | 本地仓库没有源码，但已通过 Cloudflare MCP 读取 `ai` 部署包，核实邮箱登录、HS256、刷新、身份查询与数据库 token 交换 | 源码访问阻断已解除；当前应用 JWT 与 Supabase Auth session 的区别见第 7 节 |
| 迁移机制 | 存在按时间戳命名的 `supabase/migrations/*.sql`，使用事务、服务端 RPC、RLS 和权限限制 | 可编写增量迁移，但必须先明确身份主表和注销的当前定义；本次未生成可执行迁移 |
| 限流/预算 | `functions/api/verify.js` 有其他业务的可选 `VERIFY_RATE_LIMITER`；未找到短信强一致预算和 OTP challenge 实现 | 可选且缺失时放行的业务限流不能用于付费短信；普通 KV 也不能承担原子预算 |
| 多语言/移动端 | `p/js/site-i18n.js` 支持 `zh/zh-Hant/en/ja/ko/es`；登录/设置页加载该运行时；登录页复用现有字段和 modal CSS | 至少满足附件中英日要求，不能损坏原有六语言；设置页部分区域有 `data-site-i18n-ignore`，新增文案须显式覆盖 |

本轮未连接 Supabase 元数据工具：当前会话未暴露该工具。`.codex/config.toml` 虽配置项目 `klyrasrqgxijwrxuoevj` 只读 MCP，并不等于已取得数据库实况。现有表、索引、触发器、RLS、Auth 配置及迁移执行状态都不能仅凭历史项目说明视为已核实。

项目说明还含“无 package.json”“AI 表直接匿名访问”等过时描述；本次以实际 `package.json`、双客户端和数据库 token 交换代码为准，没有宣称当前生产表仍未开启 RLS。

## 2. 阿里云官方文档核实

本轮实际调用了已连接 MCP 的 `AlibabaCloud___GetApiDefinition`（两个目标 API）、`AlibabaCloud___SearchDocuments` 和 `AlibabaCloud___GetDocument`。只查询文档，没有执行任何短信 API。

产品为 `Dypnsapi`，版本 `2017-05-25`，不能替换为 `Dysmsapi/SendSms`。

### SendSmsVerifyCode

- 必填：`PhoneNumber`、`SignName`、`TemplateCode`、`TemplateParam`。
- 使用阿里云动态验证码须传模板占位符 `##code##`，并明确指定 `CodeType`。自定义具体验证码虽然可以发送，但 **CheckSmsVerifyCode 无法校验这种验证码**。
- `CountryCode` 默认 `86`，当前仅支持国内号码发送；`SchemeName` 最多 20 字符，校验须保持一致。
- `CodeLength` 为 4–8 位，默认 4；若实施拟显式使用 6 位数字。
- `ValidTime` 默认 300 秒；`Interval` 默认 60 秒。
- `DuplicatePolicy=1` 覆盖旧码，`2` 保留多个有效码；应使用覆盖策略。
- `ReturnVerifyCode` 默认 false，生产必须不返回到浏览器或日志；`AutoRetry` 默认开启，预算评估必须考虑供应商重试语义，不能自己盲目重发。
- 响应检查 `Success`、`Code`，结果含 `Model.BizId/OutId/RequestId`；发送成功不是用户认证成功。

来源：[发送接口](https://help.aliyun.com/zh/pnvs/developer-reference/api-dypnsapi-2017-05-25-sendsmsverifycode)。

### CheckSmsVerifyCode

- 必填：`PhoneNumber`、`VerifyCode`；可传 `CountryCode/SchemeName/OutId/CaseAuthPolicy`。
- `Code=OK` 或 `Success=true` 仅代表调用成功，**仅 `Model.VerifyResult=PASS` 表示验证码验证成功**；`UNKNOWN` 表示核验失败。
- 两个接口的定义和已读取说明没有明确承诺“PASS 后立即不可重用”，不能把供应商当作应用侧重放保护。必须设计原子消费 challenge、用途/用户/手机号绑定及失败次数上限；`OutId` 仅按已证实的外部流水号处理，不能擅自当作防重放或核验隔离凭证。

来源：[核验接口](https://help.aliyun.com/zh/pnvs/developer-reference/api-dypnsapi-2017-05-25-checksmsverifycode)。

### 错误、地域、权限及计费

- API 定义列出 `MOBILE_NUMBER_ILLEGAL`、`BUSINESS_LIMIT_CONTROL`、`FREQUENCY_FAIL`、`INVALID_PARAMETERS`、`FUNCTION_NOT_OPENED`；返回码文档另列 `isv.ValidateFail`、`biz.FREQUENCY`、`isv.BUSINESS_LIMIT_CONTROL`。未来应归一化为稳定本地错误码，不能把供应商原始错误透传到 UI。
- `isv.ValidateFail` 涵盖错误、过期、覆盖，不能从这一错误精确推断“必然过期”；应用应结合自身 TTL 提示。
- RAM 操作：`dypns:SendSmsVerifyCode`、`dypns:CheckSmsVerifyCode`，资源 `*`。本次没有创建权限或凭证。
- 官方接入点为 `dypnsapi.aliyuncs.com`，地域列表包含 `cn-hangzhou` 等；最终签名地域应与 SDK/配置确认，未开展真实连通测试。
- 短信认证按运营商回执计费，核验免费；读取到的 API 版按量价最低用量档为 0.06 元/次。该价格不是本项目实际账单或预算配置，套餐和附加服务需上线前复核。

来源：[返回码](https://help.aliyun.com/zh/pnvs/developer-reference/api-return-code)、[服务接入点](https://help.aliyun.com/zh/pnvs/developer-reference/api-dypnsapi-2017-05-25-endpoint)、[产品计费](https://help.aliyun.com/zh/pnvs/product-overview/product-pricing)。

## 3. Supabase 官方方案与阻断

官方手机号登录通过 `signInWithOtp` 发起并由 `verifyOtp` 验证后建立 session。Send SMS Hook 的输入含 Supabase 已生成的 `sms.otp`，负责发送，成功输出是空响应；它不是“接受第三方 OTP 验证结果并创建原用户 session”的接口。

将 Supabase OTP 作为具体值交给阿里云发送，会与本次必须使用 `CheckSmsVerifyCode` 核验的条件冲突。反过来让阿里云生成验证码并返回 Hook，也没有已核实的官方契约允许替换 Supabase 内部 OTP。`admin.createUser({phone_confirm:true})` 是创建用户，不能据此声称建立了兼容原系统的登录会话。

来源：[Send SMS Hook](https://supabase.com/docs/guides/auth/auth-hooks/send-sms-hook)、[Phone sign-in](https://supabase.com/docs/guides/auth/phone-login)、[Admin createUser](https://supabase.com/docs/reference/javascript/auth-admin-createuser)。官方维护的开源实现/文档入口：[supabase/supabase](https://github.com/supabase/supabase/blob/master/apps/docs/content/guides/auth/auth-hooks/send-sms-hook.mdx)。本次尚未进入实现选型，不把其他项目方案直接移植。

**这是当前组合和证据不足的阻断，不是“Supabase 永远无法集成阿里云”的结论。** 后续 MCP 审计已核实现有签发链路，详见第 7 节；保留现有身份权威的服务端映射方案有可行方向，但它不会自动产生 Supabase Auth session。不能新建第二套 JWT、伪造邮箱 OTP 或自动合并账号。

## 4. 解阻后的最小设计方向（待认证证据确认，未实现）

1. 以现有可信内部 ID 为唯一账号键；邮箱/手机是服务端认证因子。绑定必须从已验证 Bearer 会话取得用户 ID，不接受浏览器指定身份；禁止自动合并。
2. 在现有认证 Worker 增加统一 `/v1/…` 契约，覆盖发送、登录/首次注册、当前绑定状态、绑定、更换、解绑和敏感操作验证。具体路径/字段必须先提供 OpenAPI 并复核；本次没有新增可调用接口。
3. 首次注册和绑定必须使用数据库事务与唯一约束，冲突返回“该手机号已绑定其他账号”。对账号生命周期加锁，防止与注销竞态。手机登录复用既有签发/刷新和数据库凭证交换。
4. 更换/解绑要求新鲜二次认证；手机号唯一登录方式不得解绑。只判断 email 字段非空不等于存在有效邮箱恢复方式，须有权威验证记录。手机号用户还须能安全补绑邮箱，不能用虚拟邮箱填充。
5. 限流候选为单一协调 Durable Object 的持久事务，或同一数据库事务中的原子配额预留；手机号/IP/匿名会话/设备及全局预算必须整体裁决后才调用供应商。所有入口共享同一预算权威，不能多个实例各算全局额度。状态存储不可用时拒绝发送，供应商超时保守占用预算，避免退款后重发突破上限。
6. Turnstile 在服务端验证成功、预期 hostname/action 正确后才进入发送；缺 secret/缺配额配置/缺存储/关闭开关都拒绝发送。匿名设备标识必须由服务端签发，不能当作可信用户身份。
7. challenge 区分登录、绑定、更换和二次验证，绑定用户、用途、规范化手机号、TTL 和尝试次数；原子认领验证和消费，禁止并发验证/重放。供应商校验成功但数据库事务失败，要求重取验证码，不允许复用通过状态。
8. 原手机号隐私：服务端受控加密保存，查询唯一性采用带密钥 HMAC，UI 只返回掩码；不在普通前端表暴露完整手机号，不使用可枚举的裸手机号哈希。密钥轮换和唯一性迁移需另行设计。
9. 迁移候选是服务端专用认证因子/challenge/配额记录，默认拒绝 anon/authenticated 直读写；不改现有数据格式、权益或现有 RLS。具体 SQL 须等身份表、注销 RPC 当前定义和生产元数据确认后编写。
10. 手机认证、绑定变更和注销使用相同用户生命周期锁/版本；注销清理因子并吊销挑战和会话，不能保留可重新进入原账号的映射。

## 5. 验证与交付状态

已运行现有认证/竞态/数据库 token/注销安全/退出相关测试：**82 通过，0 失败，0 跳过**。

```sh
node --test tests/ai-login-flow.test.mjs tests/ai-session-race.test.mjs tests/ai-verified-identity.test.mjs tests/ai-database-token.test.mjs tests/auth-state.test.mjs tests/auth-callback-logging.test.mjs tests/ai-account-delete-security.test.mjs tests/logout-flow.test.mjs
```

这只是现有实现的本地基线，未新增手机号测试，也不代表生产身份、真实短信、多设备或真实手机验收。没有修改执行代码，未运行全量 `npm test` 或浏览器 UI 验收。

| 附件要求的交付 | 本轮状态 |
| --- | --- |
| 注册/登录/绑定/更换/解绑/持久化 | 未实现，身份兼容门禁阻断 |
| 修改文件 | 仅本目录 `00-stage.json`、`PHASE-0-AUDIT.md`、`cloudflare-auth-evidence.json` |
| 新后端接口 | 无 |
| 数据库迁移 | 无可执行 SQL；仅上述设计约束，不允许直接生产执行 |
| 身份兼容方案 | Worker 原身份签发链路已审计，扩展手机号因子为候选；仍待数据库核验和会话要求澄清 |
| 防刷/预算 | 仅设计方向，未部署、未实现，不能视为防护已生效 |
| 测试报告 | 上述 82 项现有基线；附件手机号验收清单全部仍待实现与 Mock 测试 |
| 已知问题 | 已能审计后端签发/刷新；尚须明确会话要求、核实生产结构/RLS；供应商成功后重用语义未证实；注销仅邮箱 |
| Secrets | 本次未新增。未来候选仅名称：受限服务端阿里云凭证、Turnstile secret、手机号加密/HMAC 密钥、服务端数据库凭证；最终绑定名与既有认证密钥复用规则待后端审计，禁止索取或使用真实值 |
| 上线步骤 | 先解阻、合同审查、离线 Mock 与本地事务并发测试、测试环境兼容验收；正式上线仍须独立授权迁移和部署，并明确授权单次真实短信测试及费用 |
| 回滚 | 本次仅文档，无运行时回滚或数据恢复。未来先关闭手机入口/发送开关并回滚 Worker，保留已绑定数据和兼容读取；不得删除手机唯一登录因子而锁死用户，SQL 回滚方案须随最终迁移提供 |

阶段工具限制：当前未暴露 full-stack 工作区生成/阶段审核 MCP，因此这里只记录人工审计状态，不声明任何自动阶段门禁已通过。仓库也没有 `INIT.md`、`.agent-sync/TEAM.md`、`.agent-sync/ROUTING.md`、`scripts/roster.py`，未擅自初始化团队或派发 A Team 专家；未修改 Skills/MCP 配置。

## 6. 继续所需的最小输入

认证 Worker 已通过用户授权的 Cloudflare MCP 读取，不再要求用户提供源码。仍须补充 Supabase 只读结构证据（字段、约束、RLS、触发器和相关 RPC，不需用户行数据），并明确“真实会话”是否指 Supabase Auth 原生 session。

取得以上证据后，先决定“保留现有应用身份权威并扩展因子”能否满足附件对真实会话的要求，再决定是否需要单独讨论迁移到 Supabase Auth；不会擅自切换认证服务。

## 7. Cloudflare MCP 恢复后的实际后端核验

2026-10-21 只读确认 `api.sunland.dev/*` 指向 Worker `ai`；最新部署记录为 `b06e00b1-78f2-4939-9160-bab2428d71de`，版本 `f405a850-780d-483f-8942-83e1798711fe` 占 100%。该部署记录创建于 `2026-10-11T11:33:51.891286Z`。读取 settings 时仅输出 binding 名称/类型和项目 URL，没有输出或使用密钥值。

保存证据：[cloudflare-auth-evidence.json](cloudflare-auth-evidence.json)。行号对应此次下载的 multipart 部署包，不能当作原始开发源码行号。

- **8056–8082 行：** `getOrCreateLoginUser` 按规范化邮箱和 `identity_status=active` 查 `user_profiles`，存在则返回原 `user_id`；否则 `crypto.randomUUID()` 后插入 profile，遇 409 再查胜出记录。该登录路径没有调用 Supabase Auth 创建用户或登录会话。`limit=1` 本身也不能证明邮箱唯一约束存在，须核实数据库。
- **8415–8431 行：** 邮箱验证码通过后，调用该函数取得 profile ID，使用现有 `signJWT({email,id}, signingSecret)` 返回应用 token。
- **8432–8447 行：** `/refresh` 先验证应用 JWT 和用户状态，再签发同 ID 的新 token；没有兑换 Supabase Auth refresh_token。
- **8461–8482 行：** `/v1/database-token` 用独立 Supabase JWT secret 签发 15 分钟的 PostgREST 凭证，声明含 `sub/id/role/aud/iss`。这可供数据 API 鉴权，但不等于创建 `auth.sessions` 或原生 Supabase Auth session。
- **9198–9207、9624–9696 行：** 应用使用 HS256，默认签发有效期七天；验签支持配置的多个现有密钥，检查算法、HMAC 签名、整数 exp 及受限 id。通用验签不要求 email 必填，因此无邮箱应用身份在此函数层面可表达，仍需全链路测试才能证明兼容。
- **8278–8414 行（已读未保存完整模板）：** 现有邮箱 OTP、60 秒冷却、5 次失败限制和 IP 校验间隔使用 `CODE_STORE` KV 的读写/删除。不能复制为短信的强一致预算、并发消费或重放保护。
- settings 有名为 `TURNSTILE_SECRET` 的绑定，但所审计邮箱发送链路仍调用 GeeTest；绑定存在不能证明 Turnstile 校验已实现。当前绑定列表没有短信专用 Durable Object，短信风控基础仍须本地设计和验证。

### 可行方向与必须明确的差异

若目标是“手机与邮箱登录同一现有 AI 账号”，应在现有 Worker 增加受验证的手机号因子映射，绑定到原 profile ID，并复用既有应用签发与数据库 token 交换。此方案不引入第二套 JWT；它仍属于当前自建会话体系，安全性取决于原子映射、强一致 challenge、预算、二次认证和注销全链路实现，当前尚未实现。

若附件中的“通过官方支持方式建立真实登录会话”严格指 **Supabase Auth session**，则不能把上述应用 token 或数据库 JWT 冒充为该 session。现有邮箱体系本身也没有走这一流程，需要另行审查身份迁移或官方桥接设计。直接创建 Auth 用户、修改 profile ID 或伪造邮箱 OTP 均不能解决。

当前会话仍未暴露 Supabase 查询工具，无法核实 email 是否可空、唯一索引、identity_status 默认值、profile 创建触发器、auth.users 关联及注销 RPC 的现行定义。不会从 Cloudflare plaintext binding 抽取 service-role 值去绕过该访问边界，也不会直接执行生产 SQL。
