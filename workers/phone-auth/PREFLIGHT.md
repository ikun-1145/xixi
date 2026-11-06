# 手机认证初始化与 Canary 操作准备

本文是待审操作方案，不授权执行。本文不包含真实手机号、密钥或白名单摘要。生产数据库、DO 初始化、功能开关、真实短信、生产部署分别需要明确授权。不要对生产使用暂存 Worker：它不保证数据库隔离。

## 当前验收边界

2026-11-06 只读核对：生产五张手机认证表 RLS 已开启，anon/authenticated 无表读写权限，service_role 对配置表无 UPDATE；手机身份 RPC 为 SECURITY INVOKER，只有 service_role 有执行权限；手机表无未验证约束。配置 singleton 尚未初始化，身份、状态、授权与操作记录表均为空；独立 DO 命名空间没有对象。两个 RPC 函数体摘要与本地迁移一致。三个功能开关均关闭。生产状态会变化，执行前须重新核对，不能凭本文的快照执行。

Secret 名称、Key ID 或白名单格式存在不证明 Secret 值正确、白名单与当前 HMAC key 匹配、或 keyring 的 `v1` 与备份一致。必须从安全保管源核对，不轮换、不输出、不将其写入 PR。数据库初始化前需具备独立可恢复的密钥备份及经完整恢复验证的备份；历史备份验证有约束失败，不能直接认定可恢复。本机加密密钥备份文件的目录/文件权限已检查为 700/600；其余核心密钥未找到同等本机备份。仅使用合成密钥验证了加密、校验和解密流程，未读取或核对真实密钥，须由保管人独立确认所有密钥的安全备份与恢复。

生产版本 `adef974d-63eb-4cdb-aeb9-dc38b6309cd4` 以 xixi 本地 `bb0dca1` 的独立构建部署；本轮只读取回当前生产模块并计算 SHA-256，与该提交从原检出位置重建的 bundle 均为 `4686354414700d421873a33d469bc527582015c7c0fea13f4f48d16519de8382`。本 PR 后续增加 challenge 恢复相关 Worker 改动，尚未部署；生产版本不包含这些改动。不同检出目录的本地构建只有源码路径注释不同，因此原始 bundle 摘要不同；去除这些路径注释后已确认构建文本一致。

## 数据库初始化方案（未执行）

1. 保持 `PHONE_IDENTITY_ENABLED`、`PHONE_SMS_ENABLED`、`PHONE_NEW_REGISTRATION_ENABLED` 均为 `false`。确认对应项目、维护窗口和回滚责任人；确保无其他手机号身份写入方。独立只读复查 singleton 存在且两个 lookup 字段为 NULL、身份/状态/授权/操作四张表均无记录、函数/约束/权限与已审查版本一致。任何条件变化即停。
2. 在安全环境使用现有 `PHONE_IDENTITY_LOOKUP_KEY` 的 UTF-8 字节计算 `HMAC-SHA256(key, UTF8("sunland-phone-index-canary:v1" + NUL))` 的小写十六进制。参数 `key_id` 须与生产 `PHONE_IDENTITY_LOOKUP_KEY_ID` 一致，当前为 `v1`；不在命令行参数、终端、日志或聊天中展示密钥和 HMAC 值。使用参数化数据库客户端并关闭参数日志。仅有 Secret 名称不能完成密钥匹配证明。
3. 以已明确授权的特权数据库会话执行单事务：获取与身份 RPC 相同的 advisory transaction lock `(20261024, 2)`，然后对 `public.sunland_phone_identities`、`public.sunland_phone_auth_state`、`public.sunland_phone_auth_grants`、`public.sunland_phone_auth_operations` 按此顺序获取 `SHARE ROW EXCLUSIVE` 表锁，防止初始化检查与并发身份写入交错。持锁后再次检查状态，再执行以下参数化语句；`$1` 是 key ID，`$2` 是上一步摘要：

```sql
UPDATE public.sunland_phone_auth_config
SET lookup_key_id = $1, lookup_check = $2
WHERE singleton = true AND lookup_key_id IS NULL AND lookup_check IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.sunland_phone_identities)
  AND NOT EXISTS (SELECT 1 FROM public.sunland_phone_auth_state)
  AND NOT EXISTS (SELECT 1 FROM public.sunland_phone_auth_grants)
  AND NOT EXISTS (SELECT 1 FROM public.sunland_phone_auth_operations)
RETURNING singleton;
```

