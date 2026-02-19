// checkLogin.js
import { supabase } from './supabaseClient.js'

// 检查用户是否已登录
async function checkLoginAndRedirect() {
  const {
    data: { session },
    error
  } = await supabase.auth.getSession()

  if (error) {
    console.error('获取会话失败:', error)
    alert('发生错误，请稍后再试。')
    return
  }

  if (!session) {
    const confirmLogin = confirm('您需要登录后才能进入该页面，是否现在登录？')
    if (confirmLogin) {
      supabase.auth.signInWithOAuth({
        provider: 'github',
        options: {
          redirectTo: `${window.location.origin}/donate.html`
        }
      })
    } else {
      // 用户取消登录，可以重定向回主页或不做操作
      window.location.href = 'index.html'
    }
  } else {
    console.log('已登录用户:', session.user)
    // 如果已登录，不执行任何操作，继续显示当前页面
  }
}

// 页面加载时执行检查
document.addEventListener('DOMContentLoaded', () => {
  checkLoginAndRedirect()
})
