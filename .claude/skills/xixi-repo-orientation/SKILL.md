---
name: xixi-repo-orientation
description: 快速建立霜蓝个人主页与 Sunland AI 仓库的架构认知。用于新任务接手、跨模块需求分析、影响面评估、代码路径定位或实施前方案设计；不用于已经明确到单一文件的机械文本修改。
---

# 霜蓝项目导览

先建立可验证的项目上下文，再提出方案或修改代码。

## 建立上下文

1. 完整读取 `docs/project_overview.md`、`CLAUDE.md` 和根目录 `AGENTS.md`。
2. 检查文档描述是否仍与当前目录、`package.json`、测试和调用点一致；把文档当作起点，不把可能过期的描述当作当前事实。
3. 使用 `rg` / `rg --files` 定位入口、调用方、共享模块和现有测试，避免无目标地扫描整个仓库。
4. 判断任务属于以下哪个边界：
   - 公开静态页面与共享设计系统；
   - `ai.html` / `ai/` 聊天子应用；
   - Supabase Auth 捐赠体系；
   - 自建 JWT 登录与 `api.sunland.dev` 契约；
   - Supabase Edge Functions、Cloudflare Functions / Workers；
   - 外部 `sunland-ai` 仓库及 `ai-core.sunland.dev` Symbolic Core 服务。
5. 明确仓库外部边界：`api.sunland.dev` 后端、`sunland-ai` 仓库和 Flutter 客户端不在本仓库，不能假设可同步修改。

## 评估风险

- 标记认证、会话持久化、API 格式、表单输入、路由、CORS、支付和会员权益为高风险区域。
- 区分两套登录体系；不要把 Supabase OAuth session 与 `localStorage.token` 自建 JWT 混用。
- 搜索共享文件的所有引用，再评估 `ai/app.js`、`p/css/*`、`p/js/*` 等公共入口的影响面。
- 找到已有实现和测试，优先复用，不复制逻辑或引入新框架。

## 输出工作地图

在实施前给出简短结论：

- 真实入口与关键调用链；
- 涉及文件与明确不涉及的边界；
- 风险等级及可能回归；
- 最小可行改动和验证方式；
- 尚未验证的外部假设。

仅在用户要求修改时进入实现；纯分析任务保持只读。