只有恰好返回一行且参数格式正确时才提交；否则回滚并停止。提交后在受控会话内仅返回“配置存在且与相同参数匹配”的布尔结果，不输出摘要。超时、连接断开或提交结果不确定时先只读核实，禁止盲目重试、覆盖或更换 key。

使用合成数据的本地 PGlite PostgreSQL 模拟已验证：首次条件更新成功；重复执行、已有身份/状态/授权/操作记录及半配置状态均拒绝，字段不被覆盖。可用 `PHONE_PREFLIGHT_PACKAGE_ROOT=/path/to/local/package node --test workers/phone-auth/tests/initialization-rehearsal.mjs` 复验；该目录须已有 `@electric-sql/pglite`。该模拟只使用一个后端和简化表结构，不证明独立连接并发锁行为。另以本机一次性 PostgreSQL 16.15 容器（无网络、无映射端口、临时内存存储）和合成表测试多连接：两个初始化器串行且仅一个更新；四张表分别验证先写入提交会阻止初始化、初始化持锁时写入会等待，9 项均通过。可运行 `python3 workers/phone-auth/tests/initialization-postgres-rehearsal.py` 复验，需本地 Docker 和 PostgreSQL 16 镜像。该测试验证锁与事务行为，使用简化表结构和模拟写入，不证明完整生产 RPC、权限、约束或真实状态；初始化前仍须只读复核。上述语句不是数据库迁移，也没有在生产执行。

## DO 初始化方案（未执行）

1. 确认独立 `phone-auth` 的现有命名空间和绑定、三个开关关闭、canary 白名单及预算有效、`PHONE_AUTH_HMAC_KEY_ID=v1` 和独立管理凭据就绪。只读检查命名空间对象清单；如果已有对象或状态不明，停下调查，禁止更换对象名、清空存储或重置费用。
2. 在明确授权后，仅向 `POST /v1/phone/_admin/initialize` 发送空 JSON，使用受保护输入提供独立管理 Bearer，不将其放入参数、日志或聊天。该请求可能创建 DO；`/_admin/status` 也可能创建对象，不能用作初始化前的无副作用检查。
3. 预期初始化一次返回成功且 `schema=1`、`enabled=true`，累计和当日预留/金额为零。重复初始化返回 409，并非幂等成功；409、超时或不确定结果时停止，保留既有对象，凭授权的只读状态复核，不自动重复或删除。初始化后状态检查必须使用管理凭据并限制输出非敏感汇总。
4. 回滚边界：关闭三个功能开关并停止发送；不要删除 DO、清零费用、重建命名空间、覆盖数据库配置、轮换身份密钥或撤销已有身份映射。

## 真实短信 Canary 前的阻断和验收

- 用户须确认单条真实含费上界不超过策略的 `unitCostMicros=200000`，以及 relay 不会在内部产生超出预算的重复计费。Canary 最多三次**预留**，失败也不退；未知发送结果永久隔离号码，不自动重试。
- 确认 relay 支持 POST JSON `api_key`、`phone`、`code`、`scene`，数值 `ok=1` 表示供应商已接受发送；确认 `scene=login` 模板可用于登录、首次注册及手机号再验。2026-11-06 无密钥、无手机号的 HTTPS POST 空对象返回 401；Mock 覆盖请求协议及失败、超时和不重试，真实凭据、模板和计费尚未验证。
- 确认实际 Turnstile widget 与 Secret 配对，真实 `sunland.dev` origin、hostname 和 `phone_login` action 一致。2026-11-06 Cloudflare 只读查询确认现有非交互 widget 的公开 sitekey 已写入本 PR 登录页，允许 `sunland.dev`；Worker 配置的 hostname 为 `sunland.dev`，客户端 action 与服务端按 purpose 校验一致。仅有 Secret 绑定名称无法证明与 widget 配对，真实 origin 的 widget→Siteverify 尚未验收；公开站点内容本轮无法确认，不能假设 UI 已启用。
- 本 PR 将发送总超时调整为 20 秒，发送前生成 challenge 并保存在同标签页 sessionStorage（不含手机号或验证码）；丢失响应时禁止自动重发，重新输入相同号码可继续验证。服务端在事务中检查 challenge 冲突，发送中校验不会消耗错误次数。旧生产 Worker 不支持客户端 challenge：须先经授权部署兼容 Worker，再发布网页；本 PR 未部署。
- 仅同标签页刷新或返回可恢复；关闭标签页、清理存储、跨标签页、设备丢失，以及中转接口自身超时后的服务端隔离，均不能保证恢复。由 opener 打开的标签页可能克隆旧 sessionStorage：一页消费后另一页仍可能被旧句柄阻止；不能将非原子的 localStorage 读写当作跨页互斥，也不能按手机号公开查询 challenge。未知结果、过期后仍阻止页面重发，须人工核实供应商状态和账本；不要用清理浏览器存储绕过号码锁。验证码校验结果未知时先核实登录状态，不重新发送。模拟浏览器不等于真实 origin 的端到端验收。
- 本 PR 的登录页手机号入口默认关闭，已填入公开 Turnstile sitekey。正式验收前需确认已授权的站点、sitekey 与 Secret 配对、生产 hostname 和 action，且在明确授权后才可配置入口。账号设置页不在本 PR，绑定、换绑、再验证和删除页面尚未接入并未验收。
- 获单独授权后仅使用事先确认的唯一号码、真实 origin 和 canary 白名单，预期最多三次预留。先进行一次注册发送与校验，验证仅一次消费、身份创建和既有 JWT/状态兼容；至少等待现有 600 秒号码锁后再做同号登录。验收过程不记录号码、验证码、Token、请求体或摘要。
- 任何超时、未知供应商结果、错误计费或身份不一致立即停止并关闭开关，保留账本和隔离记录；不得清账、切换对象、自动重发或绕过预算。真实账号创建、短信费用、功能开关开启和生产初始化均需事先分别明确授权。


