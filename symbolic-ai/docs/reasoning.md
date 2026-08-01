# Reasoning 边界

Reasoning 位于 Knowledge 之后、Response Planner 和 Personality 之前。它只读取
知识并产生可解释结论，不负责身份验证、持久化、UI、语气或网络调用。

## 当前公开行为

外部宿主可以依赖以下行为类别，但不能依赖内部规则名称或执行步骤：

1. 精确关系和直接事实优先。
2. `属于` 关系可以沿已知路径做传递推理。
3. 显式“为什么”问题可展示已存在的推理路径。
4. 兼容关系不存在精确答案时，可以使用既有 Relation fallback；fallback 只读，
   不新增事实。
5. 非 `属于` 关系保持既有直接事实边界，不因为宿主需求扩大推理范围。
6. 无已知答案、关系不支持或 Reasoner 异常时返回安全结果，不泄漏内部诊断。

## 分层职责

| 层 | 职责 | 禁止职责 |
|---|---|---|
| Reasoner | 根据查询和只读 Knowledge 产生结论、证据、冲突 | 写 Knowledge、选择语气 |
| Response Planner | 决定直接回答、解释或谨慎表达 | 重新推理、发明事实 |
| Personality | 渲染最终表达 | 修改结论、路径、置信度 |
| Provider | 调用 Engine 并呈现结果 | 选择规则、拼装推理结果 |

## 公开 SDK 边界

宿主使用 `engine.respond()` 或 `engine.process()` 获取最终回复。虽然 SDK 导出部分
Reasoning 类型供 TypeScript 组合使用，当前 Reasoner 实现、Relation Resolution
策略和 Planner 实现仍是内部模块，不能被 Web 或 Flutter 直接导入。

禁止依赖：

- `src/reasoners/*`
- `src/rules/*`
- `src/planner/*`
- 内部 rule ID、policy ID、路径搜索顺序或候选排序

## 兼容性约束

- 相同的公开输入和状态应保持确定性。
- Relation fallback 不得产生 Knowledge 或 Memory 写入。
- Personality 变化不得改变事实和推理结论。
- 内部算法可以重构，但公开契约测试覆盖的行为不能被无意改变。
