# Phase 3A PostgreSQL 隔离验收

日期：2026-10-24。仅本机独立 Docker PostgreSQL、合成数据；未连接生产执行写入，未调用短信或云端业务 API。

## 实际执行

```sh
node scripts/test-phone-postgres.mjs
```

前置检查：Docker Engine `29.8.2`、Supabase CLI `2.109.1` 可用；项目没有完整 `supabase/config.toml` / 可重建全部业务表的初始迁移。因此采用用户允许的最小 PostgreSQL 隔离环境，没有启动或重置 Supabase Local 项目。

使用已存在的本地镜像 `public.ecr.aws/supabase/postgres:17.6.1.143`，镜像 ID：`sha256:80d7b27c3e8d77cfa7226eee9508671796da214781ff15a35b3670d7ad5ee453`，实际 `SHOW server_version` 为 **17.6**。

最终运行容器：`sunland-phone-test-9d4c2b49-fd48-4cdc-8483-0e923525b637`。`network none`、无宿主端口、只读根文件系统、postgres 非 root 用户、768MB tmpfs 数据目录、2 CPU / 1GB 内存 / 128 PID 限制；不创建永久卷。脚本仅执行该次随机名称容器的 `docker exec psql`，不接受数据库 URL，不能选择生产连接。

任务开始时存在 8 个 `supabase_*_sunland_chat_reconstruction` 容器，未停止、修改、重启或删除。finally 先校验独有 label 与本次 UUID，再仅清理自己的容器，tmpfs 随之丢弃。最终容器已删除。

## 迁移基线与覆盖边界

`tests/fixtures/phone-postgres-baseline.sql` 使用 Phase 2 已审计的 `user_profiles` 列、默认值、约束、邮箱唯一索引，以及原 `sunland_account_delete_begin/finalize/sanitize_profile`、`sunland_authenticated_identity_is_active` 函数定义；仅包含假数据。测试实际按顺序执行仓库文件：

1. `20260906010000_account_deletion.sql`
2. `20260911120000_account_deletion_finalize_order.sql`
3. `20261024003756_phone_identity.sql`

两个独立数据库分别验证空白数据库建立上述基线后迁移，以及迁移前已有邮箱/Pro profile 的升级。原删除任务表、claim RPC 和 finalize 字段升级均使用真实迁移；没有为了测试修改 Phase 2 SQL。

这不是全量生产 schema 恢复。项目缺少某些既有业务表初始迁移及完整触发器定义，未伪造这些表/触发器来声称全量清理通过。原业务清理 RPC 能创建，但本次不调用缺少业务表依赖的清理分支；只执行真实 claim/begin/finalize/sanitize 身份生命周期和 phone trigger。

已保存的 Phase 2 目录证据缺少 `pg_policies.permissive`。本轮尝试只读 Supabase `execute_sql` 查询该字段，工具返回 `not available to the model`，未反复尝试。基线因此明确仅重建已知 own-id SELECT/UPDATE policy、列权限，单独执行 active helper；没有猜测 active_* policy 的模式。手机号五表的 RLS 和 RPC ACL 则由实际 phone 迁移完整建立并验收。完整业务触发器及所有现有 policy 模式仍须在生产发布前补齐隔离演练。

## 结果：15 / 15 通过

| 检查 | 实际结果 |
| --- | --- |
| 空白数据库执行基线、删除迁移、phone 迁移 | 通过 |
| 已有 profile 升级及绑定后保留 email、UUID、Pro | 通过 |
| 缺失/不匹配 lookup canary 失败关闭 | 通过 |
| 首次注册原子创建、已有号码返回原 UUID | 通过 |
| 两独立连接同时注册同号 | 一个新账户，另一个返回相同 UUID，无孤儿 profile |
| phone/user 唯一约束及 FK | 重复号码、同用户第二映射、孤儿映射均拒绝 |
| 两账户并发绑定同号 | 一个 OK，一个 PHONE_CONFLICT；败方 grant 未消费 |
| 更换、解绑及唯一登录因子保护 | 原子变更成功，邮箱证明解绑，phone-only 拒绝解绑 |
| 错误会话、用途、过期及已消费 grant | 全部拒绝 |
| 锁等待后 grant 到期 | 等锁后返回 REAUTH_INVALID，不绑定 |
| 注销与登录交叉等待 | 原 profile 锁等待被观测；retirement 完成，无锁序死锁 |
| 事务异常 | 插入失败回滚 profile、mapping、grant、version 和 operation |
| deleting / fence / lease / retired / 号码释放 | 删除中拒绝登录，未清理或过期 lease 拒绝退休，合法 finalize 释放；重新注册新 UUID，旧 UUID 保持 retired |
| RPC、phone 表 ACL 和 RLS | anon/authenticated 不可读写 phone 表或执行 RPC，service_role 可调用但不可改 canary；五表 RLS 开启 |
| 数据库 JWT claim 权限边界 | 自定义 id 仅可访问本人的 profile；可改昵称，不可改 user_id/email/Pro/identity_status；仅 sub 不替代 id |

四个并发检查均真实启动两个独立 `docker exec ... psql` 进程；A 在未提交事务中持锁，B 发起 RPC。第三监控连接用 `pg_stat_activity`、`pg_blocking_pids`、不同 PID 和 `wait_event_type='Lock'` 断言 B 真的被 A 阻塞，再检查提交结果。不是 JS Promise 排队模拟。

实际最终输出摘录：

```text
PostgreSQL 17.6; isolated container sunland-phone-test-9d4c2b49-fd48-4cdc-8483-0e923525b637
contention evidence: register-a and register-b; distinct backend PIDs; pg_blocking_pids + wait_event_type=Lock observed
contention evidence: bind-a and bind-b; distinct backend PIDs; pg_blocking_pids + wait_event_type=Lock observed
contention evidence: expiry-a and expiry-b; distinct backend PIDs; pg_blocking_pids + wait_event_type=Lock observed
contention evidence: retire-a and retire-b; distinct backend PIDs; pg_blocking_pids + wait_event_type=Lock observed
PASS 15/15 actual PostgreSQL checks; no production network, no SMS
cleanup: removed only owned isolated container; tmpfs database discarded
```

首轮失败定位于测试脚本在同集群第二数据库重复 `CREATE ROLE anon`。角色为集群级，现改为仅创建一次，各数据库仍独立建 schema；不涉及 Phase 2 迁移修复。

数据库 JWT 检查是在 PostgreSQL 中设置假 `request.jwt.claims` 后实际执行角色权限与 RLS；未通过 PostgREST 验签，不把 claim fixture 称为真实 JWT 网关验收。原 Worker 签名、900 秒数据库 JWT、id/sub 字段由 Worker 自动化测试另外验证。

结论：**上述 phone 迁移、事务和多连接竞争已通过真实 Docker PostgreSQL 隔离验收，可继续本地网站 Mock 接入。** 尚不能据此发布生产或宣称已完成全量现网 schema 演练、真实 Turnstile、真实短信、Cloudflare DO 持久化与生产端到端验收。

主Agent最终复验（同一脚本，2026-10-24）：容器`sunland-phone-test-29685106-3aa3-4a6d-a0d9-d4db8ba33076`，15/15通过，4组真实阻塞断言再次通过；finally已删除该容器，原8个开发容器仍保持。
