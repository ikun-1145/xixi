-- ============================================================================
-- comment-copilot（护福宝）双模型 ID 配置
-- ----------------------------------------------------------------------------
-- 在 Supabase Dashboard → SQL Editor 执行本文件即可。
-- 作用：把两个逻辑模型别名映射到 PackyCode 网关的实际模型 ID。
--   sonnet → claude-sonnet-5  （负责 和解/礼貌/理性/阴阳/毒舌）
--   grok   → grok-4.5         （负责 幽默/火力全开）
-- 覆盖优先级：环境变量 OPENAI_MODEL_SONNET / OPENAI_MODEL_GROK
--             > 本表 openai_model_sonnet / openai_model_grok
--             > 代码兜底默认值
-- ============================================================================

insert into comment_copilot_secrets (key, value) values
  ('openai_model_sonnet', 'claude-sonnet-5'),
  ('openai_model_grok',   'grok-4.5')
on conflict (key) do update set value = excluded.value;

-- 确认结果（应能看到上述两个 key）
select key, value from comment_copilot_secrets order by key;
