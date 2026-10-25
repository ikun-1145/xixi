# Phase 4 生产备份与隔离恢复接管验收

2026-10-25，Asia/Shanghai。最终状态：**BACKUP_RESTORE_BLOCKED**。**未解除 Phase 4 的生产备份阻断，不可据此执行邮箱 OTP/手机号迁移或发布。**

## 接管与范围

已核实 `main` 的交付提交为 `3efba53b60defe3bc91740f9664c62990f85a69c`。`PHASE-4-DELIVERY.md` 和 `00-stage.json` 均记载 1024/1024、Docker 15/15、Edge Mock 20/20；本次没有重跑未受影响的 Phase 4 开发测试，也没有把历史记录当作本次测试结果。

接管时 `.codex/config.toml`、`.gitignore` 已修改，配置备份和整个 `scripts/supabase-backup/` 未跟踪。保留配置及其备份，接管并修正本任务的脚本和备份忽略规则；未切分支、未创建 worktree、未 push。提交以本文件的 Git 历史为准，可运行 `git log -1 --format='%H %s' -- docs/full-stack-development/requirements/mainland-phone-auth/PHASE-4-BACKUP-RESTORE.md` 获取。

本次仅生产 SELECT、Storage 归档本地校验、本地解密/恢复和脚本修复。没有生产数据/Storage 写入、迁移、临时角色创建、Worker/网站部署、短信或密钥轮换。没有把生产行内容、对象路径、凭据或文件内容写入本报告。使用一名只读审查员审查脚本；其未修改文件、访问生产或操作容器。

## 历史批次核验

外接盘及目录实际存在，约 757 GiB 可用；系统卷约 12 GiB 可用。Docker 已运行，复用已有 Supabase PostgreSQL 镜像。其他项目的 Supabase 容器和既存停止容器均未操作。

| 批次（2026-10-25） | 实际状态 |
| --- | --- |
| 07-38-02 | 仅 36 字节数据库密文和 sidecar；没有有效数据库内容、Storage 或 Manifest；不可用 |
| 07-39-46 | 数据库/roles 加密验证通过；行数文件为空，无 Storage/Manifest；不完整 |
| 07-43-31 | 数据库/roles 加密验证通过；行数文件为空，无 Storage/Manifest；不完整 |
| 07-49-41 | 三项归档加密验证、Manifest 九项大小/哈希通过；原恢复记录失败；不完整 |
| 08-33-50 | 三项归档及 Manifest 校验通过；旧六表比较通过但恢复结果失败；不完整 |
| 08-46-02 | 三项归档及 Manifest 校验通过；两项 CHECK 验证失败；不完整 |
| 09-33-27 | 本次选用的最新归档；三项加密验证及 Manifest 九项校验通过，但严格恢复仍失败 |

七个批次均保留 `INCOMPLETE`，均无 `COMPLETE`。前三个没有原始完整 Manifest，计算出的当前哈希不能冒充原始基准。四个含 Manifest 的批次均逐项匹配。没有删除或覆盖历史归档/原报告。

逐批次文件大小、时间、SHA-256 和加密结果保存在最新批次的 `acceptance-20261025T020416Z/historical-batches.json`。该目录为本次独立复验证据，不是新生产备份。

## 当前归档及时间窗口

根目录：`/Volumes/机械硬盘/SunlandBackups/2026-10-25_09-33-27/`。

