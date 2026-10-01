# 项目风险与依赖分析

> 生成时间：2026-07-05  
> 范围：静态阅读全部 Markdown 文档，并对核心 HTML / JS / CSS 做引用关系分析。  
> 说明：本文档只记录风险和结构判断，不代表已做代码修改。

## 一、哪些地方最容易出 Bug

### 1. AI 登录与 Token 刷新

相关文件：

- `login.html`
- `ai.html`
- `ai/app.js`
- `ai/account-menu.js`
- `ai/user-menu.js`
- `copilot.html`
- `ai_settings.html`

风险点：

- AI 登录使用自建 JWT，存在于 `localStorage.token` / `localStorage.user`。
- `ai/app.js`、`copilot.html` 都有刷新 token 的逻辑，容易出现实现不一致。
- `ai.html` 只检查 token 是否存在，不判断是否过期，真正刷新交给 `ai/app.js`。
- `window.session` 是前端伪造的会话对象，不是 Supabase Auth session。
- 退出登录只是清理本地 `token/user`，没有远端登出。

最容易出现的问题：

- token 过期后刷新失败，页面状态还显示已登录。
- `localStorage.user` 与 JWT payload 不一致。
- 登录后跳转目标处理错误。
- `copilot.html` 和 `ai.html` 登录态表现不一致。

### 2. AI 会话同步

相关文件：

- `ai/app.js`
- Supabase 表：`conversations`

风险点：

- 本地缓存：`localStorage["conversations_" + userId]`
- 云端存储：Supabase `conversations.data`
- 实时同步：Supabase Realtime
- 运行时状态：`conversations`、`currentId`、`history`

这些状态同时存在，且通过更新时间合并，容易出现竞态。

最容易出现的问题：

- 多端同时编辑导致旧数据覆盖新数据。
- 当前会话 `currentId` 丢失。
- `history` 和当前会话内容不同步。
- Realtime 订阅重复或未清理。
- 删除会话跨端同步不完整。

### 3. Pro / 支付 / 权益开通

相关文件：

- `ai/app.js`
- `ai_settings.html`
- `workers/afdianpay/worker.js`
- `workers/afdianpay/DEPLOY.md`

风险点：

- Pro 唯一真值源是 `user_profiles.pro`。
- 爱发电订单通过 `custom_order_id` 或 `remark` 携带 userId。
- Worker 通过 service_role key 直接写 Supabase。
- KV `ORDERS` 用于幂等，防止重复处理订单。

最容易出现的问题：

- 付款成功但没有开通 Pro。
- `custom_order_id` 丢失导致无法绑定用户。
- Worker 写库失败后如果错误记录幂等键，会导致永久漏开。
- 前端显示 Pro 状态和数据库不一致。

### 4. Supabase OAuth 捐赠登录体系

相关文件：

- `index.html`
- `donate.html`
- `oauth-callback.html`
- `p/js/supabaseClient.js`
- `p/js/authState.js`

风险点：

- 这是与 AI 登录完全独立的第二套登录体系。
- Supabase SDK 会自动把 session 写入 `sb-*-auth-token`。
- 登出时需要 `supabase.auth.signOut({ scope: 'global' })` 加手动清理本地 auth key。
- `sessionStorage.forceLoggedOut` 用于避免退出后又自动恢复登录。

最容易出现的问题：

- 看似退出，实际 Supabase session 仍被恢复。
- 首页捐赠按钮误判登录状态。
- OAuth 回调后跳错页面。

### 5. 全站 CSS 和主题

相关文件：

- `p/css/tokens.css`
- `p/css/base.css`
- `ai/styles-1.css`
- `ai/styles-2.css`
- `ai/model-menu.css`
- 各页面内联 `<style>`

风险点：

- `tokens.css` / `base.css` 被大多数页面引用。
- `.btn`、`.card`、`.modal`、`.avatar`、`#loadingBar` 都是全局选择器。
- 主站多数页面使用 `body.night`，`ai_settings.html` 同时存在 `body.dark`。
- `ai/model-menu.css` 有全局 `button` 选择器，会影响 AI 页所有按钮。

