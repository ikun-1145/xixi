# Phase 5：生产身份数据库迁移交付

2026-10-25（Asia/Shanghai）。状态：**PHASE5_DATABASE_MIGRATIONS_VERIFIED**。已依次完成邮箱 OTP、手机号加法式生产数据库迁移及只读验收；按用户要求停止，未部署 Worker/网站、未改生产 Secrets、未发邮件/短信、未开放手机号入口。

## 授权与预检

目标仅 `klyrasrqgxijwrxuoevj`。最初只读检查：迁移历史 70 条，最新 `20261011030000`；目标两版本、OTP/phone 全部同名前缀 relation/function 和 phone lifecycle trigger 均不存在，没有重复迁移、重载或版本冲突。

预检发现生产 `postgres/public` 默认表 ACL 授予 service_role ALL。原 phone SQL 未撤销 service_role 默认权限，单独 GRANT SELECT 不会收窄，导致配置表可写。发现后暂停，两份迁移均未先行执行；用户明确追加授权“允许按修补后的 SQL 继续数据库迁移”。仅在五张新表的 REVOKE 中加入 service_role，随后沿用四表 CRUD、配置表 SELECT；不改生产全局默认权限或既有表授权。

| 迁移 | 冻结来源 SHA-256 | 提交后服务器回执时间 |
| --- | --- | --- |
| `20261021010000` / `atomic_email_otp` | `21ed65f1ba19e41a8940a2495fb479b874cb2bbbabd868c84654751d3f36e15c` | 12:22:43.993244；随后原生只读检查成功 |
| `20261024003756` / `phone_identity` | `0022b4274f19dc61de8b53c2023aa0e5f1668aeb6f69868131063983cafce835` | 12:24:48.338975；随后原生只读检查成功 |

手机号源文件旧摘要为 `d384c02ad15ed28a36ef85dc52e10a58e6cef8b8563b650592a35df485cfcb03`，经用户授权的一行补丁后以上述新摘要为准。邮箱来源 `/Users/liuxize/sunland_ai_app/supabase/migrations/20261021010000_atomic_email_otp.sql` 未修改；手机号来源为本仓库 `supabase/migrations/20261024003756_phone_identity.sql`。

12:26:25 的独立 Supabase 只读复核确认历史总数 **72**，两版本各一条、name 及保存的完整 source statements SHA-256 精确匹配。没有执行 db push、批量 history repair 或其他迁移。

## 备份、隔离演练和执行保护

使用 Phase 4 已验证的 `2026-10-25_10-58-30` 加密备份，在 UTF8/en_US.UTF-8、无网络/发布端口的独立 PostgreSQL 17.6 副本上演练相同 DDL、默认 ACL 和检查。完整恢复结果及本轮演练位于：

`/Volumes/机械硬盘/SunlandBackups/2026-10-25_10-58-30/phase5-20261025T041256Z/`

最终使用 `plan-v2/`，本地证据为 `local-rehearsal-v2-result.json`，对应恢复副本 `restore-run.O4O7aR`。合成 OTP reserve→delivery→consume→重复消费 INVALID 通过，全部在本地事务中回滚，没有网络发码或生产测试数据。其余既有业务数据的行数和聚合指纹未变。

生产使用原生 PostgreSQL 18.6、Keychain 凭据和 verify-full CA，仅两个批准的执行子进程启用读写；只读备份工具/MCP 配置未改。每份 DDL、有效权限断言、19 表前后指纹比较及精确迁移历史登记处于同一 REPEATABLE READ 事务，锁超时 5 秒、语句超时 30 秒。前置碰撞或验证失败阻止提交；未采用破坏性回滚。

源 SQL 外层 BEGIN/COMMIT 在执行器中被替换为唯一受控事务，函数体保持冻结内容；PostgREST schema reload 通知在提交时生效。执行 SQL 文件另有 SHA-256，原始完整来源同时登记在迁移历史。

## 邮箱 OTP 数据库验收

- 新增 `sunland_otp_challenges`、`sunland_otp_limits` 两表，RLS 均为 true，owner 为 postgres。
- 新增三函数：`sunland_otp(text,text,text,uuid,text,text)`、`sunland_otp_budget(text,integer,integer)`、`sunland_otp_cleanup()`；生产 `prosrc` SHA-256 与冻结 SQL 的各函数体完全一致。主 RPC 后三参数默认 NULL。
- 三函数均 SECURITY DEFINER、空 search_path、postgres owner。anon/authenticated 无三函数 EXECUTE；service_role 无 budget EXECUTE，仅能执行主 RPC/cleanup。两表对 anon/authenticated/service_role 均无直接表权限。
- 两个 PK 索引及两个 expiry 索引均存在且有效。
- 12:23:19 PostgREST OpenAPI 只读元数据确认主 RPC、cleanup POST 路径可见；没有调用会写预算的生产 RPC。该检查点通过后才执行手机号迁移。

**现有邮箱兼容边界**：数据库添加不改旧邮箱字段、用户 ID、JWT、Pro 或聊天数据，也没有切换旧 Worker/KV；相关邮箱/身份/引导回归 66/66 通过。真实邮箱发码、验证码消费、线上 JWT/刷新端到端没有执行，不能将“数据库阶段通过”称为“新 OTP Worker 已上线”。

