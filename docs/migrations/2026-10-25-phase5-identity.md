# Phase 5：邮箱 OTP 与手机号生产数据库迁移计划

目标仅 `klyrasrqgxijwrxuoevj`；用户授权本轮数据库迁移，不部署 Worker/网站，不改 Secrets，不发短信/邮件，不切换 OTP 权威。旧 Worker/KV 继续运行，未来 Worker 切换仍须独立维护阻断、排空及专用邮箱验收。

## 冻结范围

1. `20261021010000_atomic_email_otp.sql`，来源相邻 `sunland_ai_app`，SHA-256 `21ed65f1ba19e41a8940a2495fb479b874cb2bbbabd868c84654751d3f36e15c`。新增 OTP 两表、三函数、两索引，表无运行时直接权限，主 RPC/cleanup 仅 service_role 可执行。
2. `20261024003756_phone_identity.sql`。预检发现生产 public 默认 ACL 给 service_role ALL，新表显式 GRANT 不能收窄。按用户追加授权，仅在五张新表的 REVOKE 中加入 service_role，再恢复四表 CRUD/config SELECT。新 SHA-256 `0022b4274f19dc61de8b53c2023aa0e5f1668aeb6f69868131063983cafce835`，替代旧 `d384c02ad15ed28a36ef85dc52e10a58e6cef8b8563b650592a35df485cfcb03`。不改变生产全局默认权限或既有表授权。

生产只读预检：70 条迁移，最新版本 20261011030000；目标两版本、所有同名前缀 relation/function、手机号 lifecycle trigger 均不存在。任何重复、重载、同名索引或并发变化立即停止，不覆盖或批量修复历史。

## 备份与演练

使用已核验的 `2026-10-25_10-58-30` 加密恢复点；在 UTF8/en_US.UTF-8、无网络/端口的临时 PostgreSQL 17.6 副本执行相同 SQL。19 表指纹/行数前后相同；精确权限矩阵（含 MAINTAIN）、RLS、函数签名/owner/security/search_path/canary 检查；合成 OTP reserve→delivery→consume→重放拒绝，仅本地执行，最后整事务 ROLLBACK。不恢复或覆盖生产。

## 实施

- 原生 PostgreSQL 18.6、Keychain 凭据和 verify-full CA；不改只读备份工具默认模式。仅本次经过冻结校验的执行会话开启读写。
- 每份 UP 单独事务，REPEATABLE READ，lock_timeout=5s、statement_timeout=30s，发布事务 advisory lock。
- 保留原 SQL 的 DDL/函数体；移除源文件外层 BEGIN/COMMIT 后放进唯一受控事务，避免嵌套提前提交。数据库默认 ACL 不修改。
- 事务内检查对象碰撞，记录19表行数和不暴露行内容的聚合指纹，执行 UP，再验证有效权限/结构/指纹；任何差异抛错阻止提交。
- 仅登记该份精确 version/name 和完整冻结 source statements 到 `supabase_migrations.schema_migrations`，与 DDL 同事务；不执行 db push、不改其他历史。NOTIFY pgrst reload schema 作为本次必要数据库通知。
- 提交邮箱 OTP 后只读核验目录及迁移来源摘要、PostgREST OpenAPI 的 RPC 签名可见性；全部通过再执行手机号。
- 生产不调用会写预算/状态的 OTP/手机号 RPC，不生成真实账户或测试数据。保留生产端到端邮箱/短信验收边界。

## 异常与回滚边界

提交前 SQL 异常由事务原子回滚；不盲重试。结果未知先只读确认历史与对象，停止后报告。已提交后保留加法对象，不自动 DROP、不删除数据、不将历史标成 reverted，也不部署其他版本。任何主动撤销须用户另行授权；回滚到生产备份更不在本轮授权内。新旧 Worker 权威切换和真实邮箱发码验收不属于本次数据库添加。

## 验收

目标历史各一条且 source SHA 匹配；OTP 2 表/3 函数/2 索引，phone 5 表/2 函数/1 trigger，RLS/有效 ACL 与冻结契约一致；phone 配置仅 NULL canary 的 singleton，四业务表空。既有用户资料、Pro、聊天、激活码、Auth 与 Storage 等19表的事务内指纹及行数不变。报告区分隔离功能验收、生产目录/权限和真实用户登录；数据库阶段通过后停止。
