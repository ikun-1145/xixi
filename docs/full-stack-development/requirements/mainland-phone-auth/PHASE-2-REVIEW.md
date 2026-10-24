# Phase 2 审查与验证记录

日期：2026-10-24。所有写入仅本地，未用 Docker。实现所有权分开：主 Agent 负责 crypto/构建/集成，backend-guardian 分别负责 SQL 与路由；QA、架构及 security Agent 只读独立复核。A Team roster 校验通过，未重新初始化。现有 main 和唯一 worktree 足以安全完成，按仓库规则未创建临时分支或 worktree。

## 架构决策

1. 扩展现有 profile，而非迁移 Supabase Auth；新增私有映射和单事务 RPC，不复制用户/权益数据。
2. HMAC 唯一索引 + AES-GCM 密文，lookup 永久 canary 关闭错误轮换；加密 keyring 与 lookup 轮换分开。
3. recent grant 绑定当前因子、会话和版本；保留原 JWT 普通访问语义，不引入 AV claim。仅旧 JWT 不能直接变更敏感因子。
4. deleting 保留唯一占用；retired 在原清理 milestone/lease/fence 核验后释放。恢复 TTL 仅用于清理任务续作。
5. 在内存构建中挂接真正的原 Worker，固定源码 hash；不使用落后部署包、不改原邮箱实现。

对照成熟开源实现：[Supabase auth OTP](https://github.com/supabase/auth/blob/master/internal/api/otp.go) 与 [auth 配置/接口说明](https://github.com/supabase/auth/blob/master/README.md)。参考其 OTP 与数据库事务、安全重认证分离的做法，不移植其 Session/用户模型。对号码回收风险采用明确限制，不宣称 SMS 自身能辨别号码新旧持有人。

## 独立发现及处置

| 级别 | 问题 | 修复与回归 |
| --- | --- | --- |
| P1 | 注销授权重试缓存旧 job，却生成新 token | token_hash 纳入操作 fingerprint，第二次请求冲突，绝不返回无效成功凭证 |
| P1 | 历史 NULL/NULL onboarding 手机登录失败 | 新登录/缓存都按原规则返回 1/3，合法状态严格校验，不回写 profile |
| P2 | 操作记录保留旧邮箱，退休未擦除 | 新登录 receipt 不存 email/onboarding；缓存读当前 profile；retired 清用户历史 receipt，已解绑用户同样清 |
| P2 | 非 v4 操作 ID 在短信消费后才拒绝 | 路由在 SMS 前严格 v4 校验；challenge UUID 兼容 Phase1 |
| P2 | 缺失应用签名配置可能先消耗码/创建用户 | verify-code 与 email reauth 在消费前检查现有 signingSecret |
| P2 | 首版 canonical proof 正则误拒绝合法末位 | 修为 16 种合法末位集合；32字节随机编码遍历16种末位回归 |
| 契约 | 响应 schema/502 上游协议错误遗漏 | OpenAPI 补齐成功/错误 JSON schema、502、v4、掩码及状态限制；真实 Worker 集成逐响应校验 |

上述新增缺陷均有先失败再通过的回归证据。最终 code-reviewer/QA 与 security-reviewer 未发现当前变更中有证据的 P1/P2 阻断项。未使用不可用的工具门禁冒充完成：full-stack 生命周期 MCP/quality-gate 命令在本环境未提供，采用书面契约、实际命令和独立审查记录；不表示已通过生产发布门禁。

## 最终验证

- `npm test`：960 tests，960 pass，0 fail，0 skip。
- `node --test tests/phone-identity-db.test.mjs`：20 pass，0 fail；真实 PostgreSQL WASM SQL、约束/RLS权限、触发器、异常回滚及排队竞争。
- `node --test tests/phone-worker-build.test.mjs tests/phone-worker-integration.test.mjs`：10 pass，0 fail；构建真实原 Worker，验证源变化拒绝与 fetch 全链路。
- `node --experimental-test-coverage --test-coverage-include='workers/phone-auth/*.js' --test tests/phone-auth-provider.test.mjs tests/phone-auth-service.test.mjs tests/phone-auth-routes.test.mjs tests/phone-identity.test.mjs`：72 pass，0 fail；98.22% lines、89.27% branches、90.99% functions。此覆盖统计仅包含原模块路径，不把编译 bundle 重复计入；构建 entry 另有执行测试。
- 原始 `sunland_ai_app/worker` 的 `auth-input-validation`、`account-identity`、`email-otp`、`onboarding` 四组：66 pass，0 fail。
- `python3 scripts/roster.py verify`：9 agents、15 skills 的有效逻辑 roster；node 语法检查、`git diff --check` 通过。
- 本轮未修改 Skill/TOML；用户已有 MCP TOML 改动及备份不触碰、不提交。
- 新增 PGlite 0.5.11 无新增 audit 告警；现有依赖的 3 项告警未擅自升级修复。

测试使用严格网络拦截；阿里云、Turnstile、Supabase REST/OTP 均 Mock，数据库身份 RPC 在进程内实际执行 SQL。不是纯 Mock 数据库，也不是生产 PostgreSQL 验收。PGlite 的单后端排队不证明独立连接下的锁竞争/死锁，合成基础表不含生产所有业务触发器。原 DO 事务存储为测试替身，没有真实 workerd/Cloudflare 持久化验收。

## 发布判断

本地实现通过当前检查，可进入 Phase 3 前端与 Mock 集成。生产发布结论：**不可直接发布/执行生产迁移**。需要单独授权并完成隔离完整 schema 演练、多连接 PostgreSQL、真实 DO/预算恢复、key/canary 初始化、真实供应商/成本及端到端注销验收。没有任何真实短信、费用、数据库迁移、云资源变更、部署或远程 push。
