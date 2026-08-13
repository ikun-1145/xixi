---
name: xixi-auth-data-safety
description: 保护霜蓝项目的认证、会话、Supabase、API、支付和用户数据边界。用于登录登出、OAuth、自建 JWT、localStorage、API 契约、RLS、数据库查询、Edge Functions、Realtime、支付对账、Pro 权益或 MCP 数据访问；所有 Supabase 任务都应使用。
---

# 霜蓝认证与数据安全

把认证、数据和权益改动视为高风险工作，先证明兼容性再实施。

## 区分身份体系

1. 对捐赠与鸣谢流程使用体系 A：Supabase Auth OAuth session，由 Supabase SDK 管理本地 key。
2. 对 Sunland AI 使用体系 B：`api.sunland.dev` 签发的自建 JWT，存于 `localStorage.token` / `localStorage.user`。
3. 不使用 `auth.uid()` 假设解释体系 B 的 `user_id`，不把两套退出登录或刷新逻辑合并。
4. 把外部 AI 网关和 Flutter 客户端视为独立系统，只兼容已证实的契约。

## 执行安全流程

1. 完整读取相关登录、刷新、请求封装、数据客户端和测试，搜索所有调用方。
2. 明确输入、身份来源、权限边界、持久化位置、失败恢复和跨端兼容要求。
3. 保持现有 API 字段、token 格式、localStorage key、数据库 JSON 和跨端卡片字段不变，除非用户明确授权破坏性变更。
4. 不把 service role、PAT、OAuth secret、模型 key 或环境变量值写入前端、日志、文档或仓库配置。
5. 对支付与 `user_profiles.pro` 保持幂等；不在普通功能修改中触发真实订单、权益或生产部署。

## 使用 Supabase MCP

- 优先使用项目 `.codex/config.toml` 中已限定 `project_ref` 的只读连接。
- 先用文档、表结构、日志和 Advisor 进行只读诊断；不要把 MCP 可调用性当作生产写入授权。
- 不擅自启用 RLS、改 schema、执行迁移、部署 Edge Function 或修改 Auth 配置。
- 需要写操作时，先说明影响、回滚方案和兼容风险，等待用户明确授权，并使用可审查的迁移或部署流程。
- 记住现有部分表关闭 RLS 是历史架构约束，不用“一键开启 RLS”代替完整身份设计。

## 验证安全性

- 覆盖 token 过期、刷新失败、重复请求、网络抖动、空 session、跨账号数据和权限拒绝路径。
- 运行最相关的认证、恢复、请求上下文、登出和数据测试；影响公共逻辑时运行 `npm test`。
- 检查浏览器 Network / Console 与服务端日志，但不要输出凭据或完整用户数据。
- 明确哪些验证只在本地完成，哪些仍需测试环境或真实 OAuth 流程。
