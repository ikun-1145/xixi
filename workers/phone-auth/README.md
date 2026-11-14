# 独立 phone-auth Worker

本目录包含独立手机号认证 Worker 的源码、阿里云 PNVS 与短信 relay 适配器，默认关闭手机号认证、短信和新注册。部署涉及现有 Cloudflare 路由、密钥和 Durable Object，须先核实生产绑定与账本状态，并取得独立授权；不要重建或清空账本。

Relay 使用 `PHONE_SMS_PROVIDER=relay`、HTTPS `SMS_RELAY_URL` 和 Secret `SUNLAND_SMS_RELAY_KEY`。验证码保存在 DO 的 HMAC 摘要中，发送后校验保持一次消费。中转方已确认 `scene=login` 的模板仅用于注册和登录；手机号再验、绑定、换绑和解绑保持关闭，不能复用该模板。其他用途需要独立适用的审核模板及中转接口支持。其他必需配置包括三个 Key ID、`PHONE_AUTH_POLICY` 和 Canary 号码摘要白名单。不要将密钥、号码或白名单摘要提交到仓库。

`scene` 是中转方参数，不是阿里云 `SendSms` 的参数。中转方的 HTTP 2xx 和数字 `ok=1` 只表示中转接口受理，不能证明运营商已送达；超时、异常响应和业务失败维持未知结果处理，保留预算与号码隔离，不自动重发。客户端响应丢失时可尝试原 challenge，但中转发送结果未知时服务端可能已拒绝该 challenge，不能保证验证码可用。中转响应的 `request_id` 尚未确认是阿里云 `BizId`，当前中转协议也没有已确认的回执查询接口，不得自行构造查询或将其当作送达凭据。真实回执应由中转方通过其已确认的接口或阿里云控制台核查；查询结果可能包含完整号码和短信内容，不得记录。

阿里云官方说明国内短信按运营商回执计费：失败回执不计费，尚无回执可能先计费；超过 70 字的短信会拆分计费。同签名验证码的默认频率为每号码每分钟 1 条、每小时 5 条、每天 10 条，实际账户配置及号码维度上限仍可能更严格。参见[计费说明](https://help.aliyun.com/zh/sms/product-overview/billing-overview/)、[发送规则](https://help.aliyun.com/zh/sms/user-guide/message-rules)和[回执查询](https://help.aliyun.com/zh/sms/developer-reference/api-dysmsapi-2017-05-25-querysenddetails)。这些规则不能证明朋友的中转服务单价、拆分、超时和重复计费方式；项目的三次预留及 0.60 元内部预算也不是供应商实际收费上限。

账号管理及邮箱近期验证分别由 `PHONE_ACCOUNT_MANAGEMENT_ENABLED`、`PHONE_EMAIL_REAUTH_ENABLED` 控制，默认均为 `false`。邮箱验证另需通过 Cloudflare Secret 安全配置 `PHONE_REAUTH_EMAIL_API_KEY`；此密钥应属于获准从 `no-reply@api-mail.sunland.dev` 发信的邮件服务账号，不能使用短信中转密钥。发送与校验复用已审查的 `sunland_otp` 数据库 RPC，邮箱地址、用户、会话及操作用途共同约束验证码；生产启用前必须确认该 RPC 与权限存在、独立发信密钥已配置，且实际投递和消费已获授权验收。切勿将密钥加入配置文件、命令参数或日志。

`tests/identity-integration.mjs` 可在设置 `PHONE_PREFLIGHT_PACKAGE_ROOT`、`PHONE_XIXI_SOURCE_ROOT` 和 `PHONE_SUNLAND_SOURCE_ROOT` 指向本地依赖与源码后运行；设置 `PHONE_TEST_POSTGRES_IMAGE=postgres:17` 使用网络禁用、临时内存存储的隔离 PostgreSQL。它使用合成数据及模拟短信、邮件，不连接生产。未设置该变量时使用 PGlite 单连接，不代表 PostgreSQL 多连接并发验证。

此构建不是单仓库自包含：`scripts/build-phone-auth-worker.mjs` 需要本机另有 `sunland_ai_app/worker` 仓库、其固定 Git 提交 `bc5489b6e2962f3e1306aa4de5b4292cecf7ca3d` 及其 `esbuild`。通过 `SUNLAND_AUTH_WORKER_ROOT` 指定该目录；脚本会核对基线摘要并拒绝漂移。本地 workerd 验收还需要该仓库中的 `miniflare`。构建不会部署或修改另一个仓库。

```sh
node --test tests/phone-auth-provider.test.mjs tests/phone-auth-routes.test.mjs tests/phone-release-policy.test.mjs workers/phone-auth/tests/relay.test.mjs
SUNLAND_AUTH_WORKER_ROOT=/absolute/path/to/sunland_ai_app/worker node workers/phone-auth/tests/relay-workerd.mjs
```

这些测试使用模拟网络，不能证明真实短信、生产账号或数据库初始化成功。