最容易出现的问题：

- 改一个公共样式，全站多个页面同时变形。
- 首页 `.avatar` 与 AI 页 `.avatar` 语义不同，样式容易串。
- `#loadingBar` 在多个页面重复定义。

## 二、哪些模块耦合最高

### 最高耦合：`ai/app.js`

`ai/app.js` 约 3400 行，职责包括：

- Service Worker 注册
- PWA 提示
- 登录态恢复
- token 刷新
- API 请求封装
- AI 对话请求
- SSE 流式渲染
- 内容审核
- 图片上传预览
- 会话列表
- 本地缓存
- 云端同步
- Realtime 订阅
- Pro 权限判断
- 支付弹窗
- 模型选择
- 头像资料同步
- UI 渲染

这是全项目最核心、最高风险、最不适合随便重构的文件。

### 高耦合：AI 页面组合

相关文件：

- `ai.html`
- `ai/app.js`
- `ai/user-menu.js`
- `ai/account-menu.js`
- `ai/styles-1.css`
- `ai/styles-2.css`
- `ai/model-menu.css`

耦合方式：

- 靠固定 DOM id 连接，如 `avatarBtn`、`userMenu`、`logoutBtn`、`settingsBtn`。
- 靠全局变量连接，如 `window.session`、`window.showLoginPrompt`。
- 样式直接依赖页面结构和 id。

### 高耦合：Pro 权益链路

相关文件：

- `ai/app.js`
- `ai_settings.html`
- `workers/afdianpay/worker.js`
- Supabase `user_profiles`

耦合方式：

- 前端支付链接必须携带正确 userId。
- Worker 必须能从订单里读出同一个 userId。
- 前端和 Worker 都默认 `user_profiles.pro` 是唯一真值源。

### 高耦合：捐赠 OAuth 链路

相关文件：

- `index.html`
- `donate.html`
- `oauth-callback.html`
- `p/js/authState.js`
- `p/js/supabaseClient.js`

耦合方式：

- 首页发起 OAuth。
- 回调页处理跳转。
- donate 页面强制登录。
- 登出逻辑依赖 `authState.js` 清理 Supabase 本地缓存。

## 三、哪些地方千万不要随便动

### 1. 外部 API 契约

不要随便改：

- `https://api.sunland.dev/send-code`
- `https://api.sunland.dev/verify-code`
- `https://api.sunland.dev/refresh`
- `https://api.sunland.dev` 根路径对话接口
- SSE 返回格式
- `x-remain` 响应头

原因：

后端不在本仓库，前端只能适配已有契约，不能假设后端能同步改。

### 2. 登录状态存储 key

不要随便改：

- `localStorage.token`
- `localStorage.user`
- `localStorage.loginReturnTo`
- `localStorage["conversations_" + userId]`
- `localStorage["xixi_profile_" + userId]`
- Supabase SDK 的 `sb-*-auth-token`

原因：

这些 key 被多个页面共享。改名会导致登录、会话、头像、跳转全部断裂。

### 3. 数据库核心结构

不要随便改：

- `user_profiles.user_id`
- `user_profiles.pro`
- `conversations.user_id`
- `conversations.data`
- `thanks`
- `thanks_likes`
- `usage`
- `request_logs`
- `comment_copilot_*`

原因：

前端、Worker、Edge Function 都直接依赖这些表和字段。

### 4. 爱发电支付绑定

不要随便改：

- `AFDIAN_PLAN_ID`
- `custom_order_id`
- `remark`
- `workers/afdianpay/worker.js` 的 KV 幂等逻辑
- Worker 只在 Supabase 写入成功后才写入 KV 的行为

原因：

这是资金到 Pro 权益的唯一自动通路。改错会重复开通或漏开通。

### 5. 登录跳转白名单

相关文件：

- `login.html`

不要删除：

- `getPostLoginTarget()` 中只允许站内 `.html` 文件名的校验。

原因：

这是开放重定向防护。

### 6. 全站公共 CSS

不要随便大改：

- `p/css/tokens.css`
- `p/css/base.css`

原因：

影响面是全站。

