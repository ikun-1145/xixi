# Sunland Core SDK

## 入口

源码级公开入口：

```ts
import { createSunlandEngine } from "./src/sdk";
```

生产宿主必须使用发布产物：

```js
import { createSunlandEngine } from "./sunland-core.js";
```

禁止从 `src` 的其他路径或 Bundle 内部符号导入实现。

## 最小调用

```ts
import { createSunlandEngine } from "./src/sdk";

const engine = createSunlandEngine({
  semanticMode: "passive",
  semanticContextMode: "enabled",
});

const reply = engine.respond("你好");
```

`respond(input)` 适合无上下文的单轮调用。需要跨轮 Context、取消提交或观察摘要
时使用 `process(input, options)`。

## 主接口

### `createSunlandEngine(options?)`

创建一个 Core 实例。主要公开选项：

| 选项 | 作用 |
|---|---|
| `storage` | 注入宿主实现的 `StorageAdapter` 和隔离后的 key |
| `personalityId` | 选择已注册的人格；默认人格由 Core 决定 |
| `parser` | 注入通过 SDK 创建或实现的 Parser |
| `knowledgeStore` | 注入通过 SDK 创建或实现的 KnowledgeStore |
| `memory` | 注入符合公开类型契约的 MemoryManager |
| `semanticMode` | Semantic 发布模式；生产集成使用 `passive` |
| `semanticContextMode` | `off` 或 `enabled` |
| `semanticDebug` | 显式启用内存内 Shadow 摘要；默认关闭 |
| `observationRuntime` | 测试或宿主提供的纯运行时接缝 |

宿主不应注入 Core 内部实现，也不应根据这些选项重新实现解析或推理分支。

### `engine.respond(input)`

- 返回最终用户文本。
- 同步完成。
- Core 对无法理解的输入安全降级，不向用户暴露内部诊断。
- 显式教学或记忆输入可能更新注入的状态。

### `engine.process(input, options?)`

返回：

```ts
{
  response: string;
  semanticContextUpdate: SemanticContextUpdate;
  observationSummary?: ObservationSummary;
}
```

主要选项：

- `semanticContext`：宿主持有的、不可信可序列化快照。
- `turnId`：宿主稳定请求 ID。
- `canCommitSemanticContext`：提交前的取消、身份和原会话检查。
- `observationMode`：默认 `off`；仅显式 `summary` 时返回白名单摘要。

## Context 辅助函数

SDK 公开以下函数：

- `createEmptySemanticContext()`
- `normalizeSemanticContext(value)`
- `applySemanticContextUpdate(current, update)`

它们是宿主处理 Context 的唯一入口。宿主不得复制 schema 规范化或更新合并逻辑。

## 其他公开面

`src/sdk.ts` 还统一导出：

- Knowledge、Parser、Personality、Observation、Storage 的公开工厂、常量和类型；
- Engine 公开接口与选项；
- `src/types` 中仅编译期使用的公共类型；
- `SUNLAND_CORE_VERSION` 及公开 schema 版本常量。

“从 SDK 导出”只表示可以从统一入口使用，不表示内部文件路径稳定。

## 发布与版本

版本分类、破坏性变更定义和 v0.1 阶段政策见
[`versioning.md`](./versioning.md)；实际发布按
[`release-checklist.md`](./release-checklist.md) 执行。

```bash
npm run release:core
npm run check:core-release
```

`release:core` 按固定顺序执行：严格类型检查、全量 Core 测试、单次 Bundle
构建、Web/Flutter 原子同步、manifest 生成、字节/hash/运行时版本复核，
以及 release report 生成。机器可读报告位于
`dist/core/sunland-core.release-report.json`；它只记录版本、相对产物路径、hash、
字节数和一致性结果，不包含用户数据。
发布脚本还会校验 `contracts/sdk-api-surface.v0.1.0.json` 中的精确运行时
导出基线，任何删除、重命名或意外新增都会阻断发布。

宿主可将 manifest `version` 与运行时 `SUNLAND_CORE_VERSION` 比较。版本或 hash
不一致应记录诊断，但不得静默切换到另一套 Core。

## 契约测试

```bash
npm run test:contract
```

契约测试只从 `src/sdk.ts` 导入被测对象，保护 Greeting、Identity、Memory、
Knowledge teaching、Relation fallback、Context follow-up 和 Safety boundary；恢复契约另外
覆盖 Knowledge/Memory 持久化重建、损坏存储降级、Context 序列化恢复与迟到更新拒绝。
API Surface 契约另外锁定 v0.1.0 的 70 个运行时导出、Core/schema 版本常量以及
主要 Engine、Storage 和 Context Adapter 的 TypeScript 签名。
