# 手机号认证 Phase 2 本地交付

日期：2026-10-24。范围：现有身份体系的数据库扩展、实际认证 Worker 本地集成、接口契约及非容器测试。未部署，未执行生产迁移，未发送真实短信，未修改网站 UI 或 Flutter。

## 架构与兼容

继续使用 `user_profiles.user_id`、原应用 HS256 JWT、原短期数据库访问 JWT 和 active → deleting → retired 生命周期。没有 Supabase Auth Session，也没有第二套用户标识。原邮箱 OTP、`/send-code`、`/verify-code`、`/refresh`、`/v1/database-token` 保持原始实现。手机号登录返回同一 `{token,user:{id,email},onboarding,is_new_user}` 结构；手机号新账户 email 为 NULL，不使用虚构邮箱、不自动合并已有邮箱账户。

已有邮箱用户绑定时只写私有映射和授权状态，不更新其 user_id、Pro、聊天或 OC。手机号新建用户因邮箱为空，不能直接调用原邮箱专用 getOrCreateLoginUser；新 RPC 使用同一 profile、UUID 和 onboarding 0/1 默认值，将建档与绑定放在同一事务。历史 onboarding NULL/NULL 按原 helper 兼容为完成态 1/3，不回写原资料。

真实原始 Worker 在相邻仓库 `sunland_ai_app/worker/src/index.js`，其中邮箱 OTP 已采用原子 RPC，不能用旧部署 bundle 覆盖。新增 build 工具仅在内存构建中追加原 helper 的 named exports，包装原 default Worker；其他路由和 OPTIONS 直接委托原 fetch，保留 scheduled。没有修改相邻仓库源码、Flutter、生产配置、现有 CI/CD。

`workers/phone-auth/source-provenance.json` 固定原 Worker 源码文件集合、SHA-256、package/lock 及来源提交。源文件变化时构建拒绝，须先审查并显式更新 pin。集成依赖该源码工程及其已安装 esbuild，不复制一份认证实现；`SUNLAND_AUTH_WORKER_ROOT` 可指定同一固定内容的工程路径。

## 文件清单

新增执行文件：

- `supabase/migrations/20261024003756_phone_identity.sql`：CLI 生成的本地迁移，五表、事务 RPC、生命周期触发器及权限。
- `workers/phone-auth/identity.js`：E.164/HMAC、AES-GCM、会话摘要、一次性近期授权及 RPC 适配。
- `workers/phone-auth/routes.js`：9 个现有 Worker 包装路由。
- `workers/phone-auth/entry.js`、`source-provenance.json`、`scripts/build-phone-auth-worker.mjs`：真实源码接入及可复验构建。
- `tests/phone-auth-routes.test.mjs`、`phone-identity.test.mjs`、`phone-identity-db.test.mjs`、`phone-worker-build.test.mjs`、`phone-worker-integration.test.mjs`。

修改：`workers/phone-auth/coordinator.js`（仅修复 reauth 循环前置条件）、`errors.js`（固定错误码）、`tests/phone-auth-service.test.mjs`、`package.json` / lock（精确开发依赖 PGlite 0.5.11）。文档：本交付、`PHASE-2-PLAN.md`、`PHASE-2-REVIEW.md`、`changes/phase-2-request.md`、`phase-2-openapi.json`、`00-stage.json`。原有 `.codex/config.toml` 修改和备份为用户已有内容，未纳入提交。

## 数据库与隐私

五个新表 `sunland_phone_identities`、`sunland_phone_auth_state`、`sunland_phone_auth_grants`、`sunland_phone_auth_operations`、`sunland_phone_auth_config` 均启用 RLS，撤销 PUBLIC/anon/authenticated 权限；只有现有服务端数据库访问通路可执行 `SECURITY INVOKER` 的 `sunland_phone_identity(text,jsonb)`。这不是使用 service_role 做审计；实际生产审计仅经已授权 MCP SELECT 系统目录，没有读取用户行。

手机号规范化为 +86 E.164 后，以带域隔离的 HMAC-SHA256 建唯一索引；不采用无密钥 SHA-256 匿名化。AES-256-GCM 随机 12 字节 IV 加密完整号码，AAD 绑定 user_id 和 phone_hash；数据库只保存密文、HMAC 和末四位。公开 status 只返回掩码，不返回索引或密文；日志不记录号码、验证码、JWT、授权凭证及供应商原始异常。

一个 user_id 一条映射，一个 phone_hash 全表唯一，FK 防孤儿。建档绑定、绑定、更换、解绑、消费 grant、认证版本递增及幂等审计均由一次 RPC 事务完成；异常回滚，不用多个 HTTP 写请求模拟事务。功能级 advisory 锁 → profile → state/phone/grant；生命周期触发器不反向取得 advisory 锁。

