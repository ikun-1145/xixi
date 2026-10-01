# 项目全局说明（长期记忆文档）

> 本文件用于让任何接手本项目的人（人类或 AI）在 5 分钟内建立起对整个仓库的完整认知。
> 内容基于 2026-07-05 对仓库的完整阅读整理，之后如有重大结构调整，请同步更新本文件。

---

## 一、项目简介

**霜蓝的个人主页 / 霜蓝 AI**（域名 `sunland.dev`，认证/通用 AI API 域名 `api.sunland.dev`，Symbolic Core API 域名 `ai-core.sunland.dev`）是一个：

- 面向国内网络环境优化、可直接部署到 **Cloudflare Pages / GitHub Pages** 的**纯静态个人主页**（`index.html` 及一系列子页面）；
- 内嵌一个功能完整的 **AI 聊天助手子应用**（`ai.html` + `ai/app.js`，PWA 化，可"添加到主屏幕"）；
- 附带若干独立的小工具/子站：捐赠鸣谢墙（`donate.html`）、评论区 AI 嘴替"护福宝"（`copilot.html`）、终端风格彩蛋叙事页（`egg.html` / `deep.html`）、留学规划页（`ryugaku.html`）、小游戏（`game.html`）等。

项目的本质是 **"一个人维护的、长期迭代的个人站 + 轻量 SaaS（AI 助手 + 会员付费）"**，不是团队协作的标准工程化项目，因此：

- 没有构建工具、没有打包流程，**每个 `.html` 都可以直接双击/直接部署访问**；
- 没有 `package.json`，JS 依赖靠 `<script src="https://cdn...">` 或 ESM CDN（`import ... from 'https://esm.sh/...'`、`https://cdn.jsdelivr.net/...`）直接引入；
- 唯一的"工程化"部分是 `tests/`（Node 内置 `node:test`，用 `node --test tests/*.mjs` 跑，专门做正则/静态断言，不是单元测试框架）。

⚠️ **本仓库不是完整系统**。认证与通用 AI 网关 `api.sunland.dev`（`/send-code` `/verify-code` `/refresh` `/` 等接口）和运行 Symbolic Core 的 `ai-core.sunland.dev`（`/v1/*`）都在仓库外独立部署；Symbolic Core 与其 Cloudflare Worker 的源码已迁移至独立的 `sunland-ai` 仓库。配套的 Android/Flutter 客户端 `ikun-1145/sunland-ai-dart` 也是独立仓库（本仓库的 `functions/apk.js` 只是给它做下载代理）。修改本仓库代码时如涉及这些外部接口，只能"适配契约"，不能假设能同步改后端。

---

## 二、技术栈

| 层 | 技术 |
|---|---|
| 前端页面 | 原生 HTML + CSS + JavaScript（无框架，无构建），大量内联 `<script>`/`<style>` |
| 前端模块化部分 | 少量 ES Module（`type="module"`），如 `p/js/supabaseClient.js`、`ai/app.js` |
| 设计系统 | `p/css/tokens.css`（CSS 变量：颜色/间距/圆角/阴影/动效）+ `p/css/base.css`（通用组件样式），日/夜模式通过 `body.night` 类切换变量 |
| 国际化 | `p/js/site-i18n.js` 统一读取首页写入的 `localStorage.lang`，支持简体中文、繁体中文、英语、日语、韩语、西班牙语并同步 `<html lang>`；各公开页面直接复用，无外部运行依赖 |
| 认证与数据库（站内功能） | **Supabase**（Postgres + Auth + Realtime + Edge Functions + Storage），项目名 `Sunland Project`，project ref `klyrasrqgxijwrxuoevj` |
| 认证与后端（AI 助手） | `api.sunland.dev` 负责邮箱验证码、自定义 JWT 与通用 AI 网关；`ai-core.sunland.dev` 负责服务端 Symbolic Core（源码位于独立 `sunland-ai` 仓库）。两者均不在本仓库 |
| 人机验证 | GeeTest v4（`static.geetest.com/v4/gt4.js`），用于发送邮箱验证码前的验证 |
| Serverless 函数 | Cloudflare Pages Functions（`functions/apk.js`，APK 下载代理）、Cloudflare Worker（`workers/afdianpay/worker.js`，爱发电支付对账）、Supabase Edge Functions（`supabase/functions/comment-copilot/`，评论 AI 嘴替；另有若干只存在于 Supabase 云端、本仓库未同步源码的函数，见"数据库"一节） |
| 支付 | 爱发电（afdian.com）一次性打赏 + Cron 轮询对账 → 写 Supabase 开通 Pro |
| CI | GitHub Actions（`.github/workflows/keepalive.yml`，每 6 小时 ping 一次 Supabase 防止免费实例休眠） |
| 第三方评论组件 | giscus（基于 GitHub Discussions 的评论挂件，`comment.html`） |
| PWA | `manifest.json` + `sw.js`（Service Worker，供 `ai.html` 独立安装为 App） |
| 测试 | Node.js 内置 `node:test` + `node:assert`，跑法：`node --test tests/*.test.mjs` |

