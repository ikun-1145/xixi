# 独立 phone-auth Worker

本目录包含独立手机号认证 Worker 的源码、阿里云 PNVS 与短信 relay 适配器，默认关闭手机号认证、短信和新注册。部署涉及现有 Cloudflare 路由、密钥和 Durable Object，须先核实生产绑定与账本状态，并取得独立授权；不要重建或清空账本。

Relay 使用 `PHONE_SMS_PROVIDER=relay`、HTTPS `SMS_RELAY_URL` 和 Secret `SUNLAND_SMS_RELAY_KEY`。验证码保存在 DO 的 HMAC 摘要中，发送后校验保持一次消费。注册、登录、手机号再验及启用账号管理后的绑定、换绑均向 relay 发送 `scene=login`，内部验证码用途仍彼此隔离；上线验收前须确认服务商模板支持所有这些用途及相应计费规则。其他必需配置包括三个 Key ID、`PHONE_AUTH_POLICY` 和 Canary 号码摘要白名单。不要将密钥、号码或白名单摘要提交到仓库。

账号管理及邮箱近期验证分别由 `PHONE_ACCOUNT_MANAGEMENT_ENABLED`、`PHONE_EMAIL_REAUTH_ENABLED` 控制，默认均为 `false`。邮箱验证另需通过 Cloudflare Secret 安全配置 `PHONE_REAUTH_EMAIL_API_KEY`；此密钥应属于获准从 `no-reply@api-mail.sunland.dev` 发信的邮件服务账号，不能使用短信中转密钥。发送与校验复用已审查的 `sunland_otp` 数据库 RPC，邮箱地址、用户、会话及操作用途共同约束验证码；生产启用前必须确认该 RPC 与权限存在、独立发信密钥已配置，且实际投递和消费已获授权验收。切勿将密钥加入配置文件、命令参数或日志。

`tests/identity-integration.mjs` 可在设置 `PHONE_PREFLIGHT_PACKAGE_ROOT`、`PHONE_XIXI_SOURCE_ROOT` 和 `PHONE_SUNLAND_SOURCE_ROOT` 指向本地依赖与源码后运行；设置 `PHONE_TEST_POSTGRES_IMAGE=postgres:17` 使用网络禁用、临时内存存储的隔离 PostgreSQL。它使用合成数据及模拟短信、邮件，不连接生产。未设置该变量时使用 PGlite 单连接，不代表 PostgreSQL 多连接并发验证。

此构建不是单仓库自包含：`scripts/build-phone-auth-worker.mjs` 需要本机另有 `sunland_ai_app/worker` 仓库、其固定 Git 提交 `bc5489b6e2962f3e1306aa4de5b4292cecf7ca3d` 及其 `esbuild`。通过 `SUNLAND_AUTH_WORKER_ROOT` 指定该目录；脚本会核对基线摘要并拒绝漂移。本地 workerd 验收还需要该仓库中的 `miniflare`。构建不会部署或修改另一个仓库。

```sh
node --test tests/phone-auth-provider.test.mjs tests/phone-auth-routes.test.mjs tests/phone-release-policy.test.mjs workers/phone-auth/tests/relay.test.mjs
SUNLAND_AUTH_WORKER_ROOT=/absolute/path/to/sunland_ai_app/worker node workers/phone-auth/tests/relay-workerd.mjs
```

这些测试使用模拟网络，不能证明真实短信、生产账号或数据库初始化成功。
