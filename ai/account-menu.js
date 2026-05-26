// ===== 用户菜单功能 =====
const settingsBtn = document.getElementById("settingsBtn");
const logoutBtn = document.getElementById("logoutBtn");

if (settingsBtn) {
  settingsBtn.onclick = () => {
    window.location.href = "ai_settings.html";
  };
}

if (logoutBtn) {
  logoutBtn.onclick = () => {
    if (!confirm("确定退出登录？")) return;

    localStorage.removeItem("token");
    localStorage.removeItem("user");

    location.reload();
  };
}
window.addEventListener("error", hideLoadingFromClassic);
window.addEventListener("unhandledrejection", hideLoadingFromClassic);
window.addEventListener("load", () => {
  document.body.classList.remove("preload");
});
