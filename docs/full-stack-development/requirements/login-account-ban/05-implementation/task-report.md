# 实施与代码审查报告

## 实施结果

- `ai/database-token-client.js` 增加一次性 `exchange(appToken, expectedUserId)`，不读取或写入登录会话缓存，并继续校验数据库 JWT 的用户、角色、受众和过期时间。
- `ai/login-ban-status.js` 使用一次性数据 Token 和 publishable key，只读查询 RLS 限定的当前用户资料；管理员原因按纯文本规范化。
- `login.html` 在持久化新会话前完成封禁检查；封禁时清理残留登录缓存、阻止跳转并显示原因；状态不可读时保守拒绝；重复点击由单次请求锁抑制。
- 系统提示已补齐简中、繁中、英、日、韩、西六种语言；验证码成功响应不再把完整 Token 数据写入控制台。

## 需求变更实施结果（2026-09-06）

- `ai/app.js` 首次资料读取增加 `is_banned` / `ban_reason`，并使用当前 `user_id` 过滤的 `postgres_changes` 订阅监听 `user_profiles`。
- 订阅使用现有短期数据库 JWT，订阅失败时沿用资料同步和页面重新聚焦作为兜底；账号切换会移除旧频道。
- 检测到封禁后清理本地会话并锁定页面，使用安全 DOM 显示全屏警告、纯文本理由和 `mailto:support@sunland.dev`。
- 新增六语言文案、缓存版本号和回归断言；未修改 schema、RLS、JWT、验证码接口或外部服务。

## 自审结论

未发现阻断项。检查了跨用户 Token、失败放行、Token 提前落盘、重复提交、XSS、开放重定向、API 格式、RLS 权限扩大和秘密泄露；本次没有 schema、RLS、路由、验证码请求体或响应格式变化。

外部限制：浏览器拿到 `/verify-code` 成功响应后才执行资料检查，因此会拦截正常网页登录，但不能提供不可绕过的系统级授权保证。`api.sunland.dev` 必须在服务端 Token 签发、刷新、数据库 Token 和业务 API 路径同步拒绝封禁用户。
