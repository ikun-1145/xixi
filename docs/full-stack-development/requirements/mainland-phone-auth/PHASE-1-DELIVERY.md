# 手机号认证 Phase 1 本地交付

日期：2026-10-24。本轮完成工作流初始化与短信基础模块，尚未接入实际认证 Worker 或网页，也未实现手机号账号登录、用户创建和绑定。没有部署、迁移、真实短信、生产凭证创建或生产配置修改。

## 提交与文件

工作流独立提交：`be0422e`。保留 `1847b8f` 与此前审计成果；后续用户已有提交同样保留。

初始化7个文件：`INIT.md`、`.agent-sync/catalog.json`、`.agent-sync/TEAM.md`、`.agent-sync/ROUTING.md`、`.agent-sync/A-TEAM-LICENSE.txt`、`scripts/roster.py`、`tests/agent-roster.test.mjs`。生成器来自官方固定提交，适配已有Codex专家及插件技能库存；拒绝覆盖及replace，并有并发创建回归测试。不修改CI/CD、全局插件或现有配置。

Phase 1执行代码：
- `workers/phone-auth/dypnsapi.js`：SendSmsVerifyCode/CheckSmsVerifyCode、ACS3签名及供应商错误分类。
- `workers/phone-auth/http.js`：手动拒绝重定向、完整请求硬超时、大小和JSON/UTF8限制。
- `workers/phone-auth/errors.js`：稳定脱敏错误及默认关闭开关。
- `workers/phone-auth/coordinator.js`：可导入的DO类、Turnstile、持久事务账本与challenge。
- `workers/phone-auth/service.js`：固定单对象绑定调用、返回值白名单；没有public fetch入口。
- `tests/phone-auth-provider.test.mjs`、`tests/phone-auth-service.test.mjs`：纯Mock，无真实网络业务调用。

文档与机器契约：本文件、`PHASE-1-PLAN.md`、`phase-1-contract.schema.json`、`supabase-schema-evidence.json`，以及更新的阶段状态与原审计说明。完整文件清单由本阶段Git提交提供。

## 供应商与内部接口

2026-10-24通过已安装阿里云只读MCP再次核对Dypnsapi 2017-05-25的两个API和endpoint。采用原生Web Crypto ACS3-HMAC-SHA256，官方RunInstances固定签名向量通过。POST业务参数均为query，空正文；支持服务端STS token，拒绝非固定供应商endpoint。验证码使用API动态生成的`##code##`，6位数字、300秒、覆盖旧码、不返回验证码、AutoRetry=0；没有自动重试。

仅严格 `Success === true`、`Code === 'OK'` 且 `Model.VerifyResult === 'PASS'` 才通过核验。供应商Code映射为固定错误，不使用其Message推断、不透传原始响应或异常。短信错误与过期无法由供应商错误码精确区分时，保持通用错误；应用本身的TTL过期单独拒绝。

内部函数：`sendPhoneCode(env,input,context)` 和 `checkPhoneCode(env,input,context)`。入参与结果完整约束见计划和JSON Schema。它们通过 `PHONE_AUTH_COORDINATOR.getByName('sunland-phone-auth-v1')` 使用同一个DO；DO使用支持的constructor+fetch接口，不要求RPC继承。当前无浏览器REST路由，未来须由已有Worker路由及错误/CORS helper接入，不能把DO公开为绕过认证的接口。

成功核验只返回服务端内部的 `{success:true,verified:true}`，不是会话或可重放凭据。Phase 2须在同一服务端流程中继续身份操作与既有JWT签发，数据库失败后不能重用已消费challenge；客户端不能凭此布尔值直接登录。

## 防刷、并发与费用