| 项目 | 证据 |
| --- | --- |
| 原批次窗口 | 09:33:27–09:38:20；原 Manifest 为 UTC 01:33:27–01:38:20 |
| 数据库归档创建 | TOC 内记载 09:33:42；密文完成文件时间 09:35:13 |
| 数据库大小 | 密文 4,608,821 字节；解密后 4,608,785 字节 |
| 数据库版本/工具 | 源 17.4；导出及本地恢复 17.6；主机另有 libpq 18.6，仅用于连接检查，未用于重新导出 |
| roles 大小 | 密文 6,292 字节；明文 6,256 字节；不包含角色密码 |
| 源结构/行数清单 | 文件时间分别为 09:36:03 / 09:36:28，与 dump 未共用已记录的导出快照 |
| Storage 枚举 | 没有精确起止时间记录；按脚本顺序位于行数采集之后、归档完成之前，不能推定为数据库快照时刻 |
| Storage tar 成员写入时间 | 09:37:09–09:38:20；密文完成 09:38:20 |
| Storage 大小 | 密文 22,548,516 字节；解密 tar 22,548,480 字节；实际对象 22,423,254 字节 |

加密为 AES-256-GCM，随机 96-bit IV，认证文件头和认证标签，附明文大小/SHA-256 sidecar。用户在本次会话明确确认密钥已独立保管且可取回；本次使用本机密钥完成实际解密，未展示密钥，也未测试独立保管介质本身。

**不是数据库/Storage 严格原子快照。** 元数据与对象归档虽然在本次恢复中路径、大小一致，仍不能排除窗口内同路径覆盖、删除/新增或其他业务更新。灾后恢复应先隔离业务写入，对照恢复库与对象清单核对缺失/孤立/被覆盖对象；无法取回的对象须由其他版本副本或人工补偿，不能仅重建数据库元数据。

## SHA-256

| 文件 | SHA-256（密文） |
| --- | --- |
| database.dump.aesgcm | `a58741eae7caf3fb1055f4b81797a596360b0ca8daeadd885f734050169cb635` |
| roles.sql.aesgcm | `401c972151b18d8fe3889459e937880bba819a41b751b29c6ba545a6c1788033` |
| storage.tar.aesgcm | `d49470b04e9b165d86aacf6e1dc2daeef9061c916e462cdd6ffc69bbaef3414f` |

数据库明文 SHA-256 为 `85c678198ca5ed563edb974a64dcb631f9ab77df5e193c1f63423e162dd2514d`。三项归档实际通过 GCM 认证、明文大小及 sidecar 哈希；归档目录及 schema 可读，实际完整加载未出现截断错误。

## 数据库恢复与关键对象

复验使用独立随机标签容器、`--network none`、无端口映射、独立 `sunland_restore` 和受限临时目录，不指向生产，也不使用其他项目数据库。原加密归档不变；每次生成新的恢复证据目录。最终证据为该批次 `restore-run.QNdDpT/restore-result.json`（10:17:39，`passed:false`、`cleanup_complete:true`）；对应 `storage-restore-result.json` 的 `database_metadata_matches:true`，`pg_restore.log` 为 0 字节。

原 TOC 1391 项，包含 108 个 CREATE TABLE、110 个 TABLE DATA（含扩展配置表）、177 个 CREATE FUNCTION、148 个 CREATE INDEX、23 个 CREATE TRIGGER、42 个 CREATE POLICY、7 个 SEQUENCE SET、365 个 ACL 及 27 个 DEFAULT ACL 条目。包括 public、auth、storage、私有支付 schema、realtime、vault 等实际 schema。目录存在不等于全部托管能力已恢复。

`pg_restore --exit-on-error` 的 pre-data/data/post-data 实际加载完成。新版复验重放 owner/ACL，不再用 `--no-owner --no-privileges` 掩盖权限差异。CHECK 在加载后按原定义重新添加，并重新验证源端已验证的 CHECK；两项失败保留为失败，没有删除、截短或忽略业务数据。

原生产行数基准仅六表；以下六项全部匹配：

| 表 | 源清单 | 恢复 |
| --- | ---: | ---: |
| auth.identities | 88 | 88 |
| auth.users | 86 | 86 |
| public.account_deletion_jobs | 2 | 2 |
| public.user_profiles | 376 | 376 |
| storage.buckets | 2 | 2 |
| storage.objects | 83 | 83 |

