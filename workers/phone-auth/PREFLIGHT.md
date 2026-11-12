# 手机认证初始化与 Canary 操作准备

本文是待审操作方案，不授权执行。本文不包含真实手机号、密钥或白名单摘要。生产数据库、DO 初始化、功能开关、真实短信、生产部署分别需要明确授权。不要对生产使用暂存 Worker：它不保证数据库隔离。

## 当前验收边界

离线备份校验、Storage 隔离提取及数据库恢复限制见 [OFFLINE-RECOVERY.md](OFFLINE-RECOVERY.md)。

2026-11-12 已在本机用新目录、新容器及新配置模拟无项目历史状态的恢复：从归档重建角色、数据库权限、Schema 和数据，完成 51 项扩展对象所有者修复；121 张表行数、19 个非系统角色、权限、RLS、扩展和触发器通过检查，78 个 Storage 对象逐个提取校验，合成初始化与重复拒绝通过。容器无网络、交换禁用，数据和日志只位于加密卷，验证后新容器及临时数据已清理。此演练没有验证其他计算机、不同架构、真实 Vault 根密钥或线上 Storage 上传，也不证明数据库与 Storage 为原子快照。

2026-11-12 恢复验证进展：生产逻辑归档已在匹配生产构建 `17.4.1.054` 的隔离 Supabase PostgreSQL 中恢复；归档中 121 张数据表行数一致。角色、扩展和触发器已核对，phone-auth 初始化脚本仅以合成值在隔离副本中完成首次执行与重复拒绝。初次恢复的 51 个扩展对象所有者及 ACL 不一致，已仅在隔离副本按生产只读元数据修正；随后核对 328 个对象、19 个角色、27 项默认权限和 97 张表的 RLS/策略一致。比较对象是核对时的生产元数据，并非对历史备份时点的完整权限快照证明。

生产 Vault 当时只读计数为零；生产 Vault 根密钥的备份与恢复能力未验证。数据库归档包含 Storage 元数据，不包含实际文件；Storage 文件须独立备份、校验和恢复，且数据库与文件备份并非原子快照。以上结果不能替代生产密钥的独立备份和恢复证明，也不授权生产初始化。

2026-11-12 已另行只读备份 Storage：两个 bucket、78 个对象共 19,030,500 字节，下载前后清单稳定；备份加密保存在本机加密卷，隔离提取并逐个校验文件大小及 SHA-256 通过，临时明文已清理。文件路径和大小与先前恢复的数据库元数据逐项一致，但这不是数据库与文件同一时点的原子快照，也未向隔离 Storage 服务实际上传恢复；备份和解密密钥仍需独立异地保管。

2026-11-12 本机身份加密密钥文件已验证 `v1` 格式，并在本机加密卷创建权限 600 的额外副本；使用合成数据验证了原文件加密、副本解密。两份仍在同一台电脑，不能抵御设备丢失；也不能证明它们与 Cloudflare 中不可读取的 Secret 一致。其余三项核心密钥尚无可验证的本地安全来源；须由密钥保管人确认独立备份及一致性，不得重新生成替代。

2026-11-12 Cloudflare 只读复核：独立 Worker 版本 `99c72944-07a3-4a92-ad37-54f5772e2bc9` 承载全部流量，三个功能开关关闭，模式为 canary，relay 地址及三个 Key ID 与配置一致，相关 Secret 名称均存在。短信策略为最多三次预留、单次预算 0.20 元、累计和每日预算均为 0.60 元；白名单非空。存在 Secret 不代表其值或白名单与备份匹配。生产 widget 允许 `sunland.dev`，但真实网页 token 与生产 Secret 配对仍需通过下方无短信探针验证；本次浏览器连接超时，不构成通过证据。

同日补充：浏览器控制接口再次超时；使用独立临时配置的本机浏览器取得了生产登录页，并检测到预期公开 sitekey，但浏览器进程未在时限内正常退出。该检查没有取得或验证 token，也不能证明生产 Secret 配对。真实探针仍需在真实网页生成一次性 token，并由管理员在本机通过隐藏输入提供现有凭据。

