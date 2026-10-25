# 手机号认证上线前置：核心恢复与连接阻断

2026-10-25 10:45（Asia/Shanghai）。结论：**CORE_BUSINESS_RESTORE_BLOCKED**。本轮收敛到凭据诊断、已有恢复证据和只读发布准备；没有重新开展完整 Supabase 灾难恢复，没有重新下载 Storage、重复恢复旧数据库或运行无关全量测试。

## 连接问题的实证

项目 API 当前返回 ref `klyrasrqgxijwrxuoevj`、区域 `ap-southeast-1`、状态 `ACTIVE_HEALTHY`、数据库 `17.4.1.054`。以下参数来自本地 `supabase/.temp/pooler-url`，与备份脚本一致：

| 方式 | Host | 端口 | 用户 | 数据库 |
| --- | --- | --- | --- | --- |
| Session Pooler，本次实际测试 | aws-0-ap-southeast-1.pooler.supabase.com | 5432 | postgres.klyrasrqgxijwrxuoevj | postgres |
| Direct，项目 API 确认 Host，未重复登录测试 | db.klyrasrqgxijwrxuoevj.supabase.co | 5432 | postgres | postgres |

6543 是事务池方式，不用于本轮一致性快照采集。不能把 Direct 的 `postgres` 用户名直接套到共享 Pooler，也不能把 Pooler 用户名套到 Direct。参考 [Supabase 连接说明](https://supabase.com/docs/guides/database/connecting-to-postgres)。

安全检查了服务 `dev.sunland.supabase.production.db-password` 对应当前 Mac 账户的记录：存在、非空、UTF-8 正常；没有首尾空白、嵌入换行、NUL 或外层引号，也不是明显的 PAT/JWT/连接 URL。脚本通过进程环境传递原值，不做 URL 拼接或 shell 二次解释；本轮限时测试仅去掉 `security -w` 输出的最后一个换行，没有裁剪密码空格。

该记录修改时间为 UTC `2026-10-24 23:32:01`，即今日 **07:32:01**。本轮只做一次 Session Pooler 认证测试：`verify-full` 使用已保存的官方 CA，证书验证没有报错，服务器明确返回 `FATAL: password authentication failed for user "postgres"`。之后停止密码登录，不轮换端口/密码反复试探。

已排除已发现的项目/用户名形式/数据库/端口混用及密码转义问题。**目前能够确认的是这份本地凭据未获认证，不能仅凭客户端错误进一步证明密码内容错误还是服务端池化认证状态异常。** 不声称已定位到不可证实的密码内部问题。

Kimi 当时的脚本/Manifest 显示使用 `cli_login_*.<project_ref>`、临时角色密码、Pooler 和 `SET ROLE postgres`；旧脚本还曾设 `SUNLAND_LOGIN_READ_ONLY=false`。这与当前 `postgres.<project_ref>` + 固定钥匙串凭据是不同认证路径。此前导出成功不代表当前记录有效。没有重新调用临时角色接口，没有创建生产角色、改变权限或绕过认证。

## A–D 验收级别

| 级别 | 本次状态 | 证据及边界 |
| --- | --- | --- |
| A. 新数据库备份完整性 | **BLOCKED：未生成新备份** | 密码认证失败；没有新数据库目录、大小、Manifest 或 SHA-256 可报告。旧 09-33-27 批次的加密/文件完整性结果保留，不能冒充新恢复点 |
| B. 核心业务数据恢复 | **CORE_BUSINESS_RESTORE_BLOCKED** | 未取得新 dump，不能验证新恢复中的两项 CHECK；旧批次仍各有一条违规，禁止据当前生产无违规就将旧恢复改为通过 |
| C. Storage | **旧归档已验证；新增对象待增量** | 复用旧 83 对象归档，实际恢复证据见旧报告；本次只枚举元数据，0 个对象内容下载。当前新增 1 个对象，见下节 |
| D. 完整 Supabase 灾难恢复 | **未通过，独立保留限制** | pg_net/pg_cron 版本、托管角色授权来源、Vault 密钥、平台配置及跨系统窗口仍未完全验证；不能改写成完整恢复通过 |

仍保留历史 **BACKUP_RESTORE_BLOCKED**；没有签发 `CORE_BUSINESS_RESTORE_VERIFIED` 或 `BACKUP_RESTORE_VERIFIED`，没有修改历史归档、数据或约束。

同快照缺口已确认：现有 `backup-production.sh` 的 dump、inventory、counts 使用独立事务，不能称为同一快照。由于连接尚未修复，未进入新导出实施阶段，也没有把待改方案称为已经实现。下一次执行前应保持一个只读 REPEATABLE READ 事务打开并用 `pg_export_snapshot()` 导出；`pg_dump --snapshot`、inventory 和 counts 都导入该快照，直到采集完成后才关闭持有事务。角色/集群对象和 Storage 另记采集时间。参考 [PostgreSQL pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html)。若现有账户无法导出/导入快照或覆盖必要 schema，停止并报告，不创建角色或提权。

## 两项 CHECK 的当前证据

10:42:51 生产只读查询显示：

- `chat_messages_text_len`：原定义 `char_length(text) <= 8000`，已验证；当前违规 0。
- `oc_profiles_description_check`：原定义 `char_length(description) <= 500`，已验证；当前违规 0。

这些只是当前生产统计。本次没有新备份或新恢复，故**不能宣称新归档的两项 CHECK 已恢复正常**。旧归档恢复失败证据保留在 `2026-10-25_09-33-27/restore-run.QNdDpT/restore-result.json`。后续必须在新隔离恢复中实际 VALIDATE，不改值、不删约束、不永久保留 NOT VALID。

两份拟执行迁移 SQL 未直接引用 pg_net、pg_cron 或 Vault。这些托管扩展版本差异本身不应自动等同于核心表恢复失败；新数据、定义、权限、约束通过后，可将未复现的调度/网络/密钥能力列为 D 级限制。若发现其影响迁移回退所依赖的业务触发器或数据，则仍须阻断。

## Storage 只读差异

枚举窗口为 **10:43:55–10:44:30**。从旧加密 tar 读取内部清单，只请求 Bucket/list 元数据，不下载对象内容；临时 tar 已清理。不输出对象路径。

| 指标 | 旧归档 | 当前清单 |
| --- | ---: | ---: |
| Bucket | 2 | 2 |
| 对象 | 83 | 84 |
| 对象字节 | 22,423,254 | 22,517,681 |
| avatars | 65 / 14,774,919 字节 | 66 / 14,869,346 字节 |
| chat-images-v1 | 18 / 7,648,335 字节 | 18 / 7,648,335 字节 |

按 Bucket/路径身份及 updated_at/size/ETag 比较：**新增头像对象 1 个、94,427 字节；删除 0，原对象更新差异 0**。这不是整个枚举窗口的原子证明，但足以避免盲目重下 83 个对象。新数据库备份前后再核对该增量，只把新增/变化对象下载到独立加密增量归档；不得覆盖旧 tar。本轮未执行增量下载，因为新数据库恢复点尚未建立。

## 手机号认证发布准备

10:42–10:43 的生产只读元数据和 Cloudflare GET 检查：

| 项目 | 结论 |
| --- | --- |
| 邮箱 OTP | 生产 `public.sunland_otp` 不存在；本地 Worker 的 `createEmailOtp` 明确调用它，迁移仍为前置，直接部署有破坏邮箱认证风险 |
| 邮箱迁移 | `/Users/liuxize/sunland_ai_app/supabase/migrations/20261021010000_atomic_email_otp.sql` 存在，SHA-256 `21ed65f1ba19e41a8940a2495fb479b874cb2bbbabd868c84654751d3f36e15c`，未执行 |
| 手机号迁移 | `supabase/migrations/20261024003756_phone_identity.sql` 存在，SHA-256 `d384c02ad15ed28a36ef85dc52e10a58e6cef8b8563b650592a35df485cfcb03`；生产手机号表数 0，未执行 |
| Worker 源依赖 | `source-provenance.json` 的所有预期文件哈希与相邻原 Worker 仓库匹配；本次不重复构建，不等于线上已部署 |
| 阿里云/身份配置 | 线上 `ai` 绑定及 Secret 名称均没有 `PHONE_*`；阿里云访问凭据、短信签名/模板、身份加密/查询/HMAC 密钥、独立管理令牌、策略及发布变量均尚缺。未读取或展示任何值 |
| Durable Object | `ai` 无 PHONE_AUTH_COORDINATOR 绑定；未列出 Phone 类 namespace。本地 coordinator 和初始化鉴权逻辑已存在，原 Worker 配置未见 Phone DO 绑定/迁移；线上账本未建立/验收，不能以代码存在代替完成 |
| Turnstile | 线上存在 TURNSTILE_SECRET 绑定，但未验证值/有效性；网站 `sunland-turnstile-sitekey` 为空 |
| 网站入口 | `sunland-phone-ui-enabled=false`；代码已准备，保持关闭，未发布 |
| 发布护栏 | 线上没有 PHONE_SMS_ENABLED、PHONE_IDENTITY_ENABLED、PHONE_NEW_REGISTRATION_ENABLED、PHONE_RELEASE_MODE；不应视为可开放，尚需 canary、永久预算和失败关闭配置 |

只请求 Cloudflare settings/secrets 元数据名称及 DO namespace 列表，不请求 Secret 值，不调用 DO initialize/status，不变更任何云端资源。

## 用户所需的最小操作

1. 打开 [该项目 Dashboard](https://supabase.com/dashboard/project/klyrasrqgxijwrxuoevj)，点击顶部 **Connect → Session pooler**，核对上表四项参数。Direct 方式另有主机和用户名，不能混用；不要点 Reset database password。
2. 从密码管理器取出该项目**已有数据库密码**。Dashboard 连接示例中的密码占位符、Supabase 登录密码、API Key 和 PAT 均不能代替。若没有现有密码，先保持阻断，不在本任务重置。
3. 在 Mac「钥匙串访问」中搜索服务 `dev.sunland.supabase.production.db-password`，核对账户为当前 Mac 用户后更新密码。也可在本机终端执行下面命令，`-w` 必须放最后，以安全提示输入；不要把密码写到命令参数或聊天：

   ```bash
   security add-generic-password -U -a "$USER" -s dev.sunland.supabase.production.db-password -w
   ```

   本机 `security help add-generic-password` 已确认末尾 `-w` 的交互提示用法。
4. 完成后回复“已核对参数并更新钥匙串”，再做一次限时只读认证；若仍失败停止登录，核对 Dashboard 实际连接参数和账户，不盲目重试。

## 最短后续执行顺序

1. 凭据修复后，先完善并本地验证快照持有/导入及 Storage 复用路径，再生成一次新加密数据库备份。
2. 一次本地隔离恢复核对同快照行数、资料/会员/激活码/聊天/邮箱/注销对象、索引/触发器及两项 CHECK；通过才签发 `CORE_BUSINESS_RESTORE_VERIFIED`。D 级限制独立保留。
3. 补必要的 Storage 增量并记录时间窗口；判断核心迁移回退依赖是否覆盖，确认维护窗口。
4. **另行明确授权**后先执行邮箱 OTP 迁移并验收既有邮箱登录/刷新，再执行手机号加法式迁移及权限检查。
5. **另行授权** Cloudflare 配置/DO 迁移和受鉴权初始化、兼容 Worker 部署；默认关闭，先邮箱回归，再受限 canary。真实短信与计费验收单独授权。
6. 完成 PostgREST JWT、Turnstile/CORS、预算/恢复及真实设备验收后，才授权网站正式发布和入口开放。

本轮没有源代码修改、生产迁移、部署或短信；仅新增本报告并更新阶段记录。当前提交可通过 `git log -1 --format='%H %s' -- docs/full-stack-development/requirements/mainland-phone-auth/PHASE-4-CORE-RESTORE.md` 获取。原有 Codex 配置修改及备份继续保留，未 push。文档链接、JSON 解析和 `git diff --check` 是本轮收尾检查；不把上一轮测试或旧数据库恢复称为本轮新验收。