---

## 三、目录结构

```
xixi/
├── index.html              # 网站首页（个人主页入口，日夜模式/多语言/彩蛋入口/AI入口）
├── shoushe.html             # 兽设介绍
├── banquan.html             # 版权信息
├── guanzhu.html             # 关注我（社交链接）
├── lianxi.html              # 联系方式
├── comment.html             # 评论留言页（giscus 挂件）
├── fans.html                # 实时粉丝数展示（当前为手动更新的静态数字）
├── game.html                # 小游戏（本地 highScore 存 localStorage）
├── ryugaku.html             # "Project 2028" 留学规划静态页
├── donate.html              # 捐赠支持页：登录墙 + 爱发电下单 + 鸣谢墙(thanks 表)+ 点赞
├── egg.html / deep.html      # 头像连点 7 次触发的彩蛋叙事页，终端风格 UI
├── login.html               # 霜蓝 AI 的登录页（邮箱验证码 + GeeTest，非 Supabase）
├── ai.html                  # 霜蓝 AI 聊天应用外壳（PWA 入口）
├── ai_settings.html          # 霜蓝 AI 设置页（账号/用量/Pro会员/爱发电支付入口）
├── copilot.html             # "护福宝" 评论区 AI 嘴替（独立小工具，调用 comment-copilot 云函数）
├── download.html            # AI App 下载/介绍落地页
├── oauth-callback.html      # Supabase OAuth（GitHub/Google）登录回调页
├── vds-callback.html        # 备用/历史登录方式回调页（VDS，当前未在 UI 中暴露入口）
├── privacy.html / xukexieyi.html / banquan.html  # 隐私政策/用户协议/版权
├── manifest.json / sw.js     # PWA 配置与 Service Worker（服务于 ai.html）
├── favicon.png / *.svg /*.png/... 位于根目录及 p/ 下  # 站点静态资源
│
├── ai/                       # 霜蓝 AI 前端逻辑（核心，非常大）
│   ├── app.js                 # ⭐核心文件：聊天、鉴权、流式SSE、云同步、Pro校验、审核等全部逻辑（约3400行）
│   ├── furry-events.js         # 兽聚查询领域逻辑：范围解析、Supabase 查询、天气富化、跨端消息与 AI 上下文
│   ├── furry-event-cards.js    # 兽聚结果卡片的安全 DOM 渲染（与 Flutter 共享 isFurryCard/furryEvents 格式）
│   ├── account-menu.js         # 设置/退出登录 菜单绑定
│   ├── user-menu.js             # 头像下拉菜单交互
│   ├── styles-1.css / styles-2.css / model-menu.css  # ai.html 专用样式
│
├── p/                         # 公共资源与公共脚本（"page assets"）
│   ├── css/tokens.css          # ⭐全站设计变量（唯一色板/间距/圆角来源）
│   ├── css/base.css             # ⭐全站通用组件样式（按钮/卡片/弹窗/loading条等）
│   ├── js/supabaseClient.js      # ⭐Supabase 客户端单例（URL + anon key）
│   ├── js/authState.js           # 清理 Supabase 本地会话残留 key 的工具函数（有单测）
│   ├── js/site-i18n.js            # ⭐全站六语言共享文案运行时（读取 localStorage.lang）
│   ├── js/site-i18n-extra.js      # 繁中/韩/西静态语言包（运行时不联网）
│   ├── flags/                     # 语言菜单使用的本地国旗 SVG 与许可证
│   ├── js/checkLogin.js          # 旧版"未登录则弹确认框跳登录"逻辑（donate 类页面使用模式的雏形）
│   ├── js/login.js                # 通用 GitHub 登录/登出封装（部分页面使用）
│   ├── js/terminal-core.js        # 彩蛋页(egg.html/deep.html)用的仿 Linux 终端模拟器
│   └── 各类图片/图标资源（头像、二维码、社交图标等）
│
├── functions/
│   └── apk.js                 # Cloudflare Pages Function：代理 GitHub Releases 里的 APK 下载（国内加速）
│
├── workers/afdianpay/
│   ├── worker.js               # Cloudflare Worker：定时轮询爱发电订单 → 写 Supabase user_profiles.pro=true
│   ├── wrangler.toml            # Worker 部署配置（cron、KV 幂等表绑定、非敏感变量）
│   └── DEPLOY.md                # 部署手册
│
├── supabase/functions/comment-copilot/
│   ├── index.ts                 # "护福宝"评论 AI 嘴替 Edge Function（OpenAI 兼容接口 + 每日限额 + 语气档位）
│   ├── internet_context.ts       # 给 AI 提供的知识背景拼接
│   └── slang-dictionary.json     # 网络黑话/梗词典（增强 AI 对评论的理解）
│
├── tests/                     # 轻量静态断言测试（node:test，跑法 node --test tests/*.test.mjs）
│   ├── ai-moderation.test.mjs    # 抽取 app.js 里的审核函数做单测
│   ├── auth-state.test.mjs        # 测试 authState.js 的清理逻辑
│   ├── index-assets.test.mjs      # 断言 index.html 引用的图片资源真实存在
│   ├── site-i18n.test.mjs         # 断言公开页面继承首页语言、动态 UI、语言菜单与六语言切换
│   └── logout-flow.test.mjs        # 断言 donate.html 的登出流程包含关键调用（防回归）
│
├── .github/workflows/keepalive.yml  # 定时 ping Supabase，防止免费额度实例休眠
├── CLAUDE.md / AGENTS.md      # ⭐AI 协作规则（两份内容一致，分别给 Claude Code / 通用 Agent 用）
├── Readme.md                  # 面向"下载本模板自用"的用户的说明文档
├── MEMORY.md / CHANGELOG.md   # 目前为空文件（占位，未使用）
└── docs/project_overview.md   # 本文件
```

