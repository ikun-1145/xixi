# Sunland AI 项目工作流初始化

用户于本任务明确批准非破坏性初始化及 Phase 1。本文件记录已知要求，不启动自动任务。

- 项目：现有原生 HTML/CSS/JavaScript 网站，Cloudflare Workers，Supabase Postgres。
- 平台：Codex；复用 `.codex/agents/*.toml`，不安装重复专家，不修改全局插件。
- 约束：当前分支工作，保留并发修改；禁止生产部署、数据库迁移、真实短信、凭证创建、Flutter 修改。
- 认证：现有 `user_profiles.user_id`、应用 JWT 和独立数据库令牌保持兼容。
- 当前任务：手机号认证 Phase 1，仅短信基础能力、原子费用保护、用途隔离及 Mock 测试。
- 路由：architect/planner 使用 system_architect；code-reviewer/python-reviewer/debugger 使用 qa_reviewer；security-reviewer/compliance-reviewer 使用 security_reviewer；backend-guardian 使用 backend_guardian。orchestrator 为主会话。
- 生成器：RBraga01/a-team `8bc79e3872cea7562f28fff7e7dbaab2b38601fa` 的 `scripts/roster.py`；v1.4.1 标签缺少该脚本，使用已核对的官方后续提交，仅适配现有 Codex/插件库存。原始 MIT 许可保存在 `.agent-sync/A-TEAM-LICENSE.txt`。
- Python：3.11+（标准库 tomllib）；无新依赖、钩子、CI/CD 或生产配置。
- 验证：`python3 scripts/roster.py verify`，`check Agent <name>`，`check Skill <name>`；`node --test tests/agent-roster.test.mjs`。
- 名单由生成器同时生成 TEAM.md 和 ROUTING.md；禁止手改名单、覆盖历史配置或自动替换。技能版本缺失时关闭派发，恢复相同插件版本后重新验证。