加密 keyring 可写新读旧，保留旧解密 key，直到经过另审的数据重加密。lookup key 不支持在线随意轮换：永久配置 canary 和 key ID 不匹配则关闭，避免更换 HMAC 后同一号码被当作新号码。新迁移 canary 默认 NULL，运行时服务角色只有 SELECT 权限，不能自行重置；未来初始化/轮换需独立审核，不在本轮执行。

近期授权为 32 字节随机 opaque token，数据库只保存 SHA-256 token 摘要（此摘要对象不是手机号）；绑定当前 user_id、JWT 会话 HMAC、操作用途、当前因子及私有版本，300 秒到期，一次消费。已换绑号码、已改邮箱、已消费/过期/旧版本 grant 不可再用。解绑必须证明当前邮箱 OTP，email 非空不等于通过验证，手机号为唯一登录方式时拒绝解绑。旧 JWT 本身不能发起敏感变更；仍持有旧 JWT 且重新证明当前因子所有权可重新认证，未声称所有普通 JWT 全局注销。

幂等操作使用 UUIDv4 和服务端语义 HMAC；同 ID 不同用户/输入冲突。SMS 已消费而 DB 响应丢失时不自动重试旧码，先查询 status，再按需要重新验证。注销授权凭证仅返回一次；重复请求产生新随机 token 时 fingerprint 改变，返回 OPERATION_CONFLICT，不能返回旧 job 搭配无效新 token；未知结果应等待已有 pending job 10 分钟过期后重新授权。

## 注销与号码释放

`deleting` 仍占用号码，拒绝登录/绑定并使 grant 失效。只有不可恢复的 `retired` 才同事务释放密文/索引；触发器核对 OLD deleting、job owner、attempt、fencing version、有效 lease、恢复 TTL 和 data_deleted_at。错误会回滚 retired 与释放。旧历史 operation 的邮箱快照也在 retired 清除，只保留无号码的最小 release 审计。

现有 90 秒租约与 7 天恢复 TTL 是清理任务续作，不是把 retired 身份恢复 active。释放后手机号再次注册创建新 UUID，不会恢复旧账号或旧权益。手机号尚绑定时运营商转售号码的风险无法仅靠 SMS 自动辨别；本实现不声称解决号码回收问题、不自动合并账户。额外 MFA/人工申诉策略需要后续明确产品范围。

手机号唯一登录用户通过 `/v1/phone/delete-authorize` 证明当前因子，创建原 account_deletion_jobs，再使用既有 Edge Function execute 和原 begin/finalize/sanitize 流程。未修改原邮箱 authorize。没有另外的客户端删除身份入口。

## Phase 3 接口指南

机器契约：`phase-2-openapi.json`，包含请求/响应、严格字段白名单、错误码及 HTTP 状态。所有新接口 POST、JSON、最多 8192 字节；JWT 使用原 `Authorization: Bearer ...`，授权和幂等 ID 放 body，无新增 CORS header。

| 路径（前缀 /v1/phone） | 请求要点 | 成功结果 |
| --- | --- | --- |
| /send-code | phone,purpose,turnstile_token；敏感用途另传 reauth_token+JWT | success,challenge_id,expires_in,retry_after |
| /verify-code | phone,challenge_id,code,operation_id；匿名登录/注册 | 原登录结构 |
| /status | 空对象+JWT | bound,phone掩码,has_email |
| /reauth/email | code,action+JWT；邮箱取当前 DB | reauth_token,expires_in=300 |
| /reauth/phone | phone,challenge_id,code,action+JWT；必须当前号码 | reauth_token,expires_in=300 |
| /bind、/change | 新phone,challenge_id,code,reauth_token,operation_id+JWT | ok:true |
| /unbind | 当前邮箱授权 reauth_token,operation_id+JWT | ok:true |
| /delete-authorize | delete授权 reauth_token,operation_id+JWT | 原deletion_job_id/deletion_token/600秒结构 |

注册/登录：Turnstile action=phone_login → send-code purpose=login → verify-code；后台决定已有映射登录或新建，不让客户端指定 user_id。

绑定：按现有 `/send-code` 邮箱流程取得当前邮箱码 → reauth/email action=bind → send-code purpose=bind（grant）→ bind。更换类似，先用当前邮箱或旧手机号完成 change 授权，再发送新号码的 change 验证码。手机号 reauth 的发送用途为 reauth，Turnstile action=phone_reauth，校验后分别签发目标 action grant。手机号初次登录后受同号全局 600 秒冷却保护，前端应遵守 retry_after，不能通过换用途绕过。

解绑：邮箱 OTP → reauth/email action=unbind → unbind；不为解绑再发短信。手机号用户没有已验证邮箱时不能解绑。现有添加邮箱 UI/账户合并不属于本轮，不能把独立邮箱登录注册当作补绑邮箱。

注销：reauth action=delete → delete-authorize → 既有 execute，保持已有确认步骤。封禁但 active 用户只可完成自己的删除授权；deleting/retired 一律不签发新登录令牌。

