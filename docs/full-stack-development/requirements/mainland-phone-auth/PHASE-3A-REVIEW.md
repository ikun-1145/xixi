# Phase 3A 审查与验证

日期：2026-10-24。架构、数据库实现、设置实现、QA和安全审查分工独立；文件写入所有权不重叠。A Team原名单9 agents/15 skills有效，未重新初始化。frontend技能未激活，实施使用已激活认证安全/TDD流程和仓库原生前端规范。

## 独立审查和修复

- 架构Agent确认唯一登录入口、共用成功流程、设置页可信身份、masked status/邮箱发送真实契约、exact-token grant绑定及现有六语言机制。
- QA复现并复核关闭3项P2：邮箱发送期间切换模式后按钮锁死；取消后迟到GeeTest widget重新弹出；BFCache返回后发送/倒计时锁死。均有先失败再通过的DOM回归。
- QA指出登录切换条未匹配共享CSS作用域；已补44px控件和当前项高亮，真实Edge截图验证。
- 真实Edge检查发现并修复：原settings全局`var supabase`覆盖vendor运行时，导致后续ES模块启动异常；改为页面局部`settingsSupabase`并保持原查询/上传/会员调用。新增保留vendor回归，实际页面无该pageerror。
- 视觉检查发现card的filter/overflow裁剪固定dialog；将dialog/backdrop放入body portal，保留同一个闭包、focus loop与请求代次，截图复验标题/关闭按钮完整可见。
- 实际浏览器复现原页面多个身份所有者并发初始化时，phone card可能停在loading；仅同token/epoch下重读一次已验证身份，持续不可用明确报错，不重试验证码、授权消费或写入。新增回归，安全Agent最终复核通过。
- 安全Agent对Worker契约、JWT/请求代次、OTP/proof内存、captcha用途、未知写结果、RLS/本地脚本归属及网络拦截进行了独立审查，最终未发现有证据的P1/P2安全阻断项。最终单独复测settings 17/17通过；此前四组前端36/36通过，主Agent最终全套结果如下。

## 最终实际命令

| 命令/检查 | 结果 |
| --- | --- |
| `npm test` | **998/998**，0失败、0跳过 |
| `node scripts/test-phone-postgres.mjs` | **15/15**真实Docker PostgreSQL17.6，多连接锁等待；主Agent再次执行并清理容器 |
| `node scripts/test-phone-web-browser.mjs` | **20/20**真实Edge151.0.4129.78，所有外部请求Mock/拦截 |
| `PHONE_BROWSER_MATCH='settings ' node scripts/test-phone-web-browser.mjs` | 3项设置子集复测，不另计20项覆盖 |
| 原Worker `auth-input-validation/account-identity/email-otp/onboarding` | **66/66**，原邮箱/身份/注销/资料引导兼容 |
| Node语法、JSON、`git diff --check`、roster verify | 通过 |

前端专项共37项：共享client10、login4、settings17、i18n6。Worker集成新增前端client→真实原Worker构建→PGlite事务链路，并实际校验本地假密钥签发的数据库JWT HMAC签名、id/sub与900秒期限；其余Phase1/2测试全部保留。

浏览器覆盖中英日×390/1280×深浅色登录12种状态；设置中英日真实页面bind/change/unbind、唯一登录方式解绑阻止；错误/过期/注销拒绝、重复点击、服务端cooldown、断网恢复、预算/频率、人机验证缺配置/失败关闭、实时语言切换；邮箱及手机号登录后共同加载profile与Pro。截图和结构化结果位于`phase-3a-evidence/`。实际检查了日文暗色移动登录和设置安全dialog，未把DOM测试称为视觉验收。

## 范围限制

- Docker实际执行迁移、事务、约束、角色/RLS和多连接锁竞争，不是Mock；基线仅包括已审计核心结构与真实删除迁移，未恢复完整生产业务schema/全部策略和触发器。
- PG权限测试设置合成claims，不证明PostgREST验签；Worker真实签名验证使用本地假密钥，不是生产JWT网关验收。
- Edge是真实浏览器，API/验证码厂商/数据库REST为Mock，移动项仅视口检查；没有真实iPhone/Safari/Android设备验收。
- Turnstile客户端实现依据[官方显式渲染文档](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/)，真实captcha、人机风险判定、供应商计费及Cloudflare DO运行时仍未验收。
- 没有生产迁移、短信、部署、密钥或远程push。full-stack生命周期/Pencil工具未提供，不冒充这些工具门禁通过；本轮保留原UI，以用户明确批准范围、实际测试和独立审查交付。
