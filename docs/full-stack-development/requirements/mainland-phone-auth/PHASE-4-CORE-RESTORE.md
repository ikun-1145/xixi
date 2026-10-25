# Phase 4：核心业务备份恢复已验证

2026-10-25，Asia/Shanghai。结论：**CORE_BUSINESS_RESTORE_VERIFIED**，解除此前 `CORE_BUSINESS_RESTORE_BLOCKED`。生产备份的核心数据恢复前置已满足；这不代表允许直接发布，也不代表完整 Supabase 灾难恢复通过。

## A–D 验收结果

| 级别 | 结果 | 证据 |
| --- | --- | --- |
| A. 新数据库备份完整性 | **通过** | 新全库 pg_dump、AES-256-GCM、密文/明文 SHA-256、GCM 认证、目录可读及实际恢复通过 |
| B. 核心业务恢复 | **CORE_BUSINESS_RESTORE_VERIFIED** | 19 张业务表同快照精确行数匹配；结构、列、索引、约束、122 个 public 函数、触发器、owner/ACL、RLS/策略通过；两项 CHECK 实际 VALIDATE 通过 |
| C. Storage | **当前批次恢复通过** | 复用旧 83 个对象，仅下载新增头像 1 个、94,427 字节；新归档 84 个对象全部实际提取/校验并与恢复库路径/大小匹配；跨系统原子性未证明 |
| D. 完整 Supabase 灾难恢复 | **未通过，独立限制保留** | pg_net/pg_cron 版本、托管角色/Vault/平台配置、实际服务行为及跨系统窗口限制仍在；未签发 BACKUP_RESTORE_VERIFIED |

## 新批次、时间和加密

目录：`/Volumes/机械硬盘/SunlandBackups/2026-10-25_10-58-30/`。

- 批次窗口：10:58:30–11:00:34。
- 数据库快照 ID：`00000017-000091F6-1`；只读 REPEATABLE READ 持有/导出窗口为 10:58:30.410082–10:59:18.485639。pg_dump、inventory、精确行数都显式导入同一 snapshot。10:58:34.339099 是验证连接的事务开始时间，不冒充快照创建瞬间；创建瞬间未单独记录。
- 原生客户端为 PostgreSQL 18.6；源服务器 17.4。本机 pg_restore 18.6 将 SQL 流发送到无网络 Docker PostgreSQL 17.6，实际加载验证其兼容性，不假设跨版本天然兼容。
- 数据库密文 4,614,324 字节，解密归档 4,614,288 字节；roles 密文 6,292 字节，明文 6,256 字节，不含角色密码。
- AES-256-GCM、随机 96-bit IV、认证头和标签，附明文大小/SHA-256 sidecar。使用已由用户确认独立保管的现有密钥，未显示或提交密码/密钥。
- 旧备份全部保留。新批次 `initial-restore/` 是发现编码问题时的失败证据；**最终验收为 `restore-run.GPe92O/restore-result.json`（11:04:59）**，没有覆盖失败记录。

| 密文文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| database.dump.aesgcm | 4,614,324 | `8bd1684d8f11add193d944d966601ec95e57c53c319413df1de273f99e170481` |
| roles.sql.aesgcm | 6,292 | `af65c044f57fe11f80b030f868f30877a474cd10e42edf8ec3332dd9f2039d4c` |
| storage.tar.aesgcm | 22,640,676 | `6d09940e183c83c8d3746fcf565d00a1acd119008a22bb28570486c87faee754` |

数据库明文 SHA-256：`ebf122a201077ea7be8e04a7999c49d99e772825f1652cf22723c6293cbc73c2`。Manifest 九项文件大小/哈希全部匹配，额外验收证据也记录大小/哈希；原始密文在修复本地恢复环境后没有改变。

## 连接与 TLS

用户更新现有钥匙串记录后，本轮已从服务 `dev.sunland.supabase.production.db-password` 读取并成功连接 Session Pooler（5432）。旧密码拒绝问题已解除；此前 Kimi 临时角色路径不再使用，没有创建角色、改权限或重置密码。

