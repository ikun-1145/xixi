# 实施计划

1. 在 `functions/copilot.js` 增加仅供服务端使用的腾讯云 RCE IP 风险画像适配器。
2. 只在 `CN`、`HK`、`MO`、`TW` 命中时查询；查询结果严格接受 VPN 布尔字段，失败默认 403。
3. 从 Cloudflare `CF-Connecting-IP` 读取客户端 IPv4，不接受浏览器自带的转发头。
4. 扩展 `tests/copilot-geo.test.mjs` 覆盖允许、拒绝、异常、未配置、未知国家、HEAD 和不查询非限制地区。
5. 运行聚焦测试、`npm test`、语法检查、Wrangler Functions 构建和差异检查；记录与本次无关的既有全量测试失败。

## 执行边界

- 不修改 `copilot.html` 或其他业务页面。
- 不把 `COPILOT_TENCENT_SECRET_ID` 或 `COPILOT_TENCENT_SECRET_KEY` 写入仓库。
- 不自动配置、购买或部署外部服务。
- 如果部署方不能接受当前服务配置，应停止配置腾讯云 RCE，改为已评估的本地服务或 Cloudflare Enterprise 规则。