---

## 四、页面组成（按功能分组）

1. **个人主页壳**：`index.html` 是唯一真正的首页，其余站内页面都从它的导航栏进入，风格统一（`tokens.css` + `base.css`）。首页玻璃胶囊下拉菜单将 `zh` / `zh-Hant` / `en` / `ja` / `ko` / `es` 写入 `localStorage.lang`，所有公开页面通过 `p/js/site-i18n.js` 自动继承该选择并同步 `<html lang>`；页面还共享日夜自动主题、顶部 loading 条，首页另有 Supabase OAuth 登录弹窗（GitHub/Google，仅用于"捐赠支持"这一支付/鸣谢体系）。
2. **内容型静态页**：`shoushe.html`（兽设）、`banquan.html`（版权）、`guanzhu.html`（社交链接）、`lianxi.html`（联系）、`comment.html`（giscus 评论）、`fans.html`（粉丝数，纯静态展示，需要手动改数字和时间）、`ryugaku.html`（留学规划）、`game.html`（小游戏）——彼此独立，几乎不产生数据流，改动风险很低。
3. **捐赠 / 鸣谢体系**：`donate.html`——站内唯一使用 **Supabase Auth（GitHub/Google OAuth）** 的业务页。登录后可发起爱发电打赏、在 `thanks` 表留言并可对留言点赞（`thanks_likes` 去重表）。退出登录逻辑被 `tests/logout-flow.test.mjs` 显式保护，修改需格外小心。
4. **彩蛋叙事**：`egg.html`/`deep.html`——通过在首页头像连续点击 7 次进入，纯前端叙事 + `terminal-core.js` 模拟终端交互，无后端依赖，可视为"可忽略"的娱乐彩蛋。
5. **霜蓝 AI 子应用**（本项目最重要、最复杂的部分）：
   - `login.html`：邮箱验证码登录（GeeTest 人机验证 + `api.sunland.dev` 后端），登录成功后把自定义 JWT 存入 `localStorage.token`；
   - `ai.html` + `ai/app.js`：聊天主界面。职责包括：登录态恢复与静默刷新、会话列表本地+云端（Supabase `conversations` 表）双向同步、Supabase Realtime 订阅头像/会话变化、流式 SSE 渲染回复、内容审核（关键词+模型双重）、Pro 会员判断与限流、图片上传预览、PWA 安装引导等；
   - `ai_settings.html`：账号信息、今日用量、Pro 会员状态与爱发电升级入口；
   - `ai/account-menu.js`、`ai/user-menu.js`：头像下拉菜单/设置跳转/退出登录的胶水代码；
   - `oauth-callback.html`：**注意**——这是 Supabase OAuth（GitHub/Google）的回调页，只服务于 `donate.html` 的登录场景，和 AI 助手的邮箱验证码登录是两套完全独立的账号体系；
   - `vds-callback.html`：历史遗留的第三方登录回调（当前 UI 无入口，`_routes.json` 里被排除，视为"可忽略"但暂不要物理删除）。
