# 霜蓝AI 手机号认证 Phase 3A 交付

日期：2026-10-24。**本轮已完成网站端本地实现、真实Docker PostgreSQL隔离验收和Mock集成验证；未进行真实短信验证，未部署生产环境。**

## 新增入口与交互

`login.html` 原弹窗新增“邮箱登录 / 手机号登录”轻量切换。邮箱GeeTest、原API与登录结果结构保持兼容。手机号模式包含+86、tel输入、6位验证码、发送/冷却倒计时、协议勾选及“登录或注册”；后端决定原账号登录或首次注册，不自动合并邮箱账户。

两种方式共同调用原用户规范化、封禁检查、`localStorage.token/user`保存及站内返回白名单。新用户继续使用原profile和昵称/头像设置，不建立手机号资料表或新Session体系。网站本来没有独立onboarding向导，本轮未声称创建了完整向导。真实浏览器验证了登录后沿原设置页加载昵称和Pro，Worker层验证了原user_id与权益保持。

`ai_settings.html` 账号卡后新增“手机号管理”：未绑定显示绑定说明/入口；已绑定只显示后端掩码及更换、解绑。独立安全dialog先验证当前邮箱或用户主动输入的当前手机号，再验证目标新手机号；解绑仅可用邮箱证明，且必须明确勾选确认。没有替代登录方式时禁用解绑并解释，后端仍重复检查。

按钮具备请求锁和加载反馈；倒计时按服务端retry_after的绝对时间计算，后台/返回时重算，不把它当作服务端防刷依据。验证码/完整号码/challenge/reauth token仅留内存；模式切换、关闭、取消、账号变化、页面离开或授权过期均清理。刷新页面需重新获取验证码，服务端冷却仍有效。短信验证码300秒有效、同号正常600秒冷却来自Phase1，不能通过换用途绕过。

敏感流程开始前显式刷新原应用JWT，之后固定完整token与本地请求代次；期间token变动会清授权。不会自动刷新并重放已消费的OTP/身份写入。未知写结果关闭流程、清临时凭证、只读查询最新status，再由用户核对。错误使用固定本地化文案，不透传供应商/数据库原始错误，手机号占用提示不揭示具体账户。

## API与配置

完全沿用`phase-2-openapi.json`的9个端点，未新增不兼容协议。前端共享client固定HTTPS API、POST JSON、必要Bearer、credentials omit/禁止重定向，内部生成UUIDv4操作ID，不允许指定user_id。手机号Turnstile action为phone_login/phone_bind/phone_change/phone_reauth，邮箱继续原GeeTest。

新增两个页面的公开配置项：`<meta name="sunland-turnstile-sitekey" content="">`。当前为空，实际发送失败关闭。未来经发布审批后仅填写公开sitekey；服务端secret仍在Worker secret store，不得填写前端。`PHONE_SMS_ENABLED`、`PHONE_IDENTITY_ENABLED`、账本/canary及供应商密钥本轮均未在生产开启/配置。

本地Mock测试由测试代码注入假的captcha/HTTP响应，不在生产源码增加Mock开关、后门或硬编码测试验证码。新模块不携带Supabase service_role、阿里云密钥或真实用户数据。

## 文件

新增：

- `p/js/phone-auth.js`：共享API、超时、请求/会话隔离、captcha生命周期、内存冷却及安全错误。
- `ai/phone-settings.js`、`p/css/phone-auth.css`：手机号管理及响应式/主题/键盘交互。
- `scripts/test-phone-postgres.mjs`、`tests/fixtures/phone-postgres-baseline.sql`：可复现隔离数据库验收。
- `scripts/test-phone-web-browser.mjs`：真实Edge自动化，localhost服务器、所有外部网络拦截。
- `tests/phone-web-client.test.mjs`、`phone-web-login.test.mjs`、`phone-settings.test.mjs`、`phone-web-i18n.test.mjs`。
- 本交付、`PHASE-3A-PLAN.md`、`PHASE-3A-POSTGRES.md`、`PHASE-3A-REVIEW.md`、范围更新及`phase-3a-evidence/`。

修改：`login.html`、`ai_settings.html`、`p/js/site-i18n-extra.js`、`tests/phone-worker-integration.test.mjs`、阶段状态与项目总览。无运行时新依赖、无Flutter改动、无Worker/生产配置/SQL迁移修改。设置页原有Supabase库覆盖问题作了必要的局部变量修复，不改原查询或权益语义。

## Docker隔离数据库验收

Engine29.8.2、Supabase CLI2.109.1可用。现有8个Supabase容器保持原状；采用本地已有PostgreSQL17.6镜像，随机独立容器、network none、Unix socket、无宿主端口、tmpfs、CPU/内存/PID限制。仅合成数据，finally核对本次label后删除自己的容器。

