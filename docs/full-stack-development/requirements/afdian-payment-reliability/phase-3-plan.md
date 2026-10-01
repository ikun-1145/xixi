# Phase 3 实施与实验记录

授权：仅本地候选与独立 synthetic PostgreSQL lab，不部署、不写生产、不提交。

## Design A / B

A 保存 paid + INTENT_NOT_FOUND，provider 故障时即使 intent 后来出现也无法恢复。B 保存已验证 reference 与验证时间，可以在同一可信快照的15分钟窗口重试本地绑定；到期必须重新查询，不续期缓存。选择 B。

安全边界：reference 只由服务角色 v2 trusted observation 写入；旧 RPC/webhook hint 无权限写该字段。第一份已验证 reference 固定，后续变化记 BINDING_CONFLICT。owner、profile状态、intent在事务锁内重新校验。注销在删除 intent 之前用 reference 找到关联订单，清 reference/验证时间，记录 DATA_DELETED 并终止自动重试。保存最小字段，无完整provider payload。15分钟窗口不是provider无退款保证，残留风险显式记录。

## 最小实施顺序

UUID回归先红后绿 → provider policy/共享query测试 → 新migration静态检查 → 独立lab迁移 → 真角色ACL → 集成 → PG多会话/锁 → 八点crash/commitunknown → 前端三态/ABA → 原有全量回归。

Worker与lab由主代理负责；新migration与SQL静态检查由backend_guardian负责；前端由frontend_engineer负责；安全审查只读。互不覆盖文件，HEAD与hash漂移先重读。

普通profile编辑权限、激活码既有禁用状态与非支付Pro保持。实际手工函数名与Phase2设计文档不一致，以本轮生产catalog为准。新v2兼容旧pro_activations(source=payment)归属。

自动生命周期MCP不可用，使用本文件和测试报告记录人工阶段证据，不宣称工具自动门禁通过。