6. **护福宝**：`copilot.html`——独立的"评论区 AI 嘴替"小工具，直接调用 Supabase Edge Function `comment-copilot`（非流式包一层内部走 SSE 聚合），与 `ai.html` 的对话系统互不共享状态，但共用同一个 `api.sunland.dev` 的 token 体系做鉴权（`/refresh`）与每日用量限制。
7. **下载页**：`download.html`——AI App（Flutter 客户端 `sunland-ai-dart`）的营销/下载引导页，实际下载由 `functions/apk.js`（Cloudflare Pages Function）代理 GitHub Releases。

---

## 五、数据流

存在**两条完全独立、互不相通的账号与数据体系**，这是本项目最容易踩坑的地方，务必分清楚：

### 数据流 A：个人主页 / 捐赠鸣谢（Supabase Auth 体系）
```
用户 → index.html/donate.html
     → Supabase Auth（GitHub/Google OAuth，oauth-callback.html 接回调）
     → session 存在 Supabase SDK 自己的 localStorage(sb-*-auth-token)
     → donate.html 直接用 supabase-js 的 `supabase.from('thanks')...` 读写鸣谢墙
     → 点赞走 `thanks_likes` 表（按 user_id + thanks_id 去重）
     → 爱发电下单（remark/custom_order_id 携带 supabase user.id）
     → workers/afdianpay/worker.js 定时轮询爱发电订单 → 直接 REST 写 Supabase
       `user_profiles` 表 `pro=true`（用 service_role key，绕过 RLS）
```

### 数据流 B：霜蓝 AI 助手（自建 Token 体系，非 Supabase Auth）
```
用户 → login.html（邮箱+验证码，GeeTest 人机验证）
     → 请求 api.sunland.dev/send-code、/verify-code（不在本仓库）
     → 拿到自定义 JWT，存 localStorage.token / localStorage.user
     → ai.html 加载时用 localStorage.token 判定登录态（checkLogin）
       - token 过期：apiFetch() 内部自动调 /refresh 静默续期
       - refresh 失败 或 401：清空 token，弹出登录框
     → DeepSeek 对话：apiFetch() POST 到 api.sunland.dev（带 Authorization: Bearer token）
       返回 SSE 流，前端边收边渲染（Markdown + 高亮 + 深度思考折叠块）
     → Sunland 对话：SunlandProvider POST 到 ai-core.sunland.dev/v1/turns
       Symbolic Core 只在远端 Worker 内运行，网页不再下载或执行 Core Bundle
     → 会话数据：本地 localStorage("conversations_"+userId) 作为缓存
       + Supabase `conversations` 表（user_id 主键，data 为 jsonb）做云端持久化
       （前端用 anon key 直接读写该表，RLS 当前处于关闭状态，见"数据库"一节的安全提示）
     → 删除的会话记录在 `deleted_conversations` 表，用于跨端同步删除状态
     → 用户资料（头像、昵称、Pro 状态）落在 `user_profiles` 表，
       前端通过 Supabase Realtime 订阅该表变化，实现头像/会员状态跨端秒同步
     → 兽聚查询：网页与 Flutter 均读取 `furry_events`，结果以
       `isFurryCard + furryEvents` 消息写入同一会话 JSON，实现跨端卡片恢复；
       网页端发送模型前再转换为只读结构化上下文，Sunland AI 走原生领域响应
     → 每日免费用量：前端有本地轻量限频 + `usage`/`usage_logs`/`request_logs` 表配合（后端为主，前端只是体验优化）
```

### 数据流 C：护福宝 comment-copilot
```
用户 → copilot.html → 复用数据流 B 的 token（调用 api.sunland.dev/refresh 保活）
     → 直接 fetch Supabase Edge Function `comment-copilot`（走 `${SUPABASE_URL}/functions/v1/comment-copilot`）
     → Edge Function 内部：读取 comment_copilot_secrets/config（模型key/限额配置）
       → 组装 SYSTEM_PROMPT + internet_context.ts 知识块 + slang-dictionary.json
       → 调用 OpenAI 兼容接口（PackyCode 等第三方转发），用 stream:true 聚合后一次性返回
       → 用量写 comment_copilot_usage，多轮上下文写 comment_copilot_context（滑动窗口 transcript）
```

---

## 六、API 一览

