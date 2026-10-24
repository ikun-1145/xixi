# Phase 3A 实施契约

用户已明确批准网站增量接入、Docker隔离PostgreSQL验收、本地测试与提交；无生产写/发布/短信/Flutter。flowProfile strict-fullstack，沿用既有UI，不另行重设计或引入组件库。A Team名单保持不变：architect映射、backend-guardian负责隔离SQL与认证设置页、主Agent负责共享client/登录、QA/security最终只读审查；不启用名单中未激活的frontend specialist，不重复初始化。

1. 先验收Docker Engine/CLI/现有容器，创建唯一隔离postgres，无宿主端口、不改已有8容器。scripts/test-phone-postgres.mjs + fixtures复现最小已审计结构、原删除迁移和手机号迁移，真实独立psql连接观察锁等待；升级、唯一/FK、原子操作、回滚、租约/释放及RLS/claims权限验证。完整现网schema未保存的部分明确列缺口。首轮真实13/13已通过后进入前端代码。
2. p/js/phone-auth.js：固定API客户端，复用JWT存储，显式起始refresh/敏感阶段exact token fence，无自动敏感写重试；所有请求超时/异常脱敏；内存cooldown、Turnstile按用途/缺sitekey关闭、原邮箱GeeTest验证。tests/phone-web-client.test.mjs先RED。沿用OpenAPI，不添加后端端点。
3. login.html：轻量邮箱/手机切换，复用同一个normalize/ban检查/原localStorage token+user/站内返回路径；取消/换mode/账户变化隔离旧请求。新增phone标签、+86、tel/6位code、服务端cooldown/expiry、防重复、无障碍与内存临时状态；不改邮箱协议。
4. ai_settings.html + ai/phone-settings.js + p/css/phone-auth.css：独立映射状态card和敏感操作dialog，邮箱或当前phone近期认证→bind/change；unbind仅邮箱+明确确认，无可用邮箱禁用。原ensureSettingsIdentity确认账号，原资料/Pro加载不变；任何token变化清proof/challenge/OTP。完整号码只由用户输入，不从掩码还原，不持久化。tests/phone-settings.test.mjs负责DOM回归。
5. p/js/site-i18n-extra.js补新增六语言，主验收中/英/日；显式SiteI18n translate支持ignored区域与动态倒计时。深浅/night/dark/移动320/390/桌面1280视觉与键盘检查。
6. tests/phone-web-login.test.mjs + scripts/test-phone-web-browser.mjs：JSDOM请求/倒计时/会话竞态和真实Edge Playwright，全网拦截、只本机静态服务器，Mock API/provider，无真实账号/发送。浏览器测login/settings/三语言/主题/viewport/网络失败；原Worker构建集成与全套npm test回归。
7. 独立code/experience/API/security/database审查，修复并复验。交付PHASE-3A-DELIVERY.md：分别记录Docker PG、Mock、真实浏览器、未验证供应商/云运行时。最终仅提交本轮文件，保留用户.codex改动与backup，不push。

仓库卫生以现有main/唯一worktree实施足够安全，不创建临时分支。用户明确禁止重复确认普通步骤，当前批准覆盖此计划。Pencil/Figma/生命周期工具本环境未提供，不冒充工具门禁通过；既有界面增量工作使用实际浏览器视觉证据与独立审查。生产释放/用户ID语义沿用Phase2，不更改。
