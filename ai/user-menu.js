// === User menu avatar dropdown logic ===
function hideLoadingFromClassic() {
  if (typeof window.hideLoading === "function") window.hideLoading();
  if (typeof window.hideGlobalLoading === "function") window.hideGlobalLoading();
}

const avatar = document.getElementById("avatarBtn");
const menu = document.getElementById("userMenu");

if (avatar && menu) {
  avatar.onclick = (e) => {
    e.stopPropagation();
    // ⭐ 全局缓存 Turnstile
    window.__cfToken = window.__cfToken || "";
    window.__cfWidgetId = window.__cfWidgetId || null;
    // ⭐ 更可靠：用 session 判断（避免 localStorage 不一致）
    if (!window.session || !window.session.user) {
      if (typeof window.goToLogin === "function") {
        window.goToLogin();
      } else {
        // 兜底：直接跳转登录页并携带来源页
        location.href = "login.html?return=ai.html";
      }
      return;
    }
    // ⭐ 已登录 → 打开菜单
    menu.classList.toggle("show");
  };

  document.addEventListener("click", (e) => {
    if (!avatar.contains(e.target) && !menu.contains(e.target)) {
      menu.classList.remove("show");
    }
  });
}
window.addEventListener("error", hideLoadingFromClassic);
window.addEventListener("unhandledrejection", hideLoadingFromClassic);
