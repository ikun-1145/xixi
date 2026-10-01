# 最终验收报告

## 自动化检查

- 聚焦测试：`node --test tests/ai-database-token.test.mjs tests/ai-login-ban-status.test.mjs tests/ai-login-flow.test.mjs tests/site-i18n.test.mjs`，23/23 通过。
- 完整测试：`npm test`，217/217 通过。
- JavaScript 语法：`ai/database-token-client.js`、`ai/login-ban-status.js` 通过 `node --check`。
- 配置与格式：`00-stage.json` 可解析；`git diff --check` 通过；无 TODO/FIXME/占位实现。

## 浏览器与在线只读检查

- 桌面 1280×720：登录卡片 420px 宽、完整居中，无横向溢出。
- 移动 390×844：卡片约 354px 宽，左右保留约 18px，表单完整可见，无横向溢出。
- 两个视口均成功加载新增同源脚本，浏览器控制台无 error/warn。
- 生产只读契约：无凭据调用 `/v1/database-token` 返回 401；publishable key 以匿名身份读取 `user_profiles` 返回 401，符合仅认证用户读取自己资料的 RLS/GRANT 边界。

## 需求变更验证（2026-09-06）

- 聚焦测试：`node --test tests/ai-database-token.test.mjs tests/ai-login-ban-status.test.mjs tests/ai-login-flow.test.mjs tests/ai-refresh-recovery.test.mjs tests/site-i18n.test.mjs`，35/35 通过。
- 完整测试：`npm test`，289/289 通过。
- 全屏提示 DOM smoke check 通过：封禁理由作为文本节点显示，恶意 HTML 不会变成元素或事件属性，申诉链接为 `mailto:support@sunland.dev`。
- `git diff --check`、相关 JavaScript 语法检查通过；未新增依赖。

## 未验证项与发布结论

未使用真实验证码、真实封禁账号或生产用户数据，因此没有宣称真实封禁账号端到端、Supabase Realtime publication 已启用、已有会话踢出、Flutter 客户端或外部 API 服务端封禁已验证。

结论：`有条件可发布`。本仓库的登录前封禁检查、ai.html 实时监听实现和失败兜底均通过自动化验证；上线前应使用测试账号确认 `user_profiles` 已加入 Realtime publication，并由 `api.sunland.dev` 在 Token 签发、刷新和业务 API 路径同步执行封禁规则。