错误 `{success:false,code,error}` 使用固定中文 error；客户端按 code 展示/重试。INVALID_REQUEST/JWT失效/验证码失效、REAUTH_INVALID、PHONE_CONFLICT、ALTERNATIVE_LOGIN_REQUIRED、OPERATION_CONFLICT、ACCOUNT_NOT_ACTIVE、限流/预算、配置/上游异常均已定义；502 表示上游协议/未知状态，504 超时，均失败关闭。不得把 verified 布尔值当成登录凭证，不持久保存验证码或 reauth_token，不记录含手机号的请求正文。

## 配置与本地构建

全部由服务端 secret store/env 提供；这里不含真实值。新增：

| 名称 | 用途/要求 |
| --- | --- |
| PHONE_IDENTITY_ENABLED | 严格字符串 true 才启用；默认关闭 |
| PHONE_IDENTITY_LOOKUP_KEY | 至少32字符的高熵服务端 HMAC secret；不得随意在线轮换 |
| PHONE_IDENTITY_LOOKUP_KEY_ID | 1–64字符 [A-Za-z0-9_-]；匹配数据库永久 canary |
| PHONE_IDENTITY_ENCRYPTION_KEYS | JSON keyring，1–16把32字节 key，以无padding canonical base64url编码 |
| PHONE_IDENTITY_ENCRYPTION_KEY_ID | keyring 当前写入 key ID；保留历史解密 key |
| SUNLAND_AUTH_WORKER_ROOT | 仅本地构建工具：固定哈希原 Worker 工程路径；默认相邻工程 |

会话摘要复用 Phase1 PHONE_AUTH_HMAC_KEY。其余 Phase1 PHONE_SMS_ENABLED、DO绑定/固定对象名、预算策略、Turnstile、阿里云凭证/签名/模板/timeout 名称及要求全部保留。两个开关缺失均关闭；无 binding、无批准的预算账本、无数据库 canary 均不能发送/认证。未提供生产零账本初始化、自动恢复、密钥创建或云端配置脚本。

本地仅构建命令：`node scripts/build-phone-auth-worker.mjs /absolute/new-output.mjs`；输出文件必须不存在，不覆盖已有产物，不执行 Wrangler 部署。entry 导出 PhoneAuthCoordinator；未来挂接正式 DO binding/migration 需在隔离环境验证后另行审批。

## 测试、安全审查和交付判断

最终自动化结果及审查处置见 `PHASE-2-REVIEW.md`。测试分层：

1. Phase1/provider/DO transport 的 Mock 测试：验证码错误、过期、重放、用途/会话隔离、并发消费、Turnstile、限流、全局预算、未知供应商响应/超时/存储故障关闭。
2. Worker 路由和 crypto Mock：无效/过期 JWT、current factor、敏感授权、配置关闭、参数注入/长度、加密篡改/跨用户 AAD、旧key读取、注销 token 重放。
3. PGlite 执行真实 SQL：唯一/FK/RLS权限、事务回滚、注册/绑定/更换/解绑、状态/租约/fence/释放、旧账号不复活和权益保持。Promise 并发仅由单后端排队，不能称为多连接锁竞争验收。
4. 真实原 Worker 源码构建后的 fetch + 全 HTTP Mock + PGlite：手机号注册/原号码登录、邮箱登录、绑定/更换/解绑、phone-only删除授权、原JWT验签/过期/刷新、数据库JWT 900秒、掩码/CORS预检。

Supabase 只读结构连接已恢复，catalog/权限/删除 RPC 已核验；未读取真实用户隐私、未用生产 service_role 审计、未调用生产业务 RPC。PGlite 使用合成 profile/job 基线，没有生产所有业务触发器。源码/构建/本地 SQL 是真实执行证据；真实 Cloudflare DO、独立多连接 PostgreSQL、真实 Turnstile/短信及生产端到端链路均未验证。

**本地实现范围可完成，生产仍关闭。可按契约进入 Phase 3 的前端开发和 Mock 集成；不能直接执行生产迁移或开放真实手机号入口。** 生产前须另行授权并完成：完整现有 schema/trigger 的隔离数据库迁移与回滚演练、多连接并发/死锁/长事务测试、真实 workerd/DO 持久化与重启/预算恢复验收、密钥/永久canary初始化及保留策略、受限业务凭证/模板/供应商成本验证、端到端注销清理及权限测试、发布与紧急关闭方案。真实短信及部署均须独立授权。

回退应先关手机入口和发送，保留所有映射、唯一登录因子、预算账本与 canary；不能通过 DROP TABLE 或换对象名“回退”而丢失身份或重置费用。此次没有生产变更可回滚。

## Git 记录

保留 Phase0 `1847b8f`、A Team 初始化 `be0422e` 和 Phase1 `527e31e`。Phase2 单独本地提交，提交 ID 见本次最终回复，或运行 `git log -1 --format='%H %s' -- docs/full-stack-development/requirements/mainland-phone-auth/PHASE-2-DELIVERY.md` 查询。未 push，未创建额外分支/worktree。
