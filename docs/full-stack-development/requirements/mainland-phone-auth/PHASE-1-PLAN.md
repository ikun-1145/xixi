# Phase 1 已批准范围与实施契约

日期：2026-10-24。用户批准工作流初始化后自主实施 Phase 1；不实施 Phase 2–3，不部署。

## 方案与边界
复用 Workers ESM、Web Crypto、现有错误 JSON 形态与超时/大小限制模式。没有完整认证 Worker 本地工程，交付可导入模块；不复制整份线上 bundle、不创建替代认证服务器、不改变邮箱/CORS/JWT。Phase 0 已核实的身份权威继续有效。

普通 KV 不能实现原子预算；数据库事务方案仍依赖后续迁移。选择单一固定名字的 Durable Object，在其持久事务内同时裁决手机号、IP、日总量及整数费用预算。单对象是刻意接受的短信低吞吐限制；未来扩容须保留唯一全局预算权威，不得直接按手机号分片。未部署 DO、缺失账本、关闭开关、配置缺失均拒绝发送。

## 稳定的内部服务契约
此处是 Worker 内部 JavaScript 接口，不是已开放的浏览器 REST API。`sendPhoneCode(env,input,context)` 和 `checkPhoneCode(env,input,context)` 通过 `PHONE_AUTH_COORDINATOR` 绑定转发至固定对象 `sunland-phone-auth-v1`。

- send input：仅 `phone`、`purpose`、`turnstile_token`；check input：仅 `phone`、`purpose`、`challenge_id`、`code`。拒绝额外字段，尤其 user_id；手机号仅中国大陆 1[3-9] 开头11位，可带+86，规范化后只处理11位字符串；验证码严格6位数字字符串。
- purpose：login、bind、change、unbind、reauth。除 login 外都需要服务端上下文 userId/sessionId、active 状态及5分钟内近期认证时间。上下文必须由现有JWT中间件、状态检查及二次认证产生，禁止直接用客户端body。缺上下文拒绝，Phase1不实现认证中间件替代品。
- context：服务端可信 `ip`（来自可信CF入口）、可选 `userId`/`sessionId`/`identityStatus`/`reauthenticatedAt`；时间为Unix毫秒。IP格式验证并对IPv6统一规范化，禁止X-Forwarded-For回退。绑定当前主体/会话和purpose，验证请求不能改变主体。
- send输出：`{success:true,challenge_id,expires_in:300,retry_after:600}`；check输出：`{success:true,verified:true}`，仅当challenge原子消费持久化成功后返回。无token/user/权限授予，验证结果不得作为客户端可重放的登录凭据。
- 错误：内部抛出固定 `PhoneAuthError(code,status)`；由调用方现有json helper转换为 `{error:固定脱敏文本,code}`。不输出原始供应商响应/手机号/验证码/凭证，无日志。
- 护栏错误：SMS_DISABLED(503)、SMS_CONFIG(503)、INVALID_REQUEST(400)、REAUTH_REQUIRED(403)、CAPTCHA_FAILED(403)、RATE_LIMITED(429)、BUDGET_EXCEEDED(429)、SERVICE_UNAVAILABLE(503)、CHALLENGE_INVALID(400)、CHALLENGE_EXPIRED(400)、CHALLENGE_USED(409)、CODE_INVALID(400)；供应商异常另见模块固定映射。

