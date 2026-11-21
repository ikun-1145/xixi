# 纯手机号注册上线交接（2026-11-19）

## 版本
- PR：#41，合并提交 `357f331`（main）
- Cloudflare Pages 生产部署：`1251b472-ae0b-49c9-a98f-90e77a9735c9`，提交 `357f331`
- 生产数据库迁移：`20261119140108_phone_only_registration`（Supabase `klyrasrqgxijwrxuoevj`）
- phone-auth Worker 生产版本：`54c8f2e6-a2cd-46cf-9681-fe022a8f82d1`（与 `1cd35501-65f6-4467-9532-a91701bed82e` 同一 bundle，构建自 `a7cd748`，bindings 仅多 `PHONE_ONLY_REGISTRATION_ENABLED=true`）
- 开关关闭的同 bundle 版本：`1cd35501-65f6-4467-9532-a91701bed82e`（bindings 与上一版逐项一致）
- 上一版 Worker：`0fa1db9c-1e95-45fd-99e8-4de9aea49805`

## 生产开关（Cloudflare Worker `phone-auth` 环境变量）
| 开关 | 状态 |
| --- | --- |
| `PHONE_ONLY_REGISTRATION_ENABLED` | **true**（2026-11-19 开启） |
| `PHONE_NEW_REGISTRATION_ENABLED` | true（未改） |
| `PHONE_UNIFIED_LOGIN_ENABLED` | true（未改） |
| `PHONE_IDENTITY_ENABLED` / `PHONE_SMS_ENABLED` | true（未改） |
| `PHONE_SMS_PROVIDER` | relay（模板仅批准登录/注册） |
| `PHONE_ACCOUNT_MANAGEMENT_ENABLED` / `PHONE_EMAIL_REAUTH_ENABLED` | false（未改） |
| `PHONE_RELAY_DELETE_REAUTH_ENABLED` | 不存在；代码已移除，relay 只发 `login` 用途短信 |

## 功能边界
- 新手机号：短信验证后可“直接注册”，邮箱可选；填写邮箱必须完成邮箱验证码。
- 纯手机号账号 `email = NULL`，不虚构邮箱；已有账号不自动合并。
- 注销：有邮箱账号沿用原邮箱验证码流程；纯手机号账号（以服务端签发的 database token `email: null` 判定）隐藏自助删除按钮，显示 support@sunland.dev 人工申请；状态无法确认时保留原按钮并提示人工渠道。
- 手机号短信注销未上线。

## 测试（合并前）
- `npm test`：972 通过，0 失败
- `node --test workers/phone-auth/tests/*.test.mjs`：54 通过
- `supabase/tests/phone-only-registration/run.sh`（隔离 postgres:17，含生产函数 md5 比对）：55 PASS
- `supabase/tests/phone-unified-registration/run.sh`：26 PASS
- 生产无短信冒烟：`send-code` 无效 Turnstile 403、`verify-code`/`unified/verify` 400、`status` 未登录 401、`unified/register-phone` 开关关闭 403、CORS 预检 204

## 最小回滚
1. 关新注册（首选）：`wrangler versions deploy 1cd35501-65f6-4467-9532-a91701bed82e@100% --name phone-auth -y`（同代码、开关关闭）；或在 Cloudflare 控制台把 `PHONE_ONLY_REGISTRATION_ENABLED` 设为 `false`。已注册的纯手机号账号走普通登录路径（`allow_create:false`），不受影响。
2. Worker 回滚：`wrangler rollback 0fa1db9c-1e95-45fd-99e8-4de9aea49805 --name phone-auth`（旧版本不认识新路由，纯手机号账号仍可登录）。
3. 前端回滚：Cloudflare Pages 控制台回滚到上一生产部署，或 revert PR #41 的合并提交。
4. 数据库：保留新函数即可（只有 service_role 能调用，开关关闭时无入口）。不要删除无邮箱用户、不要清空 Durable Object。

## 仍需人工处理
- 真机短信注册/登录体验未验证（本轮禁止发送真实短信）。
- 纯手机号用户的自助注销需要一个获批注销场景的短信模板后另行开发上线；当前为人工处理。
- Flutter 客户端只核对了接口契约（新增字段 `phone_only`、新路由），未做客户端测试。
- 本地开发：拉取 main 后 `npm install`；隔离数据库测试需要 Docker。

## 上线记录
1. 生产函数 md5 与隔离测试 fixture 一致后应用迁移；新函数仅 service_role 可执行；`user_profiles` 411 行、email 为空 12 行、手机号身份 1 行，迁移前后不变。
2. Worker `1cd35501`（开关关闭）上线，旧协议无短信冒烟通过，`unified/register-phone` 返回 403 `REGISTRATION_DISABLED`。
3. PR #41 CI（web-tests、postgres17）通过后合并，Pages 部署 `357f331`，线上 login/ai_settings/JS 已含新代码。
4. Worker `54c8f2e6` 开启 `PHONE_ONLY_REGISTRATION_ENABLED`，`unified/register-phone` 进入 proof 校验（无效 proof 返回 `CHALLENGE_INVALID`），其他接口冒烟不变。
5. 全程未发送真实短信、未消耗短信额度。