补充的本机顺序检查可运行 `python3 workers/phone-auth/operations/turnstile-interactive.py`：隐藏输入现有管理员凭据和真实 `sunland.dev` 页面的 `phone_login` 一次性 token，仅在合法 token 确认成功后分别测试同一 token 的重放和固定无效 token；不发送短信，不自动重试。token 必须通过受控方式从真实页面取得，不写入聊天、日志或文件。验证前后均须只读复核三个生产开关关闭：后两次 403 也可能由开关变化导致，不能单凭拒绝推断重放和无效 token 检查成功。本地模拟测试不证明生产配对。

如果暂时没有安全取得真实 token 的途径，可以先运行同一命令并加 `--admin-only`，只需隐藏输入管理员凭据，以固定无效 token 调用诊断入口一次。根据已部署入口先鉴权、后检查开关和 token 的顺序，符合预期的 403 只能说明管理员凭据被接受，不能证明真实 Turnstile 配对或其他三项核心密钥一致；失败或结果未知时停止，不重试。

本机排查发现 Python 默认 User-Agent 的合成凭据请求遭 Cloudflare 1010 拦截；为本地探针增加明确的客户端标识后，合成凭据请求到达 Worker 并得到预期 401，未发送短信。该结果不能证明此前输入的管理员凭据正确或错误，也不能证明生产 Turnstile 配对。

2026-11-06 只读核对：生产五张手机认证表 RLS 已开启，anon/authenticated 无表读写权限，service_role 对配置表无 UPDATE；手机身份 RPC 为 SECURITY INVOKER，只有 service_role 有执行权限；手机表无未验证约束。配置 singleton 尚未初始化，身份、状态、授权与操作记录表均为空；独立 DO 命名空间没有对象。两个 RPC 函数体摘要与本地迁移一致。三个功能开关均关闭。生产状态会变化，执行前须重新核对，不能凭本文的快照执行。

Secret 名称、Key ID 或白名单格式存在不证明 Secret 值正确、白名单与当前 HMAC key 匹配、或 keyring 的 `v1` 与备份一致。必须从安全保管源核对，不轮换、不输出、不将其写入 PR。数据库初始化前需具备独立可恢复的密钥备份及经完整恢复验证的备份；历史备份验证有约束失败，不能直接认定可恢复。2026-11-06 本机加密密钥备份文件的目录/文件权限已检查为 700/600；其余核心密钥未找到同等本机备份。当时仅用合成密钥验证加密、校验和解密流程；2026-11-12 的真实本机密钥副本合成数据测试见上文，仍须由保管人独立确认所有密钥的备份与恢复。