## 手机号数据库验收

- 新增五表：`sunland_phone_identities`、`sunland_phone_auth_state`、`sunland_phone_auth_grants`、`sunland_phone_auth_operations`、`sunland_phone_auth_config`。全部 RLS=true，owner=postgres。
- 两函数 `sunland_phone_identity(text,jsonb)`、`sunland_phone_identity_lifecycle()` 均为 SECURITY INVOKER、postgres owner；函数体 SHA-256 与修补后冻结 SQL 一致。anon/authenticated 无 EXECUTE，service_role 有 EXECUTE。
- 四业务表 service_role 仅 CRUD，config 仅 SELECT；所有额外权限（包括 TRUNCATE、REFERENCES、TRIGGER、MAINTAIN）被撤销。anon/authenticated 对五表均无权限。生产独立复核中 config 的 INSERT/UPDATE/DELETE/TRUNCATE/MAINTAIN 全为 false，SELECT 为 true。
- 27 项约束全部 validated，7 个索引全部 valid/ready；`user_profiles` 上新增的 lifecycle trigger 绑定正确函数且启用。
- 配置仅一行 singleton=true，lookup_key_id/lookup_check 均为 NULL；四张 phone 业务表合计 0 行，失败关闭仍生效。没有初始化 canary、建真实手机号用户或变更已有用户身份。
- 12:25:35 PostgREST OpenAPI 确认 identity RPC 的 POST 元数据可见；未调用生产 phone RPC（包括会写状态的 status）。

## 既有数据保护与测试

每份生产迁移在自身 REPEATABLE READ 事务内比较以下 19 表的精确行数及全行 JSON 聚合指纹，全部相同：Auth users/identities、user_profiles（包括 Pro）、account_deletion_jobs、activation_codes、chat_messages/chat_threads/conversations、email_codes、OC、orders/profiles、thanks/thanks_likes、usage/usage_logs/request_logs、Storage buckets/objects。

这些指纹只在数据库内比较，没有导出实际用户行或单用户摘要。在线业务仍可正常并发写入，所以该结果证明迁移自身未改变既有数据，不声称整个生产窗口没有正常新增/变更。

| 检查 | 结果 |
| --- | --- |
| 生产默认 ACL 合成回归 | 原文件先失败，修补后 105 项有效权限矩阵及实际 UPDATE config 拒绝通过（该独立脚本不含 MAINTAIN） |
| 真实备份隔离副本 | 两份相同迁移及 168 项表权限/15 项函数 EXECUTE 检查通过，包含 MAINTAIN；合成 OTP 消费与重放拒绝通过，整事务回滚 |
| 手机号 SQL/发布护栏回归 | 27/27，通过；PGlite/Mock，不是生产短信验收 |
| 相邻原 Worker 邮箱/身份/引导回归 | 66/66，通过；网络由 Mock 拦截，无真实邮件 |
| 全量 `npm test` | 1024/1024，通过，0 跳过 |
| SQL 生成器安全回归 | 2/2，通过，包括 Python -O 下仍拒绝错误冻结 SHA、事务边界拒绝 |
| 生产目录、有效权限、函数体/来源摘要 | 两阶段分别只读通过，历史 70→71→72 |
| 真实发码/登录、DO、Worker/网站部署 | **未执行** |

最终按仓库发布门禁执行全量测试通过；未修改前端、认证接口或模型调用。独立只读审查覆盖默认 ACL 一行补丁及迁移执行保护；审查建议的显式 SHA 拒绝和 NULL 失败关闭检查已纳入最终计划。

## 停止点与下一阶段

数据库阶段已完成并停止，没有部署 Worker/网站、修改 Secrets、发邮件/短信、开放手机号入口、重置密码、创建角色或删除既有业务数据。没有运行任何主动 DOWN/生产备份覆盖回滚。临时明文及本次隔离容器已清理；保留原备份与迁移证据。

下一阶段需单独授权：

1. **Worker 部署准备**：确认权威原 Worker 源码与构建摘要，配置新的 PHONE 供应商/身份/HMAC/管理密钥、策略和 Turnstile；保持发送、身份、新注册开关默认关闭。不得无故轮换原 JWT/邮箱 Secrets。
2. **显式初始化**：授权数据库 lookup canary 和 DO binding/migration/受鉴权账本初始化。当前数据库 canary 为 NULL，生产短信/新注册仍不得开放。
3. **邮箱权威切换**：先建立独立 OTP 维护阻断并排空旧请求，再部署兼容 Worker 到 100% 对应流量，避免旧 KV/新 RPC 混跑；使用授权专用邮箱完成发码/消费/重放和刷新验收，再解除邮箱维护。此处才是真实邮箱链路验收。
4. **受限手机号 canary**：完成 DO 预算/恢复、PostgREST JWT、Turnstile/CORS 和真实设备；真实短信与计费须单独授权。通过后最后授权网站发布和入口开放。

迁移计划见 [数据库计划](../../../migrations/2026-10-25-phase5-identity.md)。本次提交 ID 见本报告 Git 历史和最终回复。原有 `.codex/config.toml` 改动及配置备份保留，未提交或 push。
