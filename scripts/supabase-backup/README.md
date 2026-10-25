# Supabase 生产数据本地备份与恢复验收

限定项目 `klyrasrqgxijwrxuoevj`。仅生产只读导出、SELECT 和 Storage GET/list；不创建临时角色、不迁移、不部署、不修改对象。本地测试命令：

```bash
python3 scripts/supabase-backup/tests/test_safety.py
```

## 本机前提

- 本机 PostgreSQL 客户端（本次为 18.6），默认 `/opt/homebrew/opt/libpq/bin`，可用 `SUNLAND_PG_BIN` 指定；密码仅从 Keychain 传入进程环境。
- Docker/OrbStack 已运行，已有镜像 `public.ecr.aws/supabase/postgres:17.6.1.143`。
- `~/.config/sunland-backup/encryption.key` 为 32 字节，权限 600；必须另行安全保管，不发到聊天、不放备份盘。
- 已有数据库密码在 macOS Keychain 服务 `dev.sunland.supabase.production.db-password`；更新本地记录不等于重置生产密码。`configure-local.sh` 仅做首次配置并保留已有凭据。
- 官方 Supabase CA 证书位于 `~/.config/sunland-backup/prod-ca.crt`，或通过 `SUNLAND_DB_CA` 指定。连接强制 `verify-full`，失败不降级。`SUNLAND_DB_PORT` 默认 5432。
- Storage 复用 `.env.local` 中的授权，不输出凭据。

## 操作

```bash
scripts/supabase-backup/backup-production.sh
scripts/supabase-backup/verify-backup.sh /Volumes/机械硬盘/SunlandBackups/批次
scripts/supabase-backup/restore-local.sh /Volumes/机械硬盘/SunlandBackups/批次
```

备份仅写新的独立时间戳目录；旧批次 resume 已禁用，避免混用不同窗口的清单和归档。默认复用 `2026-10-25_09-33-27` 的 Storage 密文（可用 `SUNLAND_STORAGE_BASE` 指定已有批次），只下载新增或 updated_at/ETag/size 变化对象，重组为新的完整加密 tar；结束前再次枚举，变化则失败。生产备份凭据无效时停止，不通过 legacy `login_role.py` 创建或提权角色（该命令已禁用）。

独立复验创建 `verify-run.*`；恢复创建 `restore-run.*`，复制密文和清单后运行，不覆盖原始归档或历史报告。恢复目标始终为带随机标签、无网络、无映射端口的本地容器及 `sunland_restore`。不会使用其他项目的数据库。报告缺失、`passed:false` 或 `cleanup_complete:false` 均代表失败。

## 验证范围

- 密文大小和 SHA-256、固定九项 Manifest 范围、项目标识及 Storage 汇总。
- AES-256-GCM（96-bit 随机 IV、认证文件头、认证标签）、明文大小及 SHA-256；独占创建文件，失败不删除既有目标或 sidecar。
- Storage 拒绝重复成员、危险路径和链接；实际提取后逐对象重算 SHA-256，对照源 size、可用单段 ETag/MD5、Bucket 汇总，并与恢复库 `storage.objects` 的路径/大小摘要比较。对象路径只留在加密归档或受控临时目录中。
- `pg_restore --exit-on-error` 实际分段恢复，重放对象 owner/ACL；CHECK 在 COPY 后恢复原定义，并重新验证源端已验证的 CHECK，真实违规必须失败。
- PostgreSQL 只读 REPEATABLE READ 事务导出快照，dump、业务 inventory、行数基准在同一快照采集，持有事务在导出结束后关闭；roles/Storage 另记时间。
- 本机 `pg_restore` 将归档 SQL 流式发送到无网络容器内 psql；源 dump/restore 客户端版本必须匹配，本次用 18.6 客户端恢复到 17.6 隔离服务端。
- 扩大的业务对象清单包含聊天、OC、资料、权益、注销、邮箱、手机号、Auth 和 Storage，比较列类型/默认值摘要/可空属性、索引定义、约束定义/状态、全部 public 普通函数定义摘要/owner/ACL、安全定义者、触发器定义/状态、RLS/策略及扩展版本。旧的六表简化清单不能通过新门禁。

## 严格边界

`COMPLETE` 仅是本次脚本技术门禁结果，**不自动等于 `BACKUP_RESTORE_VERIFIED`**。最终还须人工确认密钥独立保管、覆盖业务恢复范围、托管环境限制及数据库/Storage 时间窗口风险。当前接管结论见 `docs/full-stack-development/requirements/mainland-phone-auth/PHASE-4-BACKUP-RESTORE.md`。

数据库 dump 不包含实际 Storage 文件；数据库内部同快照不代表数据库与 Storage 的原子快照。新批次在 Manifest 中记录 snapshot 和 Storage 采集窗口。历史批次没有这些精确基准，不能被追认。复验时间不能代替备份时间。

角色不含密码；本地 postgres 保留 bootstrap 超级权限，角色成员授权移除 `GRANTED BY`；Vault 使用临时根密钥，生产密钥恢复未验证。托管服务配置、Secrets、外部 Worker/KV/DO、OAuth 等须单独重建。pg_net 0.14.0→0.20.3、pg_cron 1.6→1.6.4 两组已知本地版本差异允许独立列为托管限制，仍使完整比较失败；其他扩展变化和任何业务差异仍阻断核心验收。核心通过独立记录 `CORE_BUSINESS_RESTORE_VERIFIED`，完整验收未通过时保留 INCOMPLETE、不生成 COMPLETE。无网络容器不会验证真实 HTTP、Cron 业务或云端权限。

临时明文在权限 700 的目录中，结束后清理；清理失败必须记录并使结果失败。普通删除不保证物理介质上的不可恢复性。历史归档和正式验收证据不自动删除。

已验证恢复必须显式使用 UTF8 / en_US.UTF-8，禁止让 `initdb --no-locale` 默认为 SQL_ASCII 后以字节计数字符长度。实际环境记录在每次 run 的 `database-environment.json`，两项业务 CHECK 仍必须实际 VALIDATE。ACL 仅规范化简单条目顺序；`email_codes.id` 的 UUID 默认值限定名规范化有原始归档定义证据，其余业务差异仍失败。
