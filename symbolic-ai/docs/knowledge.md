# Knowledge 与 Memory 边界

## 三类状态

Sunland Core 明确区分三类状态：

| 状态 | 内容 | 所有者 |
|---|---|---|
| Knowledge | 用户教给 Core 的世界事实三元组 | Core，按宿主 namespace 持久化 |
| Memory | 关于当前用户的受限记忆，例如名字 | Core，按宿主 namespace 持久化 |
| Conversation Context | 最近跨轮指代所需的最小快照 | 宿主会话 |

聊天 transcript 不属于以上任一 Core 状态，Core 不接收 LLM 式完整历史窗口。

## Knowledge 数据模型

事实采用结构化三元组：

```ts
{
  subject: string;
  relation: string;
  object: string;
  negated: boolean;
}
```

Knowledge 不是自由文本，也不是 Prompt。记录还包含来源、置信度和创建时间，用于
审计与推理，但宿主不得自行伪造内部推理记录。

## 教学契约

- 只有明确、完整、非冲突且通过 Core 安全门控的陈述可以写入。
- 查询、否定教学、复合问题和不完整表达不能被宿主转换成写入。
- 教学后的事实可以在同一隔离状态中被查询和推理。
- Relation fallback 和 Context 补全是只读操作。

## Memory 契约

Memory 保存关于用户的受限键值记录，与世界知识严格分离。当前公开行为包括姓名
记忆与回忆。Provider 不得把账号资料、邮件、token 或完整聊天历史自动写入
Memory。

## Self Knowledge

Core 身份事实位于独立的 Self Knowledge 中：

- 它不属于用户 Knowledge；
- 不写入宿主持久化；
- 不计入新用户的空 KnowledgeStore；
- Identity 回复由这些事实和 Personality 共同生成。

因此 Web 和 Flutter 不得在 Prompt、Dart 或 Provider 中定义第二份 Sunland/Frost
身份事实。

## 持久化与隔离

Core 只接受宿主注入的 `StorageAdapter`：

```ts
interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
```

宿主必须先验证身份，再生成稳定且彼此隔离的 storage key。Core 不解析 user ID，
也不提供匿名共享 namespace。

## 外部调用规则

宿主可以从统一 SDK 使用 `createSunlandEngine()`、`createKnowledgeStore()` 或公开
类型，但不能直接导入 `src/knowledge/*`、`src/memory/*`、持久化实现或内部
Self Knowledge 文件。
