# Provider 集成指南

Provider 是宿主与公开 SDK 之间的 Adapter，不是第二个 AI Core。

## Provider 职责

Provider 必须负责：

1. 验证当前身份，并确认会话 owner 与身份一致；
2. 为每个已验证用户提供隔离的 storage namespace；
3. 从消息中提取本轮用户输入；
4. 调用 `engine.process()`；
5. 把 Context 更新提交回原始会话；
6. 处理 abort、迟到结果和 UI 增量回调；
7. 将最终 `response` 原样交给宿主渲染。

Provider 不得负责：

- 解析 Intent 或 Semantic Candidate；
- 选择 Reasoner、Rule 或 Planner 策略；
- 写入 Knowledge 或 Memory；
- 定义 Frost/Sunland 公共身份；
- 根据输入关键词伪造 Core 回复；
- 回退到另一套 AI 模型并把结果冒充 Sunland Core。

## Web 集成

Web 只能从发布 Bundle 导入：

```js
import { createSunlandEngine } from "../vendor/sunland-core.js";

const engine = createSunlandEngine({
  storage: { adapter: window.localStorage, key: verifiedStorageKey },
  semanticMode: "passive",
  semanticDebug: false,
  semanticContextMode: "enabled",
});
```

生产 Web Provider 应按已验证用户缓存一个共享 Engine。不同会话共享该用户的
Knowledge/Memory，但各自持有 Context 和 transcript。

## Flutter 集成

Flutter 不得把 Core 业务逻辑翻译成 Dart。推荐边界：

```text
Flutter UI -> SunlandLocalProvider -> SunlandCoreClient
           -> JavaScript Runtime Adapter -> sunland-core.js
```

`SunlandCoreClient` 对 UI 只暴露输入、请求 ID、不透明状态快照和最终文本。具体
JavaScript Bridge 可以使用 SDK 的公开函数，但 Semantic、Reasoner、Knowledge
等内部名称不能扩散到 Dart UI。

替换 WebView 时只替换 Runtime Adapter；Provider、会话格式以及 Core 本身不变。

## Context 提交流程

Provider 应在请求开始时捕获：

- verified user ID；
- conversation ID 和 owner；
- Context version；
- request/turn ID；
- abort signal。

只有这些边界仍然成立时，才提交 `semanticContextUpdate`。具体流程见
[Context 契约](./context.md)。

## Bundle 与版本

- Web 与 Flutter 必须使用同一次 release 产生的 Bundle。
- manifest SHA-256、字节数和版本应在构建或初始化时校验。
- 不一致只记录结构化诊断，不读取用户身份，也不阻塞现有聊天流程。
- 禁止手工复制、局部重建或修改已发布 Bundle。

## DeepSeek 边界

DeepSeek 是独立 Provider。它的模型 Prompt 只能包含模型调用所需规则，不能复制
Sunland/Frost 身份、Knowledge、Memory 或 Reasoning 公共事实。Sunland 对话开始
后，宿主不得在同一会话中切换为 DeepSeek。
