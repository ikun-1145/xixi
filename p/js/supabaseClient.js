// supabaseClient.js
// Supabase 运行时由页面从同源 p/vendor 加载，避免外部 CDN 不可用时阻塞页面启动。
const createClient = globalThis.supabase?.createClient

if (typeof createClient !== 'function') {
  throw new Error('Supabase browser runtime is unavailable')
}

// Supabase 项目配置信息
const SUPABASE_URL = 'https://klyrasrqgxijwrxuoevj.supabase.co'
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_4ZIHfHr8wI0QFusEf_m7wA_pthBhxsI'

// 创建并导出 Supabase 客户端
export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  accessToken: () => globalThis.SunlandDatabaseToken?.get() ?? null,
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true
  }
})