2026-11-06 已部署独立 Worker 版本 `99c72944-07a3-4a92-ad37-54f5772e2bc9`，代码对应 `dc270ec`，100% 流量；既有 Secret 名称、三个 `v1` Key ID、relay、canary 和三个关闭开关均复核通过，DO 命名空间仍无对象。关闭入口的 Pages 生产部署 `0b1faae4-528b-48fa-bc3c-dca54e41c413` 对应提交 `bef96ba`，真实 `sunland.dev/login` 返回新版登录页且手机入口关闭，包含过期请求的人工确认恢复入口；版本化客户端与语言包均返回 JavaScript 且内容摘要与提交一致。网页旧生产回滚点为 Pages 部署 `bee494e8-d0d0-48aa-92ac-74aa290f8182`，Worker 回滚点为 `9ccf310e-6009-47f2-957a-d4b785f64823`（保留旧客户端保护但无诊断入口）；更早的 `adef974d-63eb-4cdb-aeb9-dc38b6309cd4` 不包含旧客户端保护，回滚后必须保持功能关闭。生产状态会随时间变化，实际操作前重新只读检查。

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
- 确认实际 Turnstile widget 与 Secret 配对，真实 `sunland.dev` origin、hostname 和 `phone_login` action 一致。2026-11-06 Cloudflare 只读查询确认现有非交互 widget 的公开 sitekey 已写入本 PR 登录页，允许 `sunland.dev`；Worker 配置的 hostname 为 `sunland.dev`，客户端 action 与服务端按 purpose 校验一致。仅有 Secret 绑定名称无法证明与 widget 配对，真实 origin 的 widget→Siteverify 尚未验收；真实公开登录页已核对 UI 关闭，不得假设真实 widget 或生产 Secret 配对已验证。
- 独立 relay 入口拒绝不提供客户端 challenge 的旧发送请求，拒绝发生在 DO 与预算预留之前；阿里云和历史 challenge 校验保持兼容。本 PR 将发送总超时调整为 20 秒，发送前生成 challenge 并保存在同标签页 sessionStorage（不含手机号或验证码）；丢失响应时禁止自动重发，重新输入相同号码可继续验证。服务端在事务中检查 challenge 冲突，发送中校验不会消耗错误次数。兼容 Worker 和默认关闭的网页均已按上述版本部署。
- 仅同标签页刷新或返回可恢复；关闭标签页、清理存储、跨标签页、设备丢失，以及中转接口自身超时后的服务端隔离，均不能保证恢复。由 opener 打开的标签页可能克隆旧 sessionStorage：一页消费后另一页仍可能被旧句柄阻止；不能将非原子的 localStorage 读写当作跨页互斥，也不能按手机号公开查询 challenge。未知结果和过期后页面仍阻止重发；到达额外等待期后才显示“检查后继续”，用户明确确认已核实上次短信与登录结果后可清理本地句柄，服务端号码锁、隔离和预算仍然生效；不要用清理浏览器存储绕过号码锁。验证码校验结果未知时先核实登录状态，不重新发送。模拟浏览器不等于真实 origin 的端到端验收。
- 本 PR 的登录页手机号入口默认关闭，已填入公开 Turnstile sitekey。正式验收前需确认已授权的站点、sitekey 与 Secret 配对、生产 hostname 和 action，且在明确授权后才可配置入口。账号设置页不在本 PR，绑定、换绑、再验证和删除页面尚未接入并未验收。
- 获单独授权后仅使用事先确认的唯一号码、真实 origin 和 canary 白名单，预期最多三次预留。先进行一次注册发送与校验，验证仅一次消费、身份创建和既有 JWT/状态兼容；至少等待现有 600 秒号码锁后再做同号登录。验收过程不记录号码、验证码、Token、请求体或摘要。
- 任何超时、未知供应商结果、错误计费或身份不一致立即停止并关闭开关，保留账本和隔离记录；不得清账、切换对象、自动重发或绕过预算。真实账号创建、短信费用、功能开关开启和生产初始化均需事先分别明确授权。


## 待授权的操作脚本与网页切换

以下脚本已准备但**本轮未执行**。只可在独立授权、备份恢复验证、目标与开关只读复核全部完成后使用。仅安装可信来源的 `psycopg` 3，配置受保护的 libpq `PGUSER`、`PGPASSFILE` 和 TLS 根证书；密码不放进命令行。数据库脚本固定连接本项目直连主机并要求 `sslmode=verify-full`，要求当前连接隔离级别为 `read committed`；脚本仅用 `SET LOCAL` 将参数日志上限设为零，并检查 auto_explain、pgaudit，权限不足或设置不安全即拒绝，不更改全局日志设置。2026-11-06 只读权限函数未显示对参数日志的显式 SET 授权，但随后在 Supabase 管理连接中，以不含敏感参数的事务实测三个 SET LOCAL（普通日志、错误日志与 auto_explain 参数上限）均可设为 0，pgaudit 参数记录为 off、隔离级别为 read committed；ROLLBACK 后原有设置恢复，全局配置未改。权限函数的静态结果不能替代会话实测；实际初始化使用的 psycopg 直连及其角色尚未验证，脚本必须逐事务重做检查，不能绕过。本机只读网络测试发现该直连主机仅返回 IPv6 地址，而本机无法连接其 5432 端口；也可显式选择下述 Session Pooler，须先通过真实连接探测；不得关闭 TLS 校验。以下输入重定向路径须为权限 600 的安全文件或受控文件描述符，文件不得有尾随换行；路径不含密钥本身：

