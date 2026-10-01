# copilot.html 地理围栏需求

## 变更目标

`copilot.html` 对中国大陆、香港、澳门和台湾地区的直接访问继续限制，但不能把“我已开启 VPN”作为用户自声明的放行条件。只有服务端 IP 情报明确确认当前请求来自 VPN 出口时，才允许该请求进入页面。

## 范围

- 只影响 `/copilot` 和 `/copilot.html` 的 Pages Function 访问判定。
- 不修改 `copilot.html`、其他页面、登录、Supabase 或评论生成接口契约。
- 浏览器不直接调用 IP 情报服务，服务密钥只存在 Pages Secret。

## 访问策略

1. 使用 Cloudflare `request.cf.country` 判断请求出口 IP 的国家/地区。
2. `CN`、`HK`、`MO`、`TW` 进入服务端 VPN 查询；其他地区直接提供现有静态页面。
3. 仅当腾讯云服务端查询结果包含 VPN 风险类型 `730014` 时放行。
4. 未配置密钥、未取得客户端 IP、查询超时、返回异常、结果不是 VPN，均保持 403。
5. 不读取用户可控的 `X-Forwarded-For` 等转发头；只使用 Cloudflare 提供的 `CF-Connecting-IP`。
6. `HEAD` 请求执行同一访问判定，但不返回响应体。

## 部署前提与合规注意

当前实现采用腾讯云风险识别 RCE 的 `ManageIPPortraitRisk` 服务端接口，需要 Pages Secret `COPILOT_TENCENT_SECRET_ID` 和 `COPILOT_TENCENT_SECRET_KEY`，并可选配置 `COPILOT_TENCENT_CHANNEL`（默认 H5 渠道 2）。该接口当前只支持 IPv4，只有返回风险类型 `730014`（VPN）才放行；代理、Tor、IDC 和匿名 IP 不自动视为 VPN。正式启用前仍需完成服务合同、个人信息处理和日志留存评估。

## 验收标准

- CN/HK/MO/TW + 风险类型包含 `730014`：返回原有静态页面 200。
- CN/HK/MO/TW + 其他风险类型、字段缺失、查询失败或未配置：返回原有访问受限页面 403。
- 非限制地区：不调用 VPN 查询，返回原有静态页面。
- 无法获取国家/地区：为避免未知请求绕过限制，返回 403。
- 其他页面和 `copilot.html` 原有 DOM/API 文案不发生变化。