## 存储与防刷
- 单一DO账本必须预先经独立审核初始化，运行时代码绝不自动创建或重置账本。Mock显式注入初始化账本，缺失/畸形/事务失败拒绝；生产首次启用不在本次范围。
- 手机号/IP/主体仅存不同域分隔的HMAC摘要；原始手机号仅在单次请求内存和HTTPS供应商请求中存在。验证码/Turnstile token不落盘。
- 全局总预算、UTC日次数及日金额预算；手机号/IP日发送数；供应商60秒发送间隔，服务端600秒锁；所有用途一起计数，预留写入成功之后才请求供应商。金额以整数微元表示，单价上界必须经账单审核配置，无价格默认值。任何失败均不退预算，不自动重试。
- 预留时即隔离手机号，只有明确完成发送或确定拒绝才解除隔离；进程中断、未知发送结果保留隔离且不自动清理，需未来单独审核供应商状态后恢复（本轮不提供生产恢复入口）。每个手机号至多一个challenge，整体锁定至少10分钟（请求硬超时最大10秒，不可提高到超过锁保护窗口）；包含请求超时、供应商300秒TTL及余量。成功/错误/失败/耗尽也不提前放锁。OutId仅流水号，不用作阿里云验证码选择器；SchemeName为服务端固定用途映射，不假设不同scheme已获供应商隔离保证。
- 状态sending→sent→verifying→consumed/failed；核验前原子认领，最多5次；核验超时或供应商异常关闭challenge，不重试未知结果。5次普通错误后关闭。过期/不同用途/不同主体/不同手机/重放均拒绝，存储失败不返回通过。
- Turnstile校验success、hostname、action以及challenge_ts，超过300秒/未来异常拒绝；外部请求手动拒绝重定向，超时覆盖正文读取，响应限大小。不从浏览器倒计时取得安全依据。
- 过期临时状态通过每次请求内有界清理处理（不启动新定时任务），永久预算账本不清理；DO存储丢失/重建不能重置预算。

## 文件、步骤与验证
flow profile：strict-fullstack（本轮纯后端，无视觉/UI门禁）。执行链：已批准需求→architect/planner只读审查→书面契约→TDD→executing-plans→qa/security审查→verification-before-completion→阶段提交。

1. `workers/phone-auth/{errors,http,dypnsapi}.js`：供应商封装/签名/错误/限制；高风险，依赖官方MCP API与签名文档；先固定签名向量和Mock测试再实现。
2. `workers/phone-auth/{coordinator,service}.js`：强一致状态/Turnstile/输入与可信上下文；高风险，依赖步骤1；先失败、并发、存储异常测试，再实现。
3. `tests/phone-auth-*.test.mjs`：Mock端到端及预算、并发、重放、超时、清理、重启测试；禁止真实网络业务调用。
4. 本目录证据/状态/交付文档：保存Supabase元数据核验和集成前置条件。仍禁止迁移与Phase2。
5. focused与全量npm test、git diff --check、安全与质量复核；仅提交相关文件，保留用户配置。

官方证据：已通过阿里云MCP核实Dypnsapi 2017-05-25两个API。POST查询参数、空body；Send使用##code##、CodeType1、CodeLength6、ValidTime300、Interval60、DuplicatePolicy1、ReturnVerifyCode=false、AutoRetry0；Check仅Model.VerifyResult=PASS通过。
- https://help.aliyun.com/zh/pnvs/developer-reference/api-dypnsapi-2017-05-25-sendsmsverifycode
- https://help.aliyun.com/zh/pnvs/developer-reference/api-dypnsapi-2017-05-25-checksmsverifycode
- https://help.aliyun.com/zh/sdk/product-overview/v3-request-structure-and-signature （官方固定签名向量）
- https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
- https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/

未暴露full-stack阶段工具，不声称自动门禁通过；以实际契约、独立审查、测试证据记录本轮授权范围。上线前仍需认证Worker源码工程集成与测试环境验证。

开源模式核对：已搜索并阅读 Cloudflare 官方 Durable Objects 模式与阿里云官方 SDK 元数据结构。沿用事务与规范签名思想，不复制大型 SDK；通用限流通常应分散实例，但本轮为短信费用的全局硬上限选择单个低吞吐协调点，不能把它推广为全站流量入口。参考 https://github.com/cloudflare/skills/blob/main/skills/cloudflare/references/durable-objects/patterns.md ，https://github.com/aliyun/alibabacloud-java-sdk/tree/master/dypnsapi-20170525 。