```sh
python3 workers/phone-auth/operations/initialize-db.py --execute < /secure/path/existing-lookup-key
python3 workers/phone-auth/operations/initialize-do.py --execute initialize < /secure/path/existing-admin-token
```

数据库脚本在单事务中持锁、条件更新，只有恰好一行才提交；提交后只检查结果是否匹配，异常不输出参数或异常详情。DO 脚本固定目标、关闭重定向、只发一次请求并检查 canary 零账本。`initialize-do.py --execute status` 也会调用 DO，可能创建对象，**只可在授权后使用**，不能用于初始化前探测。任意 409、超时或连接中断均按结果未知处理，禁止自动重试。脚本操作逻辑已通过合成 Mock；数据库事务函数还使用 `psycopg` 3.3.8 在隔离 PostgreSQL 16 与简化表结构上验证了参数化提交、零行回滚和不覆盖。真实手机认证迁移及 psycopg 已在隔离 PostgreSQL 16 和 17 完成并发、四表非空回滚、RPC 锁、RLS 和无权限拒绝验收；用户资料和删除表的合成结构已按照生产只读 catalog 对齐全部列类型、空值、默认值及约束；真实手机号迁移自身的生命周期触发器参与测试，但用户资料表另外五个生产触发器及其依赖没有复刻，仍不是完整生产 Supabase 结构或恢复验收，生产前须核对实际对象、权限和备份恢复。

网页切换顺序：保持三个开关关闭，先审查并获授权部署支持客户端 challenge 的独立 Worker，再检查版本与路由；随后获授权发布 PR 中的网页，检查实际 `login.html` 引用 `phone-auth.js?v=20261106-recovery-1`、站点返回正确 JavaScript MIME 和恢复逻辑，入口仍关闭，再做真实 origin 的无短信人工浏览器验证。缓存标识可防止新版 HTML 取到旧脚本，但**不能强制已打开的旧页面升级**；开启前必须验证既有页面版本及用户会话的退出或刷新策略。部署包含旧客户端拒绝保护的独立 Worker 后，旧 relay 客户端发送会在预留前被拒；不能只等 CDN 缓存过期，发布后仍须验证生产版本和缓存。此顺序不是生产部署授权。

上面的隔离 PG 并发测试与初始化 SQL 的 advisory 锁、四表锁顺序和条件更新一致；它在零匹配时提交空事务，生产脚本则明确回滚。合成单元测试覆盖零匹配回滚和提交异常不重试；仍需上述真实驱动隔离验收。

## 无短信 Turnstile 配对探针

独立 Worker 提供管理员诊断 `POST /v1/phone/_admin/turnstile-probe`：仅在三个功能开关均为 `false` 时，使用现有管理员认证和生产 Turnstile Secret 向固定 Siteverify 地址发一次请求；不访问 DO、数据库或短信服务。服务端只返回 `ok`，不会返回 token、Secret 或上游响应。诊断不传 `remoteip`，所以成功不能替代正式短信链路验收。

2026-11-07 已部署上述包含探针的 Worker，并核对三个开关、hostname、管理员 Secret 绑定及未经认证请求返回 401。操作前重新核对版本和配置；在真实 `https://sunland.dev` 页面使用现有 `SunlandPhoneAuth.runTurnstile('phone_login')` 获得一次性 token，通过受保护方式分别传入下列文件描述符；切勿在命令参数、日志、聊天或共享剪贴板暴露 token 或管理员凭据。示例中的路径指本机权限 600 的受保护文件，不是密钥值：

```sh
python3 workers/phone-auth/operations/turnstile-probe.py --admin-fd 3 --token-fd 4 3< /secure/admin-token 4< /secure/turnstile-token
```

输出 `verified` 表示 Siteverify 成功、hostname/action/时间窗匹配；`failed` 包括超时和未知状态，不重试。若首次已确认成功、同一个 token 未更换，且三个开关仍确认关闭，可单独以相同 FD 输入加 `--expect-replay` 验证二次拒绝；`rejected` 只证明返回拒绝，需结合首次成功与开关状态判读。不得用测试密钥代替生产配对。诊断结束后应评估移除此额外管理入口。

