# 网页 DeepSeek 联网搜索

## 范围与实施方案

按用户提供的完整规格，在原生聊天工具栏添加页面内存开关，默认关闭，切换聊天保留、刷新重置。不增加依赖、数据库、后端或持久化字段，不改模型、认证、Free/Pro、历史协议。

实施顺序：核实两端调用和 Worker → 添加原生按钮及六语言 → 在真实发送路径增加布尔字段 → 按真实 SSE 状态更新等待区 → Mock 与响应式验证 → 独立本地提交。沿用当前 main，不创建分支或工作树。

## 已核实的外部契约

- 网页实际入口为 `ai/app.js` 的 `runDeepSeekRequest` → `apiFetch` → `POST https://api.sunland.dev`。备用 `DeepSeekProvider` 不是当前主发送路径，因此本次不改它。
- Flutter 仓库 `/Users/liuxize/sunland_ai_app` HEAD 为 `cf5c882`，发送到同一根路径。其 `worker/wrangler.jsonc` 配置 `api.sunland.dev/*`，目标 Worker 名为 `ai`。
- 直接复用该 Worker：官方 `/v1/tools/search`，最多 5 条、8 秒超时、同一额度预留仅首次 attempt 搜索；搜索在身份、额度、Pro、限流及审核之后。沿用服务端密钥，网页不调用搜索服务。
- 请求增加 `web_search: boolean`。每次发送/重新生成固定选择，不写 conversation/history。Sunland 模型与图片请求不启用搜索。
- SSE 新增 `data: {"type":"web_search_status","status":"search_complete"|"search_failed"}`；原 token、reasoning、终止协议保持不变。
- 发出请求时显示本地搜索等待；只有 `search_complete` 显示整理结果，不使用计时器伪造服务端完成进度。正文/推理开始、超时、结束或错误均清理状态。
- `search_failed` 轻提示，继续读取同一回复。没有状态的旧 SSE/JSON 回复提示未确认联网，继续普通回复，不自动重发或声称搜索成功。403/429 保持原处理。
- Worker 的非流式 JSON 审核回复通过同一渲染与历史路径消费，防止开启搜索时丢失普通回复。

## 本地验证

- `node --test tests/ai-web-search.test.mjs`：14 项通过，覆盖内存开关、禁用恢复、请求布尔值、分片 SSE、推理、成功/失败、旧 SSE/JSON、403/429、取消、请求中切换聊天、六语言及慢响应状态清理。
- 外部 Worker：`node --test test/web-search.test.mjs`，13 项 Mock 通过，无真实搜索费用。
- Edge 原生操作本地 `tests/fixtures/ai-app-browser-harness.html`：开启按钮并完成 Mock SSE 回复；刷新后关闭。桌面与 320/400px、768×1024、1024×768 响应式预览未见工具栏溢出；明暗主题、英文及 22px 模型文字检查通过。模拟大字不等同所有浏览器字体设置验收。
- 验收夹具复用生产 HTML/CSS/应用模块与本地 vendor，Mock 身份、模型、用量、搜索和聊天；未知 fetch 外站请求被阻止。`?webSearch=failed` / `?webSearch=legacy` 可复查降级，`?lang=en&theme=night&largeText=1` 可复查布局。
- 全量 `npm test` 和 `git diff --check` 结果以本次交付记录为准。既有 PGlite 检查在未设置 `AFDIAN_PGLITE_PATH` 时跳过。

## 上线条件与边界

未部署、迁移、推送或使用真实账户搜索。Flutter 规格记录 cf5c882 尚未部署，当前活动生产版本未核实：上线前必须确认 Worker 包含该实现；若没有，需另行授权部署已有 Worker。无需移植模块、新密钥或环境变量。

上线前补真实 Worker 搜索成功/超时回退、Free/Pro 服务端额度、跨设备历史同步以及 iOS Safari / iPad 真机验收。源码与 Mock 不能证明这些生产结果。