正式备份改用已验证的本机 PostgreSQL 18.6 客户端和官方 CA，固定 `PGSSLMODE=verify-full`。实测 TLSv1.3 / TLS_AES_256_GCM_SHA384；故意给错误主机名的负例在密码认证前被证书主机名校验拒绝。**没有用 require、关闭证书验证或仅加密不验证主机名作为最终门禁。**

此前 Docker 源连接路径仍出现意外断连，本轮没有继续轮换密码或降低 TLS，而是复用用户和主智能体均已验证的原生客户端；Docker 保留为隔离恢复工具。`tls-client-evidence.json` 留存安全元数据，没有密码。

`snapshot-evidence.json` 的 pg_stat_ssl 记录 Pooler 到数据库后端一段为 false，不能拿它冒充本机到 Pooler 的 TLS 状态；客户端一段由 conninfo 和错误主机名负例明确验证。未改变 Supabase SSL Enforcement，未声称平台内部每段传输已验收。

## 两项 CHECK 的真实根因与纠正

**此前“历史业务数据超限”的判断有误，现撤回该结论。** 恢复脚本使用 `initdb --no-locale` 且未指定编码；已用同一镜像实际复现其默认初始化为 SQL_ASCII。该环境对 UTF-8 中文按字节计 char_length，15,617 和 626 因而不能被当作生产 UTF-8 字符长度。

本轮首次恢复仍重现问题，随后仅修正隔离初始化为 `--encoding=UTF8 --locale=en_US.UTF-8`，记录并断言实际编码；复用同一份新归档重试，未重新导出、未下载旧对象、未改任何业务值。最终恢复环境确认为 UTF8 / en_US.UTF-8，与源环境一致：

| 约束 | 恢复最大字符长度 | 违规行 | VALIDATE |
| --- | ---: | ---: | --- |
| chat_messages_text_len（≤8000） | 5,493 | 0 | **通过，已验证状态** |
| oc_profiles_description_check（≤500） | 243 | 0 | **通过，已验证状态** |

恢复为加载顺序暂存 CHECK 后，按原定义重建并实际验证；没有删除约束或永久保留 NOT VALID。旧批次未在正确编码下逐份重验，因此不追认其全部验收通过，但不能再依据旧 SQL_ASCII 报告指控生产数据不合法。

## 核心对象、权限和行数

最终实际 pg_restore 加载成功。源/恢复对照为 19 张表、59 个索引、54 个约束、122 个 public 普通函数、14 个业务触发器、21 个策略。列类型、默认值摘要、可空/identity/generated、函数定义摘要及 owner/ACL/SECURITY DEFINER、RLS/force RLS、触发器状态均比较。以下同一快照行数逐项一致：

| 表 | 源 / 恢复 |
| --- | ---: |
| auth.identities | 88 / 88 |
| auth.users | 86 / 86 |
| public.account_deletion_jobs | 2 / 2 |
| public.activation_codes | 2800 / 2800 |
| public.chat_messages | 593 / 593 |
| public.chat_threads | 8 / 8 |
| public.conversations | 327 / 327 |
| public.email_codes | 0 / 0 |
| public.oc_profiles | 10 / 10 |
| public.orders | 0 / 0 |
| public.profiles | 0 / 0 |
| public.request_logs | 0 / 0 |
| public.thanks | 5 / 5 |
| public.thanks_likes | 6 / 6 |
| public.usage | 8 / 8 |
| public.usage_logs | 6 / 6 |
| public.user_profiles | 380 / 380 |
| storage.buckets | 2 / 2 |
| storage.objects | 84 / 84 |

两个非语义差异已核实并严格规范化：

- ACL 数组项顺序：只对简单无引号角色条目排序，保留权限、授予者和 grant option；新增 rw 权限的负例仍失败。
- 仅 `public.email_codes.id` 的 `uuid_generate_v4()` 与 `extensions.uuid_generate_v4()` 打印限定名不同。直接从本次原始归档 schema 核实默认值是 `"extensions"."uuid_generate_v4"()`，比较器只规范化这两个已知表达式摘要，其他默认值变化仍失败。

最终比较仅剩两个已知扩展版本差异；因此完整 `passed:false`，而独立的 `core_business_passed:true`。未用忽略未知对象、约束或业务差异的方法取得通过。

邮箱/手机号尚未执行的迁移对象不在生产中出现，属于已知发布前置，不是恢复丢失。本次验证了既有邮箱数据、资料、Pro/激活码、聊天、注销函数等恢复范围；没有用生产用户执行登录、发权益或注销。

