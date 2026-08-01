# 安全边界

## 信任模型

Sunland Core 是确定性的本地符号 Core，但不是认证系统或权限系统。

| 数据/组件 | 信任状态 | 责任方 |
|---|---|---|
| 用户输入 | 不可信 | Core 解析和安全降级 |
| 恢复的 Context | 不可信 | SDK 规范化 |
| StorageAdapter 内容 | 不可信持久化数据 | Core 加载器校验，宿主隔离 key |
| verified identity | Core 不可见 | Web/Flutter 宿主 |
| conversation owner | Core 不可见 | Provider |
| SDK Bundle/manifest | 发布产物 | release 流程与宿主校验 |
| UI 渲染 | Core 外部 | 宿主转义和安全渲染 |

## 身份与状态隔离

Core 不读取 token、邮箱、Supabase Session、Flutter 账号对象或浏览器用户缓存。
Provider 必须在创建/访问 Engine 前验证身份，并拒绝空、匿名、共享或归属不一致的
namespace。

Knowledge 和 Memory 的持久化 key 必须按已验证用户隔离；Context 还必须按会话
隔离。身份变化时，旧请求不得提交状态。

## 输入与副作用安全

- Core 必须把输入视为不可信文本。
- 不完整、否定、歧义、复合或明确禁止的教学不能产生状态写入。
- Semantic 候选不直接执行写入。
- 未知输入和内部异常必须安全降级。
- 用户回复不能暴露内部诊断、策略 ID、候选、置信度或堆栈。

Provider 不得添加绕过以上边界的关键词写入逻辑。

## 数据最小化

Context 只保存跨轮解析所需的有限结构；Observation Summary 只允许固定白名单和
分桶值。两者都不得包含原始输入、用户 ID、邮箱、token、完整知识或完整记忆。

完整性日志只允许记录固定事件名、错误码、资源名、预期/实际 hash、字节数或版本。

## 依赖边界

可发布 SDK 不得依赖：

- React、Cytoscape 或其他 UI 框架；
- DOM、WebView 或 Flutter SDK；
- Supabase、HTTP 客户端或外部 AI Provider；
- 宿主认证、路由、localStorage 全局或会话管理；
- App/UI 文件和开发演示代码。

宿主也不得导入 Core 内部文件。唯一允许的运行时边界是发布的
`sunland-core.js`。

## Bundle 完整性

`release:core` 生成一次 Bundle，并同步相同字节和 SHA-256 manifest。完整性检查
应覆盖：

- artifact 名称；
- 文件字节数；
- SHA-256；
- manifest version 与 `SUNLAND_CORE_VERSION`。

本地 hash 校验用于发现发布漂移，不等同于数字签名。如果 Bundle 和 manifest
同时被恶意替换，仍需依赖可信构建、部署权限和供应链保护。

## 明确不属于 Core 的安全职责

- 登录、token 刷新和账号权限；
- 云端数据库 RLS；
- 网络 TLS 与 API 鉴权；
- Markdown/HTML/XSS 过滤；
- 文件上传检查；
- Flutter/Web UI 生命周期；
- 付费和用量限制。

这些职责必须由宿主实现，但不能以安全为由复制或改写 Core 算法。
