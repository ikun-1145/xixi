# Codex Agent 工作环境

本仓库把 Codex 配置分成四层：根目录 `AGENTS.md` 负责长期工程规则，`.agents/skills/` 负责可复用工作流，`.codex/agents/` 负责专业角色，`.codex/config.toml` 负责项目级 MCP。

## 团队分工

| 角色 | 权限 | 职责 |
|---|---|---|
| 主 Agent | 按当前会话权限 | 理解需求、拆分任务、集成改动、最终验收 |
| `system_architect` | 只读 | 架构、调用链、风险和最小方案 |
| `frontend_engineer` | 工作区写入 | 原生前端、移动端、PWA、多语言实现 |
| `backend_guardian` | 工作区写入 | Supabase、Edge Function、Worker、API 契约 |
| `qa_reviewer` | 只读 | 测试、回归、竞态和发布门禁 |
| `security_reviewer` | 只读 | 认证、权限、密钥、XSS、CORS、支付和数据暴露 |

默认让主 Agent 处理小修复。复杂任务最多并行三个子 Agent，并优先并行只读分析；同一文件不能交给多个写入 Agent。

## 安装命令

在仓库根目录执行：

```bash
cd /Users/liuxize/Developer/xixi
npm ci
codex --version
codex mcp list
```

项目 Skills 和自定义 Agent 已随仓库提供，不需要复制到用户目录。首次使用远程 MCP 时完成认证：

```bash
codex mcp login supabase
codex mcp login cloudflare
```

GitHub MCP 在 Codex 中使用环境变量读取最小权限 PAT；不要把令牌写入 `.codex/config.toml` 或提交到仓库：

```bash
export GITHUB_PAT_TOKEN="<your-least-privilege-github-pat>"
codex mcp list
```

`openai_docs` 不需要登录。认证或环境变量变化后，重启 Codex 或新建任务，使配置与 Skills 重新加载。

## 验证命令

```bash
git diff --check
npm test

SKILL_VALIDATOR="${CODEX_HOME:-$HOME/.codex}/skills/.system/skill-creator/scripts/quick_validate.py"
for skill_dir in .agents/skills/*; do
  python3 "$SKILL_VALIDATOR" "$skill_dir"
done

python3 - <<'PY'
import pathlib
import tomllib

paths = [pathlib.Path('.codex/config.toml'), *pathlib.Path('.codex/agents').glob('*.toml')]
for path in paths:
    with path.open('rb') as handle:
        tomllib.load(handle)
    print(f'OK {path}')
PY
```

在 Codex CLI 中可用 `/mcp` 查看 MCP，用 `/agent` 查看子 Agent。也可以直接使用仓库 Skill，例如：

```text
使用 $xixi-repo-orientation 分析这项需求的影响面。
使用 $xixi-frontend-workflow 修复移动端交互，并在完成后运行 $xixi-release-gate。
请让 system_architect、qa_reviewer 和 security_reviewer 并行审查这次跨模块改动，再由主 Agent 汇总。
```

## MCP 安全边界

- Supabase 固定到项目 `klyrasrqgxijwrxuoevj`，默认 `read_only=true`，只开放数据库、调试、文档和函数读取相关工具组。
- Cloudflare 与 GitHub 写工具要求确认；未收到明确发布请求时，不部署、不推送、不改外部状态。
- 所有 MCP 都是可选依赖，网络或登录失败不会阻止本地编码。
- 数据库迁移、RLS、Auth、生产部署、真实支付和会员权益变更仍需用户逐项明确授权。
