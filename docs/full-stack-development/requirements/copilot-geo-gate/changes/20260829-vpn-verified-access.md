# 需求变更：仅允许服务端确认的 VPN 出口访问

## 用户变更请求

用户实测发现，开启 VPN 后仍显示“不支持的国家或地区”，并明确要求：不开 VPN 时显示无法访问，开启 VPN 后允许访问；不能通过用户点击“我已开启 VPN”直接放行，并要求方案符合中国大陆法律法规。

## 受影响层

- 产品/访问策略：由“国家码命中即拦截”变为“国家码命中后服务端验证 VPN，确认后放行”。
- 工程实现：`functions/copilot.js` 需要异步调用腾讯云 RCE IP 风险画像，并在异常时保持拒绝。
- 接口/部署：新增 Pages Secret `COPILOT_TENCENT_SECRET_ID`、`COPILOT_TENCENT_SECRET_KEY`，可选 `COPILOT_TENCENT_CHANNEL`；不改变页面业务 API。
- 验收：新增 VPN 成功、非 VPN、查询异常、未配置和未知国家的回归场景。
- 视觉/UI：不新增 UI；沿用既有访问受限页面。

## 失效的旧假设

- 不能再把 `request.cf.country` 作为唯一访问信号。
- 不能把用户自声明、前端按钮、Cookie 或可控请求头作为 VPN 证明。

## 阶段回退与复核

- 回退目标：实现计划阶段；当前采用 `light-change` 流程。
- 需要重新确认：服务端 IP 来源、第三方服务密钥隔离、查询失败默认拒绝、既有页面不变。
- 完成前需要重新运行聚焦测试、完整 `npm test`、Wrangler Functions 构建和 `git diff --check`。