扩大的本地恢复清单还记录：chat_messages 593、chat_threads 8、oc_profiles 9、conversations 325、activation_codes 2800、thanks 5、thanks_likes 6、usage 8、usage_logs 6；email_codes/orders/profiles/request_logs 均为 0。它们没有同快照的原生产行数证据，不能声称已逐项证明源端一致。

本地业务清单覆盖 19 张表、59 个索引、54 个约束、3 个注销函数、14 个触发器、21 个策略和 7 个扩展。对本次当前生产只读元数据比较：索引定义、3 个注销函数的定义摘要/owner/ACL/SECURITY DEFINER、触发器定义/状态及策略定义匹配；约束两项、扩展版本两项不同。当前生产元数据是后续时点佐证，不能替代备份时点的完整清单。

邮箱 `sunland_otp` RPC 和手机号表/RPC未出现在归档/当前生产核查范围内；这与尚未执行生产迁移一致，不能当成应从备份恢复而丢失的对象。注销流程三个既有函数存在并比较通过；用户资料、Pro/激活码等业务表已恢复，但没有执行真实登录、权益发放或注销业务。

## 两项约束：未解决

| 约束 | 原始归档定义/状态 | 实际恢复结果 |
| --- | --- | --- |
| chat_messages_text_len | `char_length(text) <= 8000`，已验证 | 1 条超限；最大 15,617 字符；重新 VALIDATE 失败 |
| oc_profiles_description_check | `char_length(description) <= 500`，已验证 | 1 条超限；最大 626 字符；重新 VALIDATE 失败 |

归档 schema 中两项均没有 `NOT VALID`。恢复为 `NOT VALID` 是本地加载兼容步骤，不能冒充与源端状态一致。这不是格式化差异，也不能仅由恢复顺序解释：实际数据违反定义。

08-46-02 和 09-33-27 两份原报告均记载同样违规；本次独立恢复再次重现。因而“重新备份后已解决”不成立。

本次 10:06:53 的生产只读统计中，内置 `pg_catalog.char_length` 对应的最大长度分别为 5,493 / 243，违规行均为 0；生产约束仍为已验证。生产后续数据与归档不同，与时间窗口内发生变化的解释相容，但缺少历史修改审计，无法证明具体时间、原因或执行者。**当前生产已无违规，不会修复旧归档。** 本次未修正生产或恢复副本中的业务值。

## Storage 实际恢复

| Bucket | 对象数 | 对象字节 |
| --- | ---: | ---: |
| avatars | 65 | 14,774,919 |
| chat-images-v1 | 18 | 7,648,335 |
| 合计 | 83 | 22,423,254 |

完整 tar 解密、受控目录实际提取及逐文件重新读取通过。83 个对象均匹配归档 SHA-256、源 metadata size 和可用的单段 ETag/MD5；Bucket 映射/汇总匹配，失败数为 0，拒绝重复成员、危险路径或链接。恢复库 `storage.objects` 的 Bucket/路径/大小摘要另行比较；结果在每次 run 的 `storage-restore-result.json` 中。未上传到任何云测试项目。

归档内部 SHA-256 证明往返完整性，源 ETag/大小提供额外源端依据；无法据此证明未来生产 Storage 状态或跨系统原子性。

## Supabase 恢复限制

- 本地角色保留 bootstrap postgres 超级权限，密码不导出；角色成员授权去掉 `GRANTED BY`，未证明授权来源与托管环境完全相同。业务对象 owner/ACL 已重放且扩大比较，但旧清单没有备份时的完整权限基准。
- 源 pg_net 为 0.14.0，本地镜像默认 0.20.3；源 pg_cron 为 1.6，本地 1.6.4。严格扩展比较失败，未假装一致。Cron job/job_run_details 在 TOC 中；无网络容器没有验证调度外部副作用或网络请求。
- pgsodium 为本地预加载兼容项，不在源已安装的七个扩展中；不能把本地可启动当作源密钥恢复证明。
- Vault 使用本地临时根密钥；源当前只读统计 vault.secrets 为 0，但没有据此宣称任意历史密文可解密。源密钥管理、托管配置须另行处理。
- 托管 Auth/API/Storage 服务配置、OAuth/SMTP/Secrets、JWT 签名密钥，以及外部 Worker/KV/DO 不由数据库逻辑备份自动重建。没有执行云端权限或真实客户端验收。

