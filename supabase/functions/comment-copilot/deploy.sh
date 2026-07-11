#!/usr/bin/env bash
# ============================================================================
# comment-copilot（护福宝后端）一键部署脚本
# ----------------------------------------------------------------------------
# 用法：
#   cd 到本文件所在目录，或在项目根目录执行：
#     bash supabase/functions/comment-copilot/deploy.sh
#
# 说明：
#   - 通过 Supabase CLI 部署，会自动打包本函数目录下的所有文件
#     （index.ts / internet_context.ts / slang-dictionary.json），不会漏文件。
#   - 该函数 verify_jwt=false，故必须带 --no-verify-jwt。
#   - 部署前请确保已配置 openai_model_sonnet / openai_model_grok 两个 secret
#     （或环境变量 OPENAI_MODEL_SONNET / OPENAI_MODEL_GROK），否则会回退到
#     占位模型 ID，PackyCode 网关可能不认导致 400/502。
# ============================================================================

set -euo pipefail

PROJECT_REF="klyrasrqgxijwrxuoevj"
FUNCTION_NAME="comment-copilot"

# 切换到脚本所在目录，再回到项目根目录（supabase/ 的上级）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$PROJECT_ROOT"

echo "==> 项目根目录: $PROJECT_ROOT"

# 1. 检查 supabase CLI 是否可用
if ! command -v supabase >/dev/null 2>&1; then
  echo "❌ 未找到 supabase CLI。请先安装：https://supabase.com/docs/guides/cli"
  exit 1
fi

# 2. 检查登录状态（未登录则提示）
if ! supabase projects list >/dev/null 2>&1; then
  echo "⚠️  尚未登录 Supabase CLI，正在启动登录流程..."
  supabase login
fi

# 3. 部署
echo "==> 正在部署 Edge Function: $FUNCTION_NAME (project: $PROJECT_REF)"
supabase functions deploy "$FUNCTION_NAME" \
  --project-ref "$PROJECT_REF" \
  --no-verify-jwt

echo ""
echo "✅ 部署完成。"
echo "   后续验证："
echo "   1) Dashboard 查看 $FUNCTION_NAME 版本号是否 +1、状态 ACTIVE"
echo "   2) 前端 copilot.html 实测各 tone（幽默/火力全开 走 Grok，其余走 Sonnet）"
echo "   3) 若报 400/404，多半是 openai_model_sonnet / openai_model_grok 模型 ID 填错"
