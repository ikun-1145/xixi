# 手机认证初始化与 Canary 操作准备

本文是待审操作方案，不授权执行。本文不包含真实手机号、密钥或白名单摘要。生产数据库、DO 初始化、功能开关、真实短信、生产部署分别需要明确授权。不要对生产使用暂存 Worker：它不保证数据库隔离。

## 当前验收边界

2026-11-06 只读核对：生产五张手机认证表 RLS 已开启，anon/authenticated 无表读写权限，service_role 对配置表无 UPDATE；手机身份 RPC 为 SECURITY INVOKER，只有 service_role 有执行权限；手机表无未验证约束。配置 singleton 尚未初始化，身份、状态、授权与操作记录表均为空；独立 DO 命名空间没有对象。两个 RPC 函数体摘要与本地迁移一致。三个功能开关均关闭。生产状态会变化，执行前须重新核对，不能凭本文的快照执行。

Secret 名称、Key ID 或白名单格式存在不证明 Secret 值正确、白名单与当前 HMAC key 匹配、或 keyring 的 `v1` 与备份一致。必须从安全保管源核对，不轮换、不输出、不将其写入 PR。数据库初始化前需具备独立可恢复的密钥备份及经完整恢复验证的备份；历史备份验证有约束失败，不能直接认定可恢复。

生产版本 `adef974d-63eb-4cdb-aeb9-dc38b6309cd4` 以 xixi 本地 `bb0dca1` 的独立构建部署；本轮只读取回当前生产模块并计算 SHA-256，与该提交从原检出位置重建的 bundle 均为 `4686354414700d421873a33d469bc527582015c7c0fea13f4f48d16519de8382`。本 PR 的独立 Worker 运行时代码与该提交相同，后续修正仅涉及测试。不同检出目录的本地构建只有源码路径注释不同，因此原始 bundle 摘要不同；去除这些路径注释后已确认构建文本一致。

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

使用合成数据的本地 PGlite PostgreSQL 模拟已验证：首次条件更新成功；重复执行、已有身份/状态/授权/操作记录及半配置状态均拒绝，字段不被覆盖。可用 `PHONE_PREFLIGHT_PACKAGE_ROOT=/path/to/local/package node --test workers/phone-auth/tests/initialization-rehearsal.mjs` 复验；该目录须已有 `@electric-sql/pglite`。该模拟只使用一个后端和简化表结构，**不证明独立连接并发锁行为**；当前 Docker 守护进程不可用，生产执行前需要在隔离的真实 PostgreSQL 多连接环境完成并发验证。上述语句不是数据库迁移，也没有在生产执行。

## DO 初始化方案（未执行）

1. 确认独立 `phone-auth` 的现有命名空间和绑定、三个开关关闭、canary 白名单及预算有效、`PHONE_AUTH_HMAC_KEY_ID=v1` 和独立管理凭据就绪。只读检查命名空间对象清单；如果已有对象或状态不明，停下调查，禁止更换对象名、清空存储或重置费用。
2. 在明确授权后，仅向 `POST /v1/phone/_admin/initialize` 发送空 JSON，使用受保护输入提供独立管理 Bearer，不将其放入参数、日志或聊天。该请求可能创建 DO；`/_admin/status` 也可能创建对象，不能用作初始化前的无副作用检查。
3. 预期初始化一次返回成功且 `schema=1`、`enabled=true`，累计和当日预留/金额为零。重复初始化返回 409，并非幂等成功；409、超时或不确定结果时停止，保留既有对象，凭授权的只读状态复核，不自动重复或删除。初始化后状态检查必须使用管理凭据并限制输出非敏感汇总。
4. 回滚边界：关闭三个功能开关并停止发送；不要删除 DO、清零费用、重建命名空间、覆盖数据库配置、轮换身份密钥或撤销已有身份映射。

## 真实短信 Canary 前的阻断和验收

- 用户须确认单条真实含费上界不超过策略的 `unitCostMicros=200000`，以及 relay 不会在内部产生超出预算的重复计费。Canary 最多三次**预留**，失败也不退；未知发送结果永久隔离号码，不自动重试。
- 确认 relay 支持 POST JSON `api_key`、`phone`、`code`、`scene`，数值 `ok=1` 表示供应商已接受发送；确认 `scene=login` 模板可用于登录、首次注册及手机号再验。只有 HTTPS 401 空请求与 Mock 已验证，真实凭据和模板尚未验证。
- 确认实际 Turnstile widget 与 Secret 配对，真实 `sunland.dev` origin、hostname 和 `phone_login` action 一致。本地网页 sitekey 为空，公开入口与受控浏览器方案仍须核实；不得假设公开 UI 已启用。
- 本地网页 `p/js/phone-auth.js` 的默认请求总超时为 12 秒；服务端顺序等待 Turnstile 最多 5 秒及 relay 最多 8 秒，可能造成短信已发但客户端丢失 challenge。该网页客户端不在本 PR 中，需单独修复并验证真实端到端路径后再进行 Canary；不得只延长超时或以自动补发掩盖未知结果。
- 获单独授权后仅使用事先确认的唯一号码、真实 origin 和 canary 白名单，预期最多三次预留。先进行一次注册发送与校验，验证仅一次消费、身份创建和既有 JWT/状态兼容；至少等待现有 600 秒号码锁后再做同号登录。验收过程不记录号码、验证码、Token、请求体或摘要。
- 任何超时、未知供应商结果、错误计费或身份不一致立即停止并关闭开关，保留账本和隔离记录；不得清账、切换对象、自动重发或绕过预算。真实账号创建、短信费用、功能开关开启和生产初始化均需事先分别明确授权。
