# Semantic 边界

Semantic 层负责从输入中产生结构化理解候选，并由既有策略选择接受、澄清或安全
降级。它是 Symbolic Core 的内部组成部分，不是 Provider 可独立编排的服务。

## 对外可观察契约

外部宿主只能通过以下公开面影响 Semantic：

- `createSunlandEngine({ semanticMode })`
- `createSunlandEngine({ semanticContextMode })`
- `engine.respond(input)`
- `engine.process(input, options)`
- SDK 公开的三个 Context 辅助函数

候选、抽取证据、置信度、生产器、诊断和 Understanding Decision 都是内部实现。
宿主不能读取这些对象来实现第二套路由或写入规则。

## 模式

- `off`：关闭 Semantic 接纳，保留既有兼容路径。
- `passive`：生产默认集成模式。只接纳既有允许的只读理解与结构化澄清；写入仍
  经过 Core 既有安全边界。
- `shadow`：用于 Core 内部比较，不应被宿主解释为用户行为或能力开关。
- `semanticDebug`：默认关闭；启用时只保留隐私安全的最近摘要，不记录原始输入。

模式的算法含义由 Core 管理。Web 和 Flutter 不得在宿主代码中复制模式分支。

## 副作用边界

Semantic 分析本身不写 Knowledge 或 Memory。只有完整、明确且通过 Core 安全
门控的现有写入路径可以产生副作用。以下输入必须安全降级或澄清：

- 缺少必要槽位的教学；
- 否定或禁止写入的表达；
- 复合、冲突或歧义教学；
- 证据不足的姓名或事实；
- 无法解析的输入。

宿主不得根据关键词绕过该边界直接写 Knowledge 或 Memory。

## 用户可见边界

最终回复不得暴露 Parser、Intent、Candidate、Confidence、Reason Code、Policy ID
或诊断文本。用户可见表达只能来自 Engine 最终交给 Personality 的结果。

## 禁止的外部依赖

Provider 禁止直接导入：

- `src/semantic/analyze*`
- `src/semantic/candidates*`
- `src/semantic/understanding*`
- `src/semantic/engineAdapter*`
- `src/semantic/producers/*`
- 其他 `src/semantic/*` 实现

Context 辅助函数虽然实现于 Semantic 目录，也只能从 `src/sdk.ts` 或发布 Bundle
导入。