### A. 外部自建后端 `api.sunland.dev`（**不在本仓库**，仅描述前端已知契约，改动需谨慎兼容）
| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/send-code` | 发送邮箱验证码（body: email, GeeTest token） |
| POST | `/verify-code` | 校验验证码并签发自定义 JWT（body: email, code） |
| POST | `/refresh` | 用旧 token 换新 token（Header: Authorization Bearer） |
| POST | `/`（根路径） | DeepSeek 对话接口，SSE 流式返回；剩余次数在响应头 |

### B. 外部 Symbolic Core `ai-core.sunland.dev`（源码位于独立 `sunland-ai` 仓库）
| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/v1/turns` | Sunland AI 对话；网页只传递已认证轮次，不加载 Core Bundle |
| POST | `/v1/migrations/local-state` | 一次性迁移旧版浏览器本地 Symbolic Core 状态 |

### C. Supabase Edge Functions（云端已部署，仅 `comment-copilot` 源码同步在本仓库）
| 函数名 | verify_jwt | 说明 |
|---|---|---|
| `comment-copilot` | false | 护福宝评论 AI 嘴替（源码在本仓库 `supabase/functions/comment-copilot/`） |
| `bright-worker` (`send-code.ts`) | true | 疑似另一套发送验证码逻辑（源码未同步到本仓库，命名与 `api.sunland.dev/send-code` 关系待确认，**不要假设一致**） |
| `refill-codes` | false | 激活码补充/重置（配合 `activation_codes` 表） |
| `fetch-furry-events` / `furry-event-search` / `weather-furry` / `debug-furry-schema` | 各异 | 与 `furry_events` 表相关的数据抓取、维护与调试；`ai.html` 当前只读查询表，不直接触发这些写入型函数 |

### D. Cloudflare 侧
| 位置 | 用途 |
|---|---|
| `functions/apk.js`（Pages Function） | `GET` 代理最新 GitHub Release 的 `.apk` 文件下载 |
| `workers/afdianpay/worker.js`（Worker，独立部署） | `scheduled`（cron */2min）轮询爱发电 `query-order`；`fetch` 提供 `/test` 手动触发口 |

### E. 第三方
- GeeTest v4（人机验证）
- 爱发电 open API `query-order`（对账）
- giscus（评论组件，基于 GitHub Discussions）
- GitHub Releases API（APK 下载源）

---

## 七、数据库（Supabase Postgres，project ref `klyrasrqgxijwrxuoevj`）

核心表（`public` schema）：

| 表 | 作用 | RLS |
|---|---|---|
| `user_profiles` | ⭐用户资料主表（头像、昵称、pro 会员标记），`users` 表已废弃并被触发器拦截写入，一切以此表为准 | 开启 |
| `conversations` | AI 助手会话云端存储（`user_id` 主键 + `data` jsonb） | **关闭**（前端匿名 key 可直接读写全表，安全建议见下） |
| `deleted_conversations` | 记录已删除的会话，做跨端同步 | 开启 |
| `activation_codes` | 激活码兑换记录 | **关闭** |
| `messages` | 疑似旧版消息表（仅 1 行数据，很可能是废弃/实验产物） | **关闭** |
| `usage` / `usage_logs` / `request_logs` | 用量与限流统计 | `usage` **关闭**，其余开启 |
| `thanks` / `thanks_likes` | 捐赠鸣谢墙内容与点赞去重 | 开启 |
| `orders` | 支付订单记录（当前 0 行，可能未启用或已被 afdianpay worker 的 KV 幂等表取代） | 开启 |
| `profiles` | 疑似早期版本的会员表（`is_pro` 字段），当前 0 行，很可能已被 `user_profiles.pro` 取代 | 开启 |
| `email_codes` | 邮箱验证码记录（当前 0 行，可能由外部 `api.sunland.dev` 后端直接操作，或由未同步源码的 `bright-worker` 使用） | 开启 |
| `furry_events` | 福瑞展会信息缓存；`ai.html` 与 Flutter 客户端只读查询并把结果卡片写入共享会话 | 开启（公开只读策略） |
| `comment_copilot_usage` / `comment_copilot_context` / `comment_copilot_config` / `comment_copilot_secrets` | 护福宝功能的用量、多轮上下文、限额配置、密钥存储 | 开启 |
| `public.public` | 无实际数据的空表，疑似脚手架残留 | 开启 |

> ⚠️ **已知安全隐患（Supabase Advisor 报告）**：`conversations`、`activation_codes`、`messages`、`usage` 四张表 **RLS 未开启**，anon key 可无限制读写整表。这是历史遗留问题，**不要在不了解影响面的情况下擅自开启 RLS**（会直接导致前端匿名读写逻辑失效），如需修复必须先设计好对应的 RLS 策略（例如 `user_id = auth.uid()` 或按 token 校验的策略），并与前端读写逻辑一起验证后再上线。