## 待授权的操作脚本与网页切换

以下脚本已准备但**本轮未执行**。只可在独立授权、备份恢复验证、目标与开关只读复核全部完成后使用。仅安装可信来源的 `psycopg` 3，配置受保护的 libpq `PGUSER`、`PGPASSFILE` 和 TLS 根证书；密码不放进命令行。数据库脚本固定连接本项目直连主机并要求 `sslmode=verify-full`，要求当前连接隔离级别为 `read committed`、参数日志上限为零、`log_statement=none`，不满足即拒绝，不能通过忽略错误继续。2026-11-06 只读检查得到 `log_statement=ddl`、`log_parameter_max_length=-1`、错误参数上限为 0；须先由数据库负责人确认并提供安全日志环境，本脚本不会更改数据库日志设置。认证和日志设置可能因连接角色而异，执行前须重新核对。以下输入重定向路径须为权限 600 的安全文件或受控文件描述符，文件不得有尾随换行；路径不含密钥本身：

```sh
python3 workers/phone-auth/operations/initialize-db.py --execute < /secure/path/existing-lookup-key
python3 workers/phone-auth/operations/initialize-do.py --execute initialize < /secure/path/existing-admin-token
```

数据库脚本在单事务中持锁、条件更新，只有恰好一行才提交；提交后只检查结果是否匹配，异常不输出参数或异常详情。DO 脚本固定目标、关闭重定向、只发一次请求并检查 canary 零账本。`initialize-do.py --execute status` 也会调用 DO，可能创建对象，**只可在授权后使用**，不能用于初始化前探测。任意 409、超时或连接中断均按结果未知处理，禁止自动重试。脚本操作逻辑已通过合成 Mock；数据库事务函数还使用 `psycopg` 3.3.8 在隔离 PostgreSQL 16 与简化表结构上验证了参数化提交、零行回滚和不覆盖。完整脚本尚未在真实驱动与完整生产结构的隔离环境中运行，生产使用前还需完成该项验收，不要把 PG 16 简化锁测试当作完整脚本验收。

网页切换顺序：保持三个开关关闭，先审查并获授权部署支持客户端 challenge 的独立 Worker，再检查版本与路由；随后获授权发布 PR 中的网页，检查实际 `login.html` 引用 `phone-auth.js?v=20261106-recovery-1`、站点返回正确 JavaScript MIME 和恢复逻辑，入口仍关闭，再做真实 origin 的无短信人工浏览器验证。缓存标识可防止新版 HTML 取到旧脚本，但**不能强制已打开的旧页面升级**；开启前必须验证既有页面版本及用户会话的退出或刷新策略。若存在可能发送的旧客户端，须先提供服务端拒绝旧请求的兼容切换方案或确保其已退出，不能只等 CDN 缓存过期。此顺序不是生产部署授权。

上面的隔离 PG 并发测试与初始化 SQL 的 advisory 锁、四表锁顺序和条件更新一致；它在零匹配时提交空事务，生产脚本则明确回滚。合成单元测试覆盖零匹配回滚和提交异常不重试；仍需上述真实驱动隔离验收。