- 默认 `PHONE_SMS_ENABLED` 缺失/非字符串`true`均拒绝；缺配置、绑定或已审核账本也拒绝。
- Turnstile在服务端检查success、指定hostname、`phone_<purpose>` action及300秒时效（未来允许30秒时钟余量）。IPv6规范化为不带方括号的地址。限制入参/正文大小，外部HTTP超时最大10秒、正文最大16KiB，拒绝重定向。
- 发起请求先作IP/全局分钟请求限流，减少Siteverify洪泛；验证人机后在同一DO持久事务中原子裁决手机号/IP日量、UTC日短信总数、日金额预算及累计总预算，先写预留再发短信。
- 费用使用整数微元；unitCostMicros须覆盖选定模板所有短信分段、供应商实际单价和可能附加费用，由后续账单审核设定，代码没有默认价格。AutoRetry关闭，所有发送失败均不退预留。预算限制是对已配置单价上界的预留，尚非真实账单验证；不得把它称作供应商账户所有费用的保证。
- 手机号/IP/主体只落HMAC摘要；无原始手机号、验证码、Turnstile token、AccessKey或供应商原始错误日志。HMAC key ID与账本绑定；轮换不匹配时关闭。
- 所有用途共享手机号锁，正常发送后600秒内不可重发，即使已经核验或验证码失效；retry_after返回实际剩余锁时间，expires_in返回本地剩余有效期。保守限制是为缺乏供应商OutId隔离/自动消费保证所作的取舍。
- 发送预留时先持久隔离手机号，明确成功/已知拒绝才解除隔离。未知结果、超时、协议错误或进程中断保留隔离且不自动删除。需要单独审核供应商状态及安全等待期后恢复；本轮不提供未认证的恢复入口。
- 用途、规范化手机号、主体和应用会话指纹绑定；核验前事务认领，最多5次错误，一次成功即持久消费。并发核验只能成功一次，过期、重放、锁丢失、存储失败均不能返回通过。
- 临时数据每请求最多扫描32条进行清理，不引入定时任务；永久预算账本和未知结果隔离不自动清理。单一协调点刻意牺牲高吞吐以维护全局硬预算，限于短信流程，不能作全站流量入口。

## 测试证据

- 初始化：名单verify/check与并发覆盖回归通过；独立审查发现的覆盖竞态已修复。
- `node --experimental-test-coverage --test tests/phone-auth-provider.test.mjs tests/phone-auth-service.test.mjs`：32通过、0失败、0跳过；执行模块总行覆盖99.65%、分支93.76%、函数88.52%。
- 最终 `npm test`：867项，866通过、0失败、1跳过。跳过为既有未配置 `AFDIAN_PGLITE_PATH` 的可选隔离SQL检查，与短信Mock无关。
- `git diff --check`通过；所有新增执行JS的Node语法检查、文档JSON解析与roster校验均通过。
- qa/code-reviewer与security/compliance-reviewer独立审查无剩余本地阻断。额外故障注入覆盖供应商成功后锁丢失、时钟回退、存储故障、进程中断和重建。

这是本地Mock与静态证据，不能证明真实Cloudflare DO运行时、真实Turnstile、供应商实际SMS发送/回执/计费或生产身份链路通过。没有修改UI、Flutter或JWT算法，既有相关测试作为兼容基线；尚未完成手机号登录端到端兼容验收。

## Supabase实况与Phase 2前置条件

连接阻断已解除。全部查询限定 `klyrasrqgxijwrxuoevj`，仅SELECT系统目录、函数定义、权限及迁移元数据，没有使用生产service_role密钥，也没有读取用户行。

已核实：
- `user_profiles.user_id`为text主键，email可空，identity_status默认active且约束为active/deleting/retired。
- email唯一索引为lower(email)，排除NULL与retired；deleting仍占用邮箱身份，不能按active查询结果为空就重建旧身份。
- profile与注销job均启用RLS；authenticated对user_id/email/pro/identity_status及注销字段没有UPDATE权限，anon也无UPDATE。profile可修改列局限头像、昵称、updated_at。仅看到自身更新策略不等于可改身份列，须结合列权限判断。
- 注销begin/finalize/sanitize以profile行锁和job/attempt/fencing值协调，retired不会通过begin恢复active；sanitize在retired后清空email等资料。相关RPC仅postgres/service_role可执行；活动身份函数只给authenticated等受限执行权。
- job claim租约90秒，恢复TTL7天；本地Edge Function授权job TTL10分钟，与当前RPC结构一致。生产迁移元数据含identity guardrails与first login onboarding等记录。
- 2026-10-24只读复查Worker最新部署仍为`b06e00b1-78f2-4939-9160-bab2428d71de`，版本`f405a850-780d-483f-8942-83e1798711fe`占100%，与原审计相同。

