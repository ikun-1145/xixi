# 需求变更：AI 页面实时封禁检测

## 变更内容

在已有登录前封禁检查之外，`ai.html` 登录后继续监听当前 `user_profiles` 行的封禁状态。检测到 `is_banned = true` 时立即阻断页面交互并显示全屏警告、封禁原因和申诉邮箱 `support@sunland.dev`。

## 影响范围

- 前端状态：新增当前账号封禁状态与 Realtime 订阅生命周期。
- UI：新增不可关闭的全屏 `alertdialog`；封禁原因只用 `textContent` 渲染并限制长度。
- 数据/API：只读复用现有自定义数据库 JWT、`user_profiles` RLS 和 `postgres_changes`；不改 schema、RLS、JWT、验证码接口或业务 API。
- 兜底：现有用户资料低频同步和页面重新聚焦流程继续读取封禁字段。

## 验收标准

1. 正常用户的登录、资料加载、会话同步和现有 Realtime/轮询行为不变。
2. 已登录用户被设置为封禁后，收到当前用户行的更新事件即可出现全屏提示。
3. 全屏提示包含警告、管理员提供的封禁理由和可点击的 `mailto:support@sunland.dev`；无理由时显示默认文案。
4. 封禁原因按纯文本安全渲染，不执行 HTML、脚本或控制字符。
5. 账号切换、订阅失败、重复事件不会误显示其他用户理由或创建多个遮罩。
6. 运行相关测试、完整 `npm test`、`git diff --check`；不宣称真实封禁账号端到端验证。

## 设计决策

使用现有 `supabaseData` 客户端和短期数据库 JWT，在 `user_profiles` 上订阅当前 `user_id` 的 `*` 事件。保留已有资料查询作为首屏检查和 60 秒/重新聚焦兜底，因为 Realtime 需要项目 publication 配置且网络连接可能中断；前端提示不替代 `api.sunland.dev` 服务端封禁校验。