2026-11-07：六个 profile 触发器及七个直接依赖表已在 PGlite 使用合成数据进行关联测试，函数与列目录摘要及 RLS 开关经只读 catalog 对照；这是单后端测试，不是完整生产 Schema、ACL、PostgreSQL 并发或备份恢复证明。用户已确认本项目 IPv4 Session Pooler 的主机、端口和用户名；真实 CA、会话身份、日志设置与锁仍需在实际连接上验证。

2026-11-07：GitHub Actions `Phone auth isolated PostgreSQL acceptance` 使用临时 PostgreSQL 17 与 psycopg，在同一隔离实例完成手机认证迁移、六个直接相关触发器、七张重建依赖表、并发初始化、RPC 锁、非空拒绝、RLS 和会话日志保护验收；只使用仓库中的已审查结构 fixture 和合成数据。运行记录：`https://github.com/ikun-1145/xixi/actions/runs/42308802804`。该验收仍不等同完整生产 Schema、全部 ACL/扩展或真实备份恢复。Session Pooler 实际连接的 TLS、身份、日志及锁行为仍未验证，隔离测试不替代真实连接验收。

2026-11-07：初始化脚本增加显式 `--check-session-pooler` 只读探测与 `--execute --session-pooler` 可选路径，固定用户确认的项目主机、5432、数据库和用户名，强制 `verify-full`、核对后端身份并在读取密钥前验证日志保护。探测使用两个只读事务、随机 advisory 锁及四张表的非等待 ACCESS SHARE 锁，事务结束回滚；不能代替隔离环境对初始化强锁的验收。Pooler 会话模式仍需结合实际连接信息确认，后端 PID 连续性检查单独不足以证明池模式。本机已从 Supabase 官方控制台源码所使用的证书地址获取根证书；受保护的 PostgreSQL passfile 仍不可用，真实 psycopg 连接未成功验证。

通过安全渠道安装项目可信 CA，并以 libpq 标准格式准备当前用户所有、权限 600 的 `PGPASSFILE`；不得输出文件内容。配置 `PGSSLROOTCERT` 指向 CA 文件，避免设置 `PGPASSWORD`、`PGSERVICE`、`PGSERVICEFILE` 和 `PGOPTIONS`，然后在受控环境运行 `python3 workers/phone-auth/operations/initialize-db.py --check-session-pooler`。此探测不会读取身份密钥或初始化；失败时不降级 TLS。即使探测通过，生产初始化仍须独立满足真实密钥备份恢复、完整隔离验收与现有前置条件。

2026-11-07：Supabase 官方控制台历史源码中 SSL 下载地址为 `https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt`（[源码](https://github.com/supabase/supabase/blob/436bdb10aeae3d1c10a145f859fe151b45474b51/apps/studio/components/interfaces/Settings/Database/SSLConfiguration.tsx#L188)）。经 HTTPS 下载的 Supabase Root 2021 CA 有效期至 2031-04-26；使用该 CA 和 Pooler 原始主机名的 OpenSSL PostgreSQL TLS 握手证书链与 hostname 校验通过，错误 hostname 被拒绝。本机 libpq 使用 `verify-full` 亦完成 TLS 握手，在无密码时停止，未执行 SQL。证书保存在 `~/Library/Application Support/xixi-phone-auth/supabase-root-2021.crt`；仍须使用受保护的真实凭据运行 `--check-session-pooler`，验证 psycopg 登录、后端身份、日志与双连接锁；本次握手不能证明这些条件。

2026-11-10：使用本机受保护的 passfile、官方 CA 和 psycopg 3，经实际 Session Pooler 以 `verify-full` 完成双连接探测：身份、安全日志、随机 advisory 锁、ACCESS SHARE 表锁及回滚均通过。首次探测暴露了 psycopg 属性名错误，修复后重试通过。本次未读取身份密钥或初始化数据库；真实备份恢复、完整生产结构隔离验收等其余前置条件仍须单独满足。
