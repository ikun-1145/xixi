# 独立 phone-auth Turnstile 防重放补丁

本补丁从生产版本标记的提交 `dc270ec68c8be07925b57f638bf800236bd2fa02` 出发，只修改独立 `phone-auth` 的协调器和管理员诊断入口，附带相关测试。生产版本 `99c72944-07a3-4a92-ad37-54f5772e2bc9` 在检查时承载全部流量；版本注释指向上述提交，但注释不是源代码逐字节校验证明。本文件不授权部署、初始化或启用生产功能。

## 已确认的问题

生产管理员诊断入口直接调用 Siteverify，不查询协调器；用户提供的截图显示同一个真实 token 首次和约 6 秒后的第二次诊断均返回成功。该诊断要求管理员凭据和三个功能开关关闭，不能直接发送短信。截图不能证明上游原因；源码中未发现项目级 Siteverify 结果缓存，但不能据此排除 Cloudflare 内部行为。旧版正常发送链也依赖 Siteverify 即时拒绝重复 token，存在跨号码重复预留的风险。三个生产开关检查时均关闭，且无实际短信发送证据。

## 补丁与默认行为

- 发送和诊断共享现有协调器中的原子 token HMAC 摘要登记；有效期至少 340 秒，失败或超时不释放，不存 token 明文。重复请求仍计入限流，不增加短信预算。Siteverify 请求显式 `cache: no-store`。
- 管理员诊断新增 `PHONE_TURNSTILE_DIAGNOSTICS_ENABLED` 显式门控：缺失或非字符串 `true` 时返回 503，**不访问或创建 DO**。检查时生产环境无此变量；由于 `keep_vars` 会保留线上变量，实际发布前须重新确认其缺失或为 `false`。
- 将来只有获得独立授权、DO 账本已初始化且三个功能开关均关闭时，才可考虑设置该诊断变量为 `true`。诊断先鉴权，检查现有账本和单调时钟，再写 token 摘要；账本缺失时不会写标记或妨碍随后初始化。即使空账本不被写入，访问 DO 仍可能创建对象，因此生产初始化获授权前禁止启用或调用它。
- 生产三个开关 `PHONE_SMS_ENABLED`、`PHONE_IDENTITY_ENABLED`、`PHONE_NEW_REGISTRATION_ENABLED` 必须保持 `false`，模式保持 `canary`。本次没有修改 Wrangler 配置、绑定、路由或迁移，也不包含网页、邮箱 OTP、数据库或主 `ai` Worker 的修改。

## 隔离验收

仅本地合成数据，所有出站请求由 Mock 拦截；未访问生产短信、数据库或 DO。

2026-11-12：上述 Node 针对性测试 33 项通过，两项 workerd/SQLite 验收通过；仓库 `npm test` 904 项通过。standalone 构建通过，并核对生成配置中三个功能开关关闭、诊断变量未启用、`keep_vars=true`、Worker 名称及原路由/DO 绑定。生成的 bundle SHA-256：`a6ec21ce6c91e323115438eea3e4c7bf7b4beff96132ec424e40245caa95eaba`；此摘要只识别本地构建结果，不是部署记录。

```sh
node --test workers/phone-auth/tests/turnstile-probe.test.mjs tests/phone-release-policy.test.mjs workers/phone-auth/tests/relay.test.mjs
SUNLAND_AUTH_WORKER_ROOT=/Users/liuxize/sunland_ai_app/worker node workers/phone-auth/tests/turnstile-probe-workerd.mjs
SUNLAND_AUTH_WORKER_ROOT=/Users/liuxize/sunland_ai_app/worker node workers/phone-auth/tests/relay-workerd.mjs
```

覆盖首次通过、顺序及并发重复、诊断与发送交叉重放、无效和过期 token、失败不释放、重启、账号未初始化、开关默认关闭、正常发送、预算和供应商切换。底层 Siteverify Mock 刻意允许重复，证明拒绝来自本地原子状态，不是 Mock 的上游去重。实际站点与供应商行为不因这些模拟测试自动通过。

## 获授权后的部署与回滚边界

1. 仅准备并发布独立 Worker `phone-auth`，不发布整个 PR #36 或主 Worker。使用项目现有 standalone 构建脚本，校验锁定的主 Worker helper 来源；部署前逐项核对生产版本、路由、DO 绑定/迁移、全部变量及 Secret 名称。`keep_vars` 不代表可以忽略配置覆盖或版本差异；禁止传入或覆盖密钥值。
2. 生产诊断门控必须缺失或为 `false`，三个手机号开关保持 `false`。部署和健康检查均不得调用初始化、状态或诊断接口，不得产生 DO 对象或短信。
3. 旧版已验证的 token 在新状态中没有标记。Worker 版本 100% 并不保证活跃 DO 已切换：Cloudflare 默认允许延迟更新。先关闭入口并确认无在途操作；部署时明确记录 DO 更新策略。若选择 `immediate`，活跃对象会重启并可能中断在途操作；若选择延迟，须等待其实际配置的最长延迟。确认所有旧 DO 代码不再运行且新版本 **100% 生效后**，仍须保持三个开关和诊断关闭至少 340 秒；此等待不授权后续初始化、启用或真实短信。期间检查版本与非 DO 健康路径。
4. 若必须回滚，先关闭并确认三个功能开关及诊断门控，停止流量，至少等待 340 秒；保留 DO 命名空间、账本、Secret 和数据库。回滚目标为原生产版本 `99c72944-07a3-4a92-ad37-54f5772e2bc9`，但旧版重新暴露管理员诊断重放风险；应在单独授权下先阻断该诊断路径或使用保留诊断关闭的应急版本。回滚会改变生产部署，必须另获授权并重新核对版本绑定，不得清账或猜测 Secret。
