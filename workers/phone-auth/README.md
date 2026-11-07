# 独立 phone-auth Worker

本目录包含独立手机号认证 Worker 的源码、阿里云 PNVS 与短信 relay 适配器，默认关闭手机号认证、短信和新注册。部署涉及现有 Cloudflare 路由、密钥和 Durable Object，须先核实生产绑定与账本状态，并取得独立授权；不要重建或清空账本。

Relay 使用 `PHONE_SMS_PROVIDER=relay`、HTTPS `SMS_RELAY_URL` 和 Secret `SUNLAND_SMS_RELAY_KEY`。验证码保存在 DO 的 HMAC 摘要中，发送后校验保持一次消费。注册、登录和手机号再验均向 relay 发送 `scene=login`；上线验收前须确认服务商模板支持这些用途。其他必需配置包括三个 Key ID、`PHONE_AUTH_POLICY` 和 Canary 号码摘要白名单。不要将密钥、号码或白名单摘要提交到仓库。

此构建不是单仓库自包含：`scripts/build-phone-auth-worker.mjs` 需要本机另有 `sunland_ai_app/worker` 仓库、其固定 Git 提交 `bc5489b6e2962f3e1306aa4de5b4292cecf7ca3d` 及其 `esbuild`。通过 `SUNLAND_AUTH_WORKER_ROOT` 指定该目录；脚本会核对基线摘要并拒绝漂移。本地 workerd 验收还需要该仓库中的 `miniflare`。构建不会部署或修改另一个仓库。

```sh
node --test tests/phone-auth-provider.test.mjs tests/phone-auth-routes.test.mjs tests/phone-release-policy.test.mjs workers/phone-auth/tests/relay.test.mjs
SUNLAND_AUTH_WORKER_ROOT=/absolute/path/to/sunland_ai_app/worker node workers/phone-auth/tests/relay-workerd.mjs
```

这些测试使用模拟网络，不能证明真实短信、生产账号或数据库初始化成功。