**15/15实际通过**：新库建立已审计基线并执行真实删除/phone迁移；已有邮箱/Pro profile升级；唯一/FK/原子创建；不同backend同时注册同号、两个账户同时绑定同号；换绑/解绑；错误/过期grant；等锁后到期；异常回滚；注销中登录阻止；租约/fence清理后退休释放；再次注册新UUID、旧账号不复活；普通角色RPC/表访问拒绝、RLS及自定义id claims权限边界。

并发检查通过不同psql进程、不同backend PID、`pg_blocking_pids`和`wait_event_type=Lock`确认真实阻塞，不是Promise队列模拟。详情和实际执行记录见`PHASE-3A-POSTGRES.md`。

限制：仓库缺少完整初始业务schema，当前基线没有还原全部生产策略/业务触发器；PG JWT边界为合成claims/RLS，不是PostgREST验签。未连接生产执行测试写入，也未为了适配测试修改生产结构。Phase2迁移本次未发现需要修复的缺陷。

## 网站、Worker、语言与视觉结果

| 验证层 | 结果 |
| --- | --- |
| `npm test`（含全部Phase1/2及新增网站测试） | **998通过，0失败，0跳过** |
| 原Worker邮箱/身份/注销/onboarding四组 | **66通过，0失败** |
| 真实Edge+Mock网络 | **20/20通过** |
| Docker PostgreSQL实际事务/并发/权限 | **15/15通过** |
| 语法、JSON、diff检查、A Team roster | 通过 |

前端client还实际连接了真实源码构建出的Phase2 Worker fetch和PGlite SQL，完成注册、status、邮箱近期授权、换绑及解绑；数据库JWT本地HMAC签名、id/sub和900秒期限实际校验通过。数据库REST、短信、captcha为Mock，未冒充供应商或生产验收。

新增文案接入原SiteI18n机制，完整提供简中、繁中、English、日本語、한국어、Español；中英日为真实浏览器重点。登录12种组合覆盖中英日×390/1280视口×深浅色，设置页验证三语言与安全dialog、原profile/Pro加载。采用原设计token，无大型UI依赖。37项网站专项覆盖参数/重复/取消/过期/重放提示/网络/近期授权/单一登录方式/语言等；移动验证为Edge视口，不等同真实iOS/Safari或Android设备。

截图与结构化结果位于`phase-3a-evidence/`；审查发现及修复记录见`PHASE-3A-REVIEW.md`。

## 安全审查与尚未验证场景

独立架构、QA/API兼容、认证安全及数据库脚本审查完成，发现的问题均补回归并修复。最终复核未发现有证据的本地P1/P2阻断。未见新增完整手机号/验证码日志、持久化proof、客户端user_id、匿名特权RPC、Turnstile或近期验证绕过路径。

仍未验证：真实短信送达/运营商回收/计费/供应商故障与风控；真实GeeTest/Turnstile挑战体验与服务端判定；Cloudflare DO持久化/重启及账本恢复；完整生产schema迁移与PostgREST JWT网关；真实移动设备/生产CORS。拥有工具权限不代表生产写入授权，本轮没有创建云端凭证。

## 发布前剩余工作与Phase 3B

可以进入 **Phase 3B Flutter的本地开发和Mock集成**，继续使用现有OpenAPI、原JWT和user_id，不需要迁移身份体系。但不能据此直接发布或执行生产迁移。

生产开放前必须另行授权并完成：完整隔离schema/策略/业务触发器演练及回退方案；真实DO/预算恢复；PostgREST数据库JWT权限全链路；公开sitekey与受限服务端凭证、canary和预算初始化；真实短信/计费验收；网站与Worker协调发布及紧急关闭方案。

网站原“删除账号”弹窗仍沿用邮箱流程，本轮不扩展其phone-only确认UI；后端phone delete-authorize和退休释放已存在并测试。生产开放phone-only注册前须补齐这一删除入口，不能让唯一手机号用户依赖虚构邮箱注销。

## Git与状态

在原main本地提交，保留`be0422e`、`527e31e`、`0b51e8c`及历史成果；本轮commit ID见最终回复或`git log -1 --format='%H %s' -- docs/full-stack-development/requirements/mainland-phone-auth/PHASE-3A-DELIVERY.md`。用户已有`.codex/config.toml`改动和备份未触碰、未提交。未创建临时分支/worktree，未push。

最终状态：**本地实现完成；Docker隔离PostgreSQL验证通过；Mock与真实浏览器集成通过；尚未真实短信验证；尚未迁移/部署生产。**
