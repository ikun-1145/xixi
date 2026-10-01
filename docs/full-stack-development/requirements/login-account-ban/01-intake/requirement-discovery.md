# 登录封号机制需求契约

## 原始需求与目标

在 `login.html` 的邮箱验证码登录流程中读取 `public.user_profiles.is_banned` 与 `ban_reason`。封禁用户不得建立本地登录会话，并通过弹窗看到封禁说明。

成功标准：正常用户保持原登录行为；封禁用户不会写入 `localStorage.token/user`、不会跳转到业务页；账号状态无法可信读取时不允许本次登录。

## 范围与非目标

- 范围：`login.html` 新登录流程、现有短期数据库 Token 客户端、封禁状态只读查询、六语言系统提示和回归测试。
- 不修改：Supabase schema、RLS、已有列、验证码 API 请求/响应格式、JWT 格式、路由白名单和其他客户端。
- 外部边界：`api.sunland.dev` 源码不在本仓库。网页拦截不能替代服务端在 Token 签发、刷新和业务 API 层的权威封禁校验。

## 信息、交互与状态

1. 用户提交邮箱与六位验证码。
2. `/verify-code` 成功返回应用 Token 和用户身份。
3. 页面在持久化 Token 之前，用应用 Token 向已有 `/v1/database-token` 换取短期 Supabase 数据 Token。
4. 使用数据 Token 和现有 RLS，只读查询当前用户自己的 `is_banned, ban_reason`。
5. `is_banned = true`：清理可能残留的本地登录缓存，保留登录页，显示封禁弹窗；原因为空时显示联系管理员的默认说明。
6. 未封禁或资料行不存在：继续原有的 Token/用户缓存与站内白名单跳转。
7. 数据 Token、RLS 查询、网络或响应格式异常：显示“暂时无法确认账号状态”，不建立会话，允许用户重试。

加载态为“正在检查账号状态...”。封禁原因作为管理员内容原样显示，但清理控制字符并限制为 500 字符；使用原生文本弹窗，不使用 HTML 渲染，避免 XSS。

## 数据与 API 契约

- 表：`public.user_profiles`；主键 `user_id text`；读取 `is_banned boolean not null default false`、`ban_reason text nullable`。
- RLS：仅 `authenticated` 可 `SELECT`，策略要求数据库 JWT 的 `id` claim 等于 `user_id`。
- 现有接口：`POST https://api.sunland.dev/v1/database-token`，`Authorization: Bearer <application-token>`；返回短期 `authenticated` 数据 JWT。
- Data API：`GET /rest/v1/user_profiles?select=is_banned,ban_reason&user_id=eq.<id>&limit=1`，携带 publishable key 与数据 JWT。
- 不在日志中输出应用 Token、数据 Token、完整登录响应或用户资料。

## 前端与工程契约

- 保持原生 HTML/JavaScript，无新依赖。
- 复用 `ai/database-token-client.js`，新增不依赖 `localStorage.token` 的一次性交换入口；常规已登录缓存行为不变。
- 封禁检查发生在首次 `localStorage.setItem("token", data.token)` 之前。
- 新增用户可见文案覆盖简中、繁中、英、日、韩、西六种语言。

## 风险与验收

主要风险是封禁检查失效时误放行、跨用户 Token 混用、检查前写入会话、将管理员原因当 HTML 渲染，以及误把前端提示当作服务端权限控制。

验收要求：

- 自动化覆盖已封禁、未封禁、资料缺失、查询失败、跨用户/无效数据 Token。
- 静态断言封禁检查早于 Token 持久化。
- 运行相关测试、完整 `npm test` 与 `git diff --check`。
- 在桌面与移动视口验证登录页可用，并记录无法在无测试账号条件下完成的真实封禁账号端到端缺口。

## 调研结论

Supabase 当前官方方案支持通过 `accessToken`/Bearer 自定义 JWT 访问 Data API，并用 `auth.jwt()` claim 实施 RLS。Supabase Auth 自身的成熟实现会在凭据验证、OTP 验证及已有 Access Token 请求等服务端路径统一调用 `IsBanned()`；本次网页实现沿用“先权威验证、再建立会话、失败不落盘”的顺序，但服务端全链路仍属于外部系统责任。
