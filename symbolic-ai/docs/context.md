# Conversation Context 契约

Context 用于跨轮指代和查询补全。它不是聊天历史、Memory 或 Knowledge，也不包含
用户身份。

## 所有权

- Core 负责规范化快照、读取当前轮所需信息并产生乐观更新。
- Provider/宿主负责把快照绑定到原始用户和原始会话。
- Core 不使用模块级状态保存 Context。
- Web 与 Flutter 共享相同 JSON 格式，但可以使用不同宿主持久化实现。

## Envelope

```ts
{
  schemaVersion: 1;
  version: number;
  recentTurns: readonly SemanticTurnSummary[];
}
```

快照只保留有限的 turn ID、概念、实体引用、焦点关系和查询形状。它不应包含原始
输入、账号资料、token、完整回复、Memory 记录或 Knowledge 记录。

## 唯一处理流程

```ts
import {
  applySemanticContextUpdate,
  createEmptySemanticContext,
  createSunlandEngine,
  normalizeSemanticContext,
} from "./src/sdk";

const engine = createSunlandEngine({ semanticContextMode: "enabled" });
let context = normalizeSemanticContext(restoredValue);

const result = engine.process("它会什么", {
  semanticContext: context,
  turnId: requestId,
  canCommitSemanticContext: () => requestStillOwnsConversation(),
});

context = applySemanticContextUpdate(
  context,
  result.semanticContextUpdate,
);
```

宿主不得复制 `normalizeSemanticContext()` 或
`applySemanticContextUpdate()` 的实现。

## 乐观并发

更新包含 `baseVersion`。只有原请求仍然有效、用户身份未变化、目标会话未删除且
版本匹配时才允许提交。取消、切换会话、退出登录或迟到结果都必须丢弃更新。

Core 的 `canCommitSemanticContext` 是最后一道提交检查，但宿主仍需把结果写回原始
请求捕获的会话，而不是当前 UI 正在显示的会话。

## 损坏数据

恢复值必须视为不可信输入并交给 `normalizeSemanticContext()`。无效 envelope、
非法版本或损坏 turn 会安全归一化；宿主不能因为格式损坏而绕过规范化。

## 兼容性

- 持久化字段 `semanticContext` 是 Web/Flutter 的既有外部数据键。
- Adapter 可以在本地使用 `contextSnapshot` 等不透明命名，但不能改变 Bridge 或
  云端 JSON 格式。
- `schemaVersion` 变化需要显式迁移和跨端兼容设计。
