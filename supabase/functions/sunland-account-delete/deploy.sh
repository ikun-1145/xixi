#!/usr/bin/env bash
# ============================================================================
# sunland-account-delete 部署脚本
# ----------------------------------------------------------------------------
# 该函数使用 x-sunland-token + OTP 自校验身份，不依赖 Supabase Auth JWT，
# 因此必须带 --no-verify-jwt。
#
# 部署前请配置 Secret，不要把值写入仓库：
#   supabase secrets set SUNLAND_ACCOUNT_DELETE_INTERNAL_TOKEN=...
# ============================================================================

set -euo pipefail

PROJECT_REF="klyrasrqgxijwrxuoevj"
FUNCTION_NAME="sunland-account-delete"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$PROJECT_ROOT"

if ! command -v supabase >/dev/null 2>&1; then
  echo "❌ 未找到 supabase CLI。请先安装：https://supabase.com/docs/guides/cli"
  exit 1
fi

if ! supabase projects list >/dev/null 2>&1; then
  echo "⚠️  尚未登录 Supabase CLI，正在启动登录流程..."
  supabase login
fi

echo "==> 正在部署 Edge Function: $FUNCTION_NAME (project: $PROJECT_REF)"
supabase functions deploy "$FUNCTION_NAME" \
  --project-ref "$PROJECT_REF" \
  --no-verify-jwt

echo ""
echo "✅ 部署完成。"
echo "   后续请确认以下 Secret 已配置且未进入仓库："
echo "   - SUNLAND_ACCOUNT_DELETE_INTERNAL_TOKEN"