## 四、哪些地方有技术债

### 1. `ai/app.js` 过大

问题：

- 单文件包含太多职责。
- 状态变量多。
- DOM、API、业务逻辑混在一起。
- 修改任何小功能都可能影响登录、同步或渲染。

### 2. 登录刷新逻辑重复

重复位置：

- `ai/app.js`
- `copilot.html`
- `login.html`
- `ai_settings.html`

问题：

- token 解析、刷新、用户信息恢复逻辑不完全一致。
- 后续改认证机制时需要多处同步。

### 3. 激活码系统遗留

现状：

- 文档和注释说明激活码系统已弃用。
- `ai/app.js` 里仍保留 `activation_codes` 相关代码。

问题：

- 维护者容易误以为激活码仍是主要开通方式。
- 未来修 Pro 逻辑时容易走错路径。

### 4. 删除会话同步不清晰

现状：

- `docs/project_overview.md` 提到 `deleted_conversations`。
- 当前源码主要看到 `conversations` 合并逻辑，未看到清晰的 `deleted_conversations` 调用。

问题：

- 跨端删除可能和文档描述不一致。
- 删除语义以后大概率需要重新梳理。

### 5. 多页面重复逻辑

重复内容：

- 语言切换
- 自动夜间模式
- loadingBar
- 页面跳转淡出
- 用户提示

问题：

- 每个页面都有类似代码，修一个交互需要多处手工同步。

### 6. 全局 CSS 容易串样式

问题：

- 大量页面内联样式。
- 多个页面复用相同类名但语义不同。
- `ai/model-menu.css` 里有全局 `button` 样式。

### 7. XSS 风险点

需要重点注意：

- `donate.html` 中鸣谢墙使用 `insertAdjacentHTML` 渲染 `name/message`。
- `ai/app.js` 会把 AI 返回内容通过 `marked.parse()` 写入 `innerHTML`。
- 用户上传文件名、图片展示、AI 输出都需要注意 HTML 注入。

`copilot.html` 相对更安全，因为结果渲染主要使用 `textContent`。

### 8. 测试覆盖有限

已有测试：

- `tests/auth-state.test.mjs`
- `tests/logout-flow.test.mjs`
- `tests/ai-moderation.test.mjs`
- `tests/index-assets.test.mjs`

缺口：

- AI 登录刷新集成测试
- 会话同步测试
- 支付开通测试
- Realtime 行为测试
- UI 回归测试

## 五、哪些地方以后一定会返工

### 1. AI 登录体系与 Supabase 权限模型

原因：

- AI 使用自建 JWT。
- Supabase Auth 只服务捐赠体系。
- 部分 Supabase 表 RLS 当前关闭。
- 如果未来要加强安全，必须重做权限边界。

### 2. `ai/app.js` 模块拆分

建议未来拆成：

- `auth`
- `api`
- `chat-store`
- `cloud-sync`
- `realtime`
- `billing`
- `profile`
- `moderation`
- `ui-render`

但当前不要为了“整洁”随便大拆，风险太高。

### 3. Pro / 支付状态机

原因：

- 当前主要靠爱发电轮询和 `user_profiles.pro`。
- 缺少完整订单状态页面。
- 前端支付后靠轮询刷新体验。

以后大概率会补：

- 订单表
- 支付状态查询
- 明确的支付成功页
- 更细的失败重试与人工排查入口

### 4. CSS 设计系统收敛

原因：

- 公共 CSS 和页面内联样式混用。
- 主站、AI、设置页、下载页视觉体系并不完全统一。

以后大概率会统一：

- 主题命名
- 按钮
- 弹窗
- loading
- 表单
- Toast

### 5. 多语言和主题共享脚本

原因：

- 当前各页面复制逻辑。
- `localStorage.lang` 是共享状态，但实现分散。

以后适合抽成轻量公共脚本。

## 六、首页依赖哪些组件

首页文件：

- `index.html`

样式依赖：

- `p/css/tokens.css`
- `p/css/base.css`
- 首页内联 `<style>`

脚本依赖：

- `p/js/supabaseClient.js`

图片/资源依赖：