---

## 八、登录流程

**本项目有两套完全独立的登录体系，务必先判断用户当前在哪个体系下，再动手改代码。**

### 体系 A：Supabase OAuth（仅用于 `donate.html` 捐赠鸣谢）
1. 用户在 `index.html` 点击"捐赠支持" → 未登录则弹出登录弹窗（GitHub / Google 两个 OAuth 按钮）；
2. `supabase.auth.signInWithOAuth({ provider, options:{ redirectTo: origin + '/oauth-callback.html' }})`；
3. `oauth-callback.html` 接住回调，Supabase SDK 自动把 session 写入其自身管理的 `localStorage`（key 形如 `sb-<ref>-auth-token`）；
4. 之后各页面用 `supabase.auth.getSession()` 判断登录态；
5. 登出：`supabase.auth.signOut({ scope: 'global' })` + 手动调用 `clearSupabaseAuthStorage(localStorage)`（`p/js/authState.js`）清理残留 key，防止"看起来登出了但本地缓存还在"的 bug（`tests/logout-flow.test.mjs` 专门断言这个流程）。

### 体系 B：邮箱验证码 + 自定义 JWT（`ai.html` 霜蓝 AI）
1. 未登录访问 `ai.html` → 页面顶部内联脚本检测 `localStorage.token` 不存在 → `location.replace('login.html')`；
2. `login.html` 显示邮箱输入框，点击发送验证码前先跑一次 GeeTest v4 人机验证，验证通过后携带 `token`（GeeTest 结果）调用 `api.sunland.dev/send-code`；
3. 用户输入 6 位验证码，调用 `api.sunland.dev/verify-code`，成功后拿到 `{ token, user }`，写入 `localStorage.token` / `localStorage.user`；
4. 跳回 `ai.html`（或 URL 参数 `?return=xxx.html` 指定的站内页面，`getPostLoginTarget()` 做了白名单校验防 Open Redirect）；
5. `ai/app.js` 的 `checkLogin()` 解析本地 token（必要时解 JWT payload 兜底取 user.id/email）、渲染用户态、拉取云端 profile 与会话；
6. 每次向 `api.sunland.dev` 发请求都走统一封装 `apiFetch()`：先判断 JWT `exp` 是否临近过期，过期则先调 `/refresh` 换新 token 再发实际请求；若请求返回 401 会**再重试一次刷新**，仍失败才清空本地登录态并弹出登录框（避免"因为一次网络抖动就把用户误登出"）。
7. 退出登录：`ai/account-menu.js` 里的 `logoutBtn` 直接清空 `localStorage.token/user` 并 `location.reload()`（这里没有调用远端登出接口，纯前端状态清除）。

> 两套体系目前**共享同一个 Supabase 项目**做数据存储（`conversations`、`user_profiles` 等表都用**体系 B 的 user.id 当作字符串主键**，而不是 Supabase Auth 的 `auth.uid()`），这也是为什么这些表的 RLS 目前是关闭状态——如果开启标准的 `auth.uid()` RLS 策略，会与体系 B 完全不兼容，修复时需要特别设计。

---

## 九、权限设计

- **未登录游客**：可浏览所有静态内容页、可用 `ai.html`（会被登录墙拦截，见上）、不能捐赠/留言/点赞。
- **已登录普通用户**（体系 B）：可对话（每日限次，前端显示"今日剩余 N 次"，真正限流在后端）、可用护福宝（同样有每日限额 `comment_copilot_usage`）、会话云同步、可申请激活码/升级 Pro。
- **Pro 会员**：`user_profiles.pro = true`。开通途径二选一：① 爱发电打赏，由 `workers/afdianpay/worker.js` 定时对账自动开通（**永久 Pro**，一次性买断）；② 激活码兑换（`activation_codes` 表，`used_by`/`used_at` 标记核销，Edge Function `refill-codes` 负责补充/管理码池）。前端 `updateModelUI()` / `showProModelModal()` / `showProRequiredModal()` 等函数根据 `isActivated` 状态控制"能否使用 Pro 模型（DeepSeek V4 Pro）"。
- **管理员/后台**：本仓库内**没有管理后台页面**，一切管理操作（发放激活码、核对支付、调整限额 `comment_copilot_config`/`comment_copilot_secrets`）都是直接在 Supabase 控制台或数据库里手工/脚本完成，权限边界依赖 Supabase 项目的 dashboard 账号本身，不在应用层。
- **RLS 现状**：见"数据库"一节的安全提示，部分表当前对 `anon` 角色完全开放读写，这是**应用层权限设计尚未补齐**的部分，日后若要收紧，必须结合体系 B 的自定义 token（而非 Supabase Auth）重新设计校验方式（例如在 Edge Function 里校验 `x-sunland-token` 之类的自定义 Header，`comment-copilot/index.ts` 的 CORS 头里已经预留了 `x-sunland-token`）。