## Storage 增量与一致性

- 复用批次：`2026-10-25_09-33-27`。旧 83 个对象由本地加密 tar 解密后复用，仅下载新增头像 1 个；没有重下 83 个对象。
- 本次枚举/下载窗口：10:59:22.937509–11:00:33.922306；初次枚举结束 10:59:56.617487，结束前再次枚举版本集合相同。
- 新 tar 明文 22,640,640 字节，密文 22,640,676 字节；实际对象 22,517,681 字节。avatars 66 个 / 14,869,346 字节，chat-images-v1 18 个 / 7,648,335 字节。
- 84 个对象全部通过实际提取、SHA-256、源 metadata size、84 个 ETag/MD5、Bucket 汇总和恢复库 Bucket/路径/大小摘要比较。失败 0，未上传到任何测试云项目。

**仍非数据库与 Storage 原子快照。** 稳定枚举、ETag 和路径/大小关联不能排除跨窗口同路径同大小替换。灾后恢复仍须隔离写入并核对缺失、孤立及覆盖对象；本次没有发现需额外补偿的对象，不能由此推断将来永无窗口风险。

## D 级限制及不改变的边界

- pg_net 源 0.14.0 → 本地 0.20.3；pg_cron 源 1.6 → 本地 1.6.4。仅这两组明确替代允许与核心状态分开，完整版本比较仍失败。两份待发布身份迁移不直接依赖它们；外部调度/HTTP 运行行为未验收。
- 本地 postgres 保留 bootstrap 超级权限，角色密码不导出，成员授权去掉 GRANTED BY；托管角色授权来源未完整复刻。核心对象 owner/ACL 已重放并比较，但不等于真实 PostgREST/OAuth 权限链路通过。
- Vault 使用临时根密钥，生产 Vault 密钥恢复未验证；托管 Auth/API/Storage 配置、Secrets、外部 Worker/KV/DO 不由 pg_dump 自动重建。
- 本地 publication 的两个 wal_level 警告保留，未验收 Realtime/逻辑复制；不把无网络容器启动等同于 Supabase 云服务恢复。
- 新批次有 CORE_BUSINESS_RESTORE_VERIFIED 标记；完整验收未通过，按脚本约定保留 INCOMPLETE、不创建 COMPLETE。完整 BACKUP_RESTORE_VERIFIED 仍未签发。

隔离容器无网络、无发布端口，独立 sunland_restore；最终 cleanup_complete:true，临时明文和本次容器已清理，不触碰其他项目或历史备份。

## 验证、提交与手机号上线余项

备份专用合成测试 9/9 通过；新快照 SQL、核心/完整分级及 ACL/default 规范化负例先失败后通过。Python AST、shell bash -n、git diff --check 通过；没有重复执行无关前端全量测试。单名只读审查员复核了安全、快照、Storage 复用、编码及比较门禁，未操作生产或 Docker。

本次未生产写入、迁移、创建角色、重置密码、修改 Secrets、部署或发送短信。原有 Codex 配置修改及其备份保留，不提交。提交 ID 见本报告 Git 历史及最终回复，未 push。

**核心备份恢复门禁已解除；手机号正式上线仍未授权执行。** 最短后续：

1. 单独授权并验收原子邮箱 OTP 迁移，生产仍缺 sunland_otp；先确认既有邮箱登录/刷新兼容。
2. 授权手机号加法式迁移，验证 RPC、RLS、触发器、权限和 canary 配置。
3. 授权 Cloudflare PHONE Secrets/策略、DO 绑定/迁移和受鉴权账本初始化；默认关闭，部署兼容 Worker 后先做邮箱回归。
4. 完成受限 canary、PostgREST JWT、Turnstile/CORS、预算/恢复与真实设备验收；真实短信及计费另行授权。
5. 最后授权网站发布、设置有效 sitekey 并开放手机号入口，保留紧急关闭及 phone-only 用户兼容回滚边界。

参考：[Supabase 连接](https://supabase.com/docs/guides/database/connecting-to-postgres)、[PostgreSQL pg_dump 快照](https://www.postgresql.org/docs/17/app-pgdump.html)。