## 本次脚本修复与验证

已修复 AEAD 失败误删既有目标/sidecar，禁用可写 CLI 角色及旧批次 resume；使用既有钥匙串凭据和官方 CA 的 `verify-full`。固定 Manifest 范围，拒绝部分 Storage/重复 tar 成员，实际提取并核对 Bucket、ETag 和数据库对象摘要。恢复使用独立 run，重放 owner/ACL，扩大定义/权限/状态比较；失败和清理结果须显式记录，关键差异不放行。

合成数据回归 `python3 scripts/supabase-backup/tests/test_safety.py`：6/6 通过（已有文件/sidecar 保留、篡改拒绝、重复成员拒绝、实际提取及错误清单拒绝）。最初的三个缺陷回归（重复 tar、已有密文及解密目标保留）先在原脚本失败，再修复通过。Python AST、逐文件 `bash -n`、Node `--check`、`git diff --check` 均检查；没有重复运行无关前端全量测试。未改 Skills、TOML 或 MCP 配置。

只读审查复核了文件所有权清理、角色、Storage 和恢复门禁，并提出早期失败结果与清理异常处理建议，已纳入修复。

## 最终阻断及后续

1. 旧归档中两项 CHECK 无法恢复到原已验证状态，属于关键业务恢复问题，不能忽略。
2. 原生产基准仅六表且不含完整定义/权限，不能证明整个业务范围同快照恢复；扩展版本差异仍需兼容性验收。
3. 有必要采集新数据库恢复点，但既有 Keychain 凭据在证书验证通过后返回 `password authentication failed`；用户确认更新本地凭据后重试仍失败。没有申请可写临时角色、重置生产密码或重新导出全库。须先在本机安全核实准确的项目/用户/密码和连接方式，再只读采集到新独立目录。
4. 新批次应使用一致的数据库快照采集 dump/对象/精确行数基准，并记录 Storage 枚举及下载时间；先比对旧对象，只补缺失或变化对象。若跨系统仍非原子，明确保留风险与补偿方案。

密钥独立保管确认已满足，Storage 旧批次恢复验证已通过，但其余关键条件没有满足；维持 **BACKUP_RESTORE_BLOCKED**，不创建 `BACKUP_RESTORE_VERIFIED` 或原批次 `COMPLETE`。

备份门禁关闭后仍需独立授权并验收：原子邮箱 OTP 迁移及既有邮箱/刷新兼容、手机号加法式迁移、Cloudflare Secrets/默认关闭护栏、真实 DO 预算/恢复、PostgREST JWT、Turnstile/CORS、受限 canary/真实短信计费与移动设备，最后才是 Worker/网站发布。

参考：[Supabase 数据库备份与 Storage 边界](https://supabase.com/docs/guides/platform/backups)、[TLS 证书校验](https://supabase.com/docs/guides/platform/ssl-enforcement)、[PostgreSQL pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html)。

## 2026-10-25 核心恢复范围收敛

后续按 A（新数据库备份）、B（核心业务恢复）、C（Storage）和 D（完整灾难恢复）分别验收，见 [核心恢复与连接阻断](PHASE-4-CORE-RESTORE.md)。连接参数已匹配项目缓存，既有凭据仍被拒绝；未生成新 dump，B 级维持 `CORE_BUSINESS_RESTORE_BLOCKED`。Storage 只读清单较旧归档新增一个 94,427 字节头像对象，无须重下原 83 个。完整 `BACKUP_RESTORE_BLOCKED` 状态保留，未执行生产发布。