---

## 十、哪些代码最重要（改动前必须理解）

1. **`ai/app.js`**（≈3400 行）—— 全项目最核心、风险最高的文件。囊括：登录态恢复与刷新、`apiFetch` 统一请求封装、会话增删改查与云同步（`syncFromCloud`/`syncToCloud`）、Supabase Realtime 订阅（`setupRealtimeSync`/`startRealtime`）、SSE 流式渲染、内容审核（`checkInputModeration`，有专门单测）、Pro/激活码校验（`checkActivation`）、UI 状态机（`renderUserCore`/`scheduleRenderUser` 的版本号防抖机制）。**任何"登录状态错乱""消息丢失""重复请求"类 bug 大概率根源在这里**，修改前务必通读相关函数，理解 `restoreVersion`/`checkLoginPromise` 这套防竞态机制。
2. **`p/js/site-i18n.js`**：全站公开页面的共享多语言运行时。`localStorage.lang` 是与首页一致的唯一语言选择，支持值固定为 `zh` / `zh-Hant` / `en` / `ja` / `ko` / `es`；聊天正文、用户内容和外部活动数据被刻意排除，动态系统 UI 通过安全翻译入口处理。`site-i18n-extra.js` 提供新增三语言的静态词库，页面运行时不调用翻译服务。
3. **`p/js/supabaseClient.js`**：全站唯一的 Supabase 客户端来源，`SUPABASE_URL`/`anon key` 硬编码于此（anon key 本身可以公开，属预期设计，但不要误当作敏感信息删除或替换成 service_role key）。
4. **`p/js/authState.js`**：登出清理逻辑，有单测保护，改动需同步跑 `tests/auth-state.test.mjs`。
5. **`donate.html` 中的登出/鸣谢/支付相关脚本**：被 `tests/logout-flow.test.mjs` 显式断言，涉及真实资金流程（爱发电），是**高风险区**。
6. **`workers/afdianpay/worker.js`**：直接操作 Supabase `user_profiles.pro`，用 service_role key 绕过 RLS，是**唯一的资金→权益写入通路**，改动必须保证幂等逻辑（`ORDERS` KV）不被破坏，否则可能重复开通或漏开通 Pro。
7. **`supabase/functions/comment-copilot/index.ts`**：护福宝的核心 Prompt 与业务逻辑，涉及内容安全红线设计，改动 Prompt 需谨慎评估越界风险。
8. **`p/css/tokens.css` / `p/css/base.css`**：全站唯一设计变量与通用组件来源，几乎所有页面依赖它俩，改这两个文件影响面 = 全站，务必小范围验证。
9. **`login.html` 顶部的 `getPostLoginTarget()`**：一个小函数但承担开放重定向（Open Redirect）防护职责，删除白名单校验会引入安全漏洞。
10. **`ai/furry-events.js` / `ai/furry-event-cards.js`**：兽聚查询、跨端卡片消息与模型上下文转换入口。持久化字段必须继续兼容 Flutter 的 `isFurryCard` / `furryEvents`，外部活动数据只能通过安全 DOM 和只读模型上下文使用。

## 十一、哪些代码可以暂时不用看（低优先级 / 影响面小）