- `p/tx.jpeg`
- `p/ailogo.png`
- `/favicon.png`
- `/favicon-32.png`
- `/icon-192.png`
- `/apple-touch-icon.png`
- `/sitemap.xml`

首页内部组件：

- 语言切换器：`#langSwitcher`
- Splash loading：`#loading`
- 主容器：`.container`
- 头像：`.avatar`
- 打字问候语：`#greeting`
- 简介：`#introText`
- 导航按钮网格：`.buttons`
- 捐赠区：`.donate-section`
- 捐赠按钮：`#donateBtn`
- 登录弹窗：`#loginModal`
- GitHub 登录按钮：`#githubLoginBtn`
- Google 登录按钮：`#googleLoginBtn`
- 页脚：`.site-footer`
- AI 悬浮入口：`.ai-entry-group` / `#aiEntry`
- 顶部细进度条：`#loadingBar`

首页状态依赖：

- `localStorage.lang`
- `sessionStorage.skipSplash`
- `sessionStorage.loginFrom`
- `sessionStorage.returnTo`
- `sessionStorage.forceLoggedOut`
- `sessionStorage.eggAccess`
- `sessionStorage.eggTime`
- `sessionStorage.eggToken`

## 七、哪些组件共用

### 全站公共样式组件

来源：

- `p/css/tokens.css`
- `p/css/base.css`

共用组件：

- `.btn`
- `.btn-primary`
- `.btn-secondary`
- `.card`
- `.page-shell`
- `.field-input`
- `.modal`
- `.modal-content`
- `.close`
- `.lang-switcher`
- `.site-footer`
- `.spinner`
- `#loadingBar`
- `.fade-in-up`
- `body.fade-out`

### 页面结构共用

常见于：

- `shoushe.html`
- `banquan.html`
- `guanzhu.html`
- `lianxi.html`
- `comment.html`
- `fans.html`
- `ryugaku.html`
- `game.html`

共用模式：

- loading
- 语言切换
- 页面卡片
- 返回首页按钮
- 自动夜间模式
- loadingBar

### AI 共用组件

相关文件：

- `ai.html`
- `ai/app.js`
- `ai/user-menu.js`
- `ai/account-menu.js`
- `ai_settings.html`

共用内容：

- 头像资料
- 昵称
- Pro 状态
- 使用额度
- `localStorage.token`
- `localStorage.user`
- `user_profiles`

## 八、哪些 API 被多个页面调用

### 自建 AI 后端

`https://api.sunland.dev/send-code`

- `login.html`
- `ai/app.js`

`https://api.sunland.dev/verify-code`

- `login.html`
- `ai/app.js`

`https://api.sunland.dev/refresh`

- `ai/app.js`
- `copilot.html`

`https://api.sunland.dev`

- `ai/app.js`

用途：

- AI 对话主接口
- 标题生成
- SSE 流式返回

### Supabase Auth

调用位置：

- `index.html`
- `donate.html`
- `oauth-callback.html`
- `p/js/login.js`
- `p/js/checkLogin.js`

用途：

- GitHub / Google OAuth
- 捐赠页登录态
- 登出

### Supabase 表

`user_profiles`

- `ai/app.js`
- `ai_settings.html`
- `workers/afdianpay/worker.js`
- `supabase/functions/comment-copilot/index.ts`

`conversations`

- `ai/app.js`

`usage`

- `ai/app.js`
- `ai_settings.html`

`request_logs`

- `ai_settings.html`

`thanks`

- `donate.html`

`thanks_likes`

- `donate.html`

`activation_codes`

- `ai/app.js` 遗留代码

`comment_copilot_*`

- `supabase/functions/comment-copilot/index.ts`

### Supabase Edge Function

`/functions/v1/comment-copilot`

- `copilot.html`

### Cloudflare Pages Function

`/apk`

- `download.html`
- `functions/apk.js`

## 九、哪些状态共享

### localStorage

`lang`

- 首页
- 多个内容页
- 下载页

`token`

- `login.html`
- `ai.html`
- `ai/app.js`
- `ai_settings.html`
- `copilot.html`
- `vds-callback.html`

