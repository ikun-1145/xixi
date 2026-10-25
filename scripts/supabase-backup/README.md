# Supabase 生产数据本地备份与恢复验收

限定项目 `klyrasrqgxijwrxuoevj`。仅生产只读导出、SELECT 和 Storage GET/list；不创建临时角色、不迁移、不部署、不修改对象。本地测试命令：

```bash
python3 scripts/supabase-backup/tests/test_safety.py
```

## 本机前提

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

备份仅写新的独立时间戳目录；旧批次 resume 已禁用，避免混用不同窗口的清单和归档。不要重复下载完整对象；当前脚本若重新执行全量备份会重新下载 Storage，须先判断必要性。生产备份凭据无效时停止，不通过 legacy `login_role.py` 创建或提权角色（该命令已禁用）。

独立复验创建 `verify-run.*`；恢复创建 `restore-run.*`，复制密文和清单后运行，不覆盖原始归档或历史报告。恢复目标始终为带随机标签、无网络、无映射端口的本地容器及 `sunland_restore`。不会使用其他项目的数据库。报告缺失、`passed:false` 或 `cleanup_complete:false` 均代表失败。

## 验证范围

- 密文大小和 SHA-256、固定九项 Manifest 范围、项目标识及 Storage 汇总。
- AES-256-GCM（96-bit 随机 IV、认证文件头、认证标签）、明文大小及 SHA-256；独占创建文件，失败不删除既有目标或 sidecar。
- Storage 拒绝重复成员、危险路径和链接；实际提取后逐对象重算 SHA-256，对照源 size、可用单段 ETag/MD5、Bucket 汇总，并与恢复库 `storage.objects` 的路径/大小摘要比较。对象路径只留在加密归档或受控临时目录中。
- `pg_restore --exit-on-error` 实际分段恢复，重放对象 owner/ACL；CHECK 在 COPY 后恢复原定义，并重新验证源端已验证的 CHECK，真实违规必须失败。
- 扩大的业务对象清单包含聊天、OC、资料、权益、注销、邮箱、手机号、Auth 和 Storage，比较索引定义、约束定义/状态、函数定义摘要/owner/ACL、安全定义者、触发器定义/状态、RLS/策略及扩展版本。旧的六表简化清单不能通过新门禁。

## 严格边界

`COMPLETE` 仅是本次脚本技术门禁结果，**不自动等于 `BACKUP_RESTORE_VERIFIED`**。最终还须人工确认密钥独立保管、覆盖业务恢复范围、托管环境限制及数据库/Storage 时间窗口风险。当前接管结论见 `docs/full-stack-development/requirements/mainland-phone-auth/PHASE-4-BACKUP-RESTORE.md`。

数据库 dump 不包含实际 Storage 文件；两者不是原子快照。历史批次未记录精确枚举起止时间；生产清单/行数查询也未与 dump 共用导出快照，不能据此声称严格同一时点。未来复验必须保留原始采集时间，不能把复验时间写成备份时间。

角色不含密码；本地 postgres 保留 bootstrap 超级权限，角色成员授权移除 `GRANTED BY`；Vault 使用临时根密钥，生产密钥恢复未验证。托管服务配置、Secrets、外部 Worker/KV/DO、OAuth 等须单独重建。pg_net/pg_cron 版本不一致会使严格比较失败，不能静默忽略。无网络容器不会验证真实 HTTP、Cron 业务或云端权限。

临时明文在权限 700 的目录中，结束后清理；清理失败必须记录并使结果失败。普通删除不保证物理介质上的不可恢复性。历史归档和正式验收证据不自动删除。