1. **纯展示型静态页**：`shoushe.html`、`banquan.html`、`guanzhu.html`、`lianxi.html`、`fans.html`、`ryugaku.html`、`game.html`、`privacy.html`、`xukexieyi.html`——彼此独立、无后端交互（或只有前端本地存储），改坏了也不会影响登录/支付等核心链路。
2. **彩蛋页**：`egg.html`、`deep.html`、`p/js/terminal-core.js`——纯娱乐叙事，不接后端，除非明确要改彩蛋内容，否则可以完全跳过。
3. **`vds-callback.html`**：历史遗留、当前 UI 无入口、已被 `_routes.json` 排除，除非要彻底清理遗留代码，否则不用管。
4. **`p/js/checkLogin.js` / `p/js/login.js`**：早期/局部页面使用的简化登录封装，功能已被 `ai/app.js` 内的更完整逻辑事实上取代，除非确认某个具体页面还在引用它们，否则优先级低。
5. **根目录下的验证类文件**：`baidu_verify_codeva-*.html`、`BingSiteAuth.xml`、`robots.txt`、`sitemap.xml`、`manifest.json` 之外的一些 SEO/站长验证文件——纯配置，几乎不需要改动。
6. **`4f8a17418a1342f697de74888858a94a.txt`、`boot.txt`、`爱发电API 文档.pdf`**：疑似第三方站长验证文件/参考资料，与业务逻辑无关。
7. **`public.public`、`profiles`、`orders`、`messages`、`email_codes` 等数据库表**：当前几乎无数据、无前端调用痕迹，大概率是废弃或实验性产物，改数据库结构前应先确认这些表是否真的可以安全忽略/清理，而不是想当然直接删。
8. **网页端未直接调用的 Supabase Edge Functions**（`fetch-furry-events`、`furry-event-search`、`weather-furry`、`debug-furry-schema`、`bright-worker`）：部分负责兽聚数据维护或服务外部客户端；网页只读查询 `furry_events`，不要在普通 UI 改动中触发其写入/刷新路径。

---

## 十二、整体结构图

```
                                ┌─────────────────────────────┐
                                │         用户浏览器             │
                                └───────────────┬───────────────┘
                                                │
                ┌───────────────────────────────┼────────────────────────────────┐
                │                               │                                │
        ① 个人主页静态页群                ② 捐赠/鸣谢页              ③ 霜蓝 AI 子应用
   index/shoushe/banquan/guanzhu/           donate.html                ai.html / login.html
   lianxi/comment/fans/game/ryugaku            │                        ai_settings.html
   egg/deep (彩蛋)                              │                        copilot.html (护福宝)
                │                               │                                │
                │                        ┌──────┴───────┐                ┌──────┴────────────────┐
                │                        │ Supabase Auth │                │ api.sunland.dev        │
                │                        │ (GitHub/Google)│               │ 登录/刷新 + DeepSeek 对话│
                │                        └──────┬───────┘                └──────┬────────────────┘
                │                               ▼                                │
                │                        thanks / thanks_likes                   │
                │                               ▲                                ▼
                │                               │                    conversations / user_profiles
                │                        爱发电打赏 → workers/afdianpay/worker.js（Cron 对账）
                │                               │                    Supabase Realtime（头像/会话同步）
                │                               ▼                                │
                │                    user_profiles.pro = true ◄──────────────────┘
                │                                                                 │
                │                                                                 ▼
                │                                                Supabase Edge Function
                │                                                 comment-copilot（护福宝）
                │                                                    │
                └───────────────────────────────────────────────────┘
                                                │
                                     Supabase Postgres（唯一数据库）
                              conversations / user_profiles / thanks / thanks_likes /
                              activation_codes / usage* / comment_copilot_* / furry_events

外部关联（不在本仓库）：
  - api.sunland.dev              —— 邮箱验证码、自建 JWT 与通用 AI 网关
  - ai-core.sunland.dev          —— 服务端 Symbolic Core API（源码在独立 sunland-ai 仓库）
  - ikun-1145/sunland-ai-dart    —— 配套的 Flutter 客户端仓库（functions/apk.js 为其做下载代理）
```

---

## 十三、开发规范（摘要，完整规则见 `CLAUDE.md` / `AGENTS.md`）

- **首要目标是正确性与稳定性**，不做无谓重构，不引入新框架/新依赖。
- **高危区域**（改动前必须仔细阅读相关全部调用点）：登录状态、会话持久化（localStorage/token）、API 请求响应结构、表单与用户输入校验、路由跳转、跨域请求。
- 修改公共文件（`tokens.css`/`base.css`/`supabaseClient.js`/`app.js`）前，先搜索全仓库确认所有引用点，评估影响面。
- 涉及支付/会员开通逻辑（`workers/afdianpay/worker.js`）的改动，必须保证幂等性，禁止假设"重试无副作用"。
- 所有面向用户的界面文案都应提供简体中文、繁体中文、英语、日语、韩语、西班牙语版本，并复用 `p/js/site-i18n.js`、`p/js/site-i18n-extra.js` 与首页的 `localStorage.lang`；代码注释可沿用现有中文注释风格。
- 改完后如涉及以下文件，请顺手跑一下测试：`node --test tests/*.test.mjs`（覆盖登出流程、审核规则、资源存在性、authState 清理逻辑）。
- 本文件（`docs/project_overview.md`）应作为长期记忆维护：一旦项目出现新的核心模块、废弃旧模块、更换认证体系等重大变化，请同步更新对应章节。