Phase 2仍需：手机号释放/重注册策略、唯一约束与加密/HMAC映射迁移契约；与既有删除行锁/租约/清理阶段衔接；可用替代登录因子的权威验证；近期认证恢复和敏感授权失效方案；电话唯一登录用户的注销验证；现有Worker原始源码工程接入及全链路Mock。不得仅凭email非空判定其已验证，也不能自动合并账号。此次不生成/执行身份映射SQL。

## 后续环境配置与顺序（本轮未执行）

需要的绑定/环境变量名：
- `PHONE_AUTH_COORDINATOR`：所有手机用途唯一DO命名空间，固定对象名不得更换或分片绕开预算。
- `PHONE_SMS_ENABLED`：默认不设置或false；本轮不启用真实发送。
- `PHONE_AUTH_HMAC_KEY`、`PHONE_AUTH_HMAC_KEY_ID`：受控服务端密钥及版本标识；不写前端或仓库。
- `PHONE_AUTH_POLICY`：JSON，必填正整数字段perPhoneDaily、perIpDaily、dailyLimit、unitCostMicros、dailyBudgetMicros、totalBudgetMicros、ipRequestsPerMinute、globalRequestsPerMinute；dailyLimit本模块最大10000。金额和分钟限额无生产默认值。
- `TURNSTILE_SECRET`：复用已有服务端绑定名；另需`PHONE_TURNSTILE_HOSTNAME`，前端action与用途一致。
- `PHONE_ALIYUN_ACCESS_KEY_ID`、`PHONE_ALIYUN_ACCESS_KEY_SECRET`、可选`PHONE_ALIYUN_SECURITY_TOKEN`；使用未来经独立批准的业务身份，绝不能使用只读文档用户codex-openapi-reader。RAM最小目标为dypns:SendSmsVerifyCode与dypns:CheckSmsVerifyCode。本轮不创建或索取真实值。
- `PHONE_SMS_SIGN_NAME`、`PHONE_SMS_TEMPLATE_CODE`：必须与赠送签名及固定code/min模板变量匹配；不支持随意替换为普通短信SendSms。
- `PHONE_API_TIMEOUT_MS`：默认5000，范围1–10000，包含响应体读取；不重试。

后续先在隔离测试工程挂接原认证Worker的已验证身份/状态/封禁/近期认证中间件，context中的userId/sessionId只能由服务端生成（sessionId可为应用token的服务端摘要，不要求修改JWT或使用Supabase Auth Session）；login前的匿名SMS核验不自行决定用户身份。可信IP来自CF-Connecting-IP，不能从客户端body/X-Forwarded-For取得。

测试环境使用Mock transport与显式账本fixture验证绑定、事务/重启和故障；随后再设计有鉴权的首次建账/恢复操作。账本必须有schema=1、enabled=true、keyId以及非负安全整数totalMicros/day/dayCount/dayMicros/minute/minuteCount/lastNow。生产账本丢失时不得复制测试零账本重置，必须先核对历史预留与费用。本轮没有建账入口、DO部署迁移配置或测试环境发布。

真实短信单价/模板长度/TTL及Turnstile行为验收、生产凭证/迁移/部署均需后续独立授权；Phase2完成前不得开放网页手机号入口。上线顺序须在该阶段重新审核，不能照此文档直接生产操作。

## 回退

本轮只有本地模块和文档，无运行中的生产变更。未来接入后先关闭发送/手机入口，再回退新路由和模块；保留预算、隔离与已建手机号数据，不能删除唯一登录因子或重置账本。更换命名空间/固定对象名、回滚数据快照/HMAC版本可能重置防重放与预算，必须停发后单独审核。现有邮箱登录、JWT和用户ID全程保持原契约。