`user`

- `login.html`
- `ai/app.js`
- `ai_settings.html`
- `copilot.html`
- `vds-callback.html`

`loginReturnTo`

- `login.html`
- `copilot.html`
- `oauth-callback.html`

`conversations_${userId}`

- `ai/app.js`

`xixi_profile_${userId}`

- `ai/app.js`
- `ai_settings.html`

`hidePwaTip`

- `ai/app.js`

`highScore`

- `game.html`

`theme`

- `ai_settings.html`

### sessionStorage

`skipSplash`

- `index.html`
- `donate.html`

`forceLoggedOut`

- `index.html`
- `donate.html`

`loginFrom`

- `index.html`

`returnTo`

- `index.html`
- `oauth-callback.html`

`eggAccess`

- `index.html`
- `egg.html`

`eggTime`

- `index.html`

`eggToken`

- `index.html`

### Supabase 共享状态

`user_profiles`

- AI 头像
- 昵称
- Pro 状态
- 护福宝 Pro 判断
- Worker 支付开通

`conversations`

- AI 云端会话
- Realtime 同步

`thanks` / `thanks_likes`

- 捐赠鸣谢墙

`usage` / `request_logs`

- AI 使用额度

`comment_copilot_context`

- 护福宝多轮上下文

## 十、哪些 CSS 互相影响

### 1. `body.night`

影响范围：

- `p/css/tokens.css`
- 多个主站页面
- `ai/styles-1.css`
- `ai/styles-2.css`
- `ai/model-menu.css`

风险：

- 改夜间模式变量会影响全站。
- AI 页又有自己的夜间样式，容易与 tokens 重叠。

### 2. `#loadingBar`

影响范围：

- `p/css/base.css`
- `index.html`
- `ai.html`
- `donate.html`
- 多个内容页

风险：

- 同一个 id 在各页面重复定义。
- 有的页面用 `classList.add("active")`，有的还控制 `display`。

### 3. `.modal` / `.modal-content`

影响范围：

- `base.css`
- `index.html`
- `login.html`
- `ai/app.js` 动态创建的弹窗

风险：

- 全局弹窗样式改动会影响登录、Pro、限制提示等多个弹窗。

### 4. `.btn` / `.card`

影响范围：

- 主站内容页
- 首页
- donate 页面
- ryugaku 页面
- fans 页面

风险：

- 改按钮或卡片基础样式，会影响几乎所有静态页面。

### 5. `.avatar`

影响范围：

- `index.html`
- `ai/styles-1.css`
- `ai.html`

风险：

- 首页头像是图片。
- AI 页头像是菜单按钮。
- 同名类含义不同。

### 6. `button` 全局选择器

来源：

- `ai/model-menu.css`

风险：

- 会影响 AI 页所有按钮，不只模型按钮。

### 7. 主题命名不统一

现状：

- 主站和 AI 多数使用 `body.night`。
- `ai_settings.html` 存在 `body.dark` 相关样式。

风险：

- 设置页主题和 AI 主界面可能不同步。

## 十一、修改建议优先级

### 高优先级

1. 不要轻易动认证、支付、API 契约。
2. 修 bug 时先定位到最小函数，不要重构 `ai/app.js`。
3. 任何涉及 `donate.html` 登出流程的改动，都跑 `node --test tests/logout-flow.test.mjs`。
4. 任何涉及 `p/js/authState.js` 的改动，都跑 `node --test tests/auth-state.test.mjs`。
5. 任何涉及 AI 审核规则的改动，都跑 `node --test tests/ai-moderation.test.mjs`。

### 中优先级

1. 抽出 AI token 刷新公共逻辑。
2. 清理或明确标注 `activation_codes` 遗留代码。
3. 梳理 `deleted_conversations` 是否仍需要。
4. 为 `donate.html` 鸣谢墙渲染补 HTML 转义。
5. 给 `marked.parse()` 输出增加安全清洗策略。

### 低优先级

1. 抽公共语言切换脚本。
2. 抽公共 loadingBar 脚本。
3. 收敛主题命名。
4. 减少页面内联样式。
