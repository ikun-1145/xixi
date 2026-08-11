// supabaseClient.js
// Supabase 运行时由页面从同源 p/vendor 加载，避免外部 CDN 不可用时阻塞页面启动。
const createClient = globalThis.supabase?.createClient

if (typeof createClient !== 'function') {
  throw new Error('Supabase browser runtime is unavailable')
}

// Supabase 项目配置信息
const SUPABASE_URL = 'https://klyrasrqgxijwrxuoevj.supabase.co'
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_4ZIHfHr8wI0QFusEf_m7wA_pthBhxsI'

// Supabase Auth 客户端：仅负责 OAuth / Session，不能配置自定义 accessToken。
export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true
  }
})

// AI 数据客户端：只携带 Sunland 短期数据库 Token，不访问 supabase.auth。
export const supabaseData = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  accessToken: () => globalThis.SunlandDatabaseToken?.get() ?? null
})
