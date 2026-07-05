// ===== PWA Service Worker 注册 + 更新检测 =====
if ('serviceWorker' in navigator && location.protocol === 'https:' && location.hostname !== '127.0.0.1') {
  navigator.serviceWorker.register('/sw.js')
    .then(reg => {

      // ⭐ 强制定期检查更新（解决不触发问题）
      setInterval(() => {
        reg.update();
      }, 60 * 1000);

      // ⭐ 监听更新
      reg.onupdatefound = () => {
        const newWorker = reg.installing;
        if (!newWorker) return;

        newWorker.onstatechange = () => {
          if (newWorker.state === 'installed') {

            // 有旧版本在控制（说明是更新）
            if (navigator.serviceWorker.controller) {

              // ⭐ 如果已经进入 waiting
              if (reg.waiting) {
                showUpdateTip();

                // ⭐ 直接激活新版本
                reg.waiting.postMessage({ type: "SKIP_WAITING" });
              }
            }
          }
        };
      };

      // ⭐ 当新SW接管后自动刷新
      let hadController = !!navigator.serviceWorker.controller;
navigator.serviceWorker.addEventListener("controllerchange", () => {
  if (hadController) location.reload();
  hadController = true;
});

    })
    .catch(err => {
      console.warn('SW 注册失败:', err);
    });
}

// ===== 更新提示UI =====
function showUpdateTip() {
  const box = document.createElement("div");

  box.innerHTML = `
    <div style="
      position:fixed;
      bottom:160px;
      left:50%;
      transform:translateX(-50%);
      background:linear-gradient(135deg,#22d3ee,#67e8f9);
      color:#00323a;
      padding:10px 16px;
      border-radius:14px;
      font-size:13px;
      z-index:9999;
      box-shadow:0 10px 30px rgba(0,0,0,0.25);
      cursor:pointer;
      animation: fadeInBubble .25s ease;
    ">
      🔄 正在更新…
    </div>
  `;

  document.body.appendChild(box);

  // ⭐ 自动刷新（更像原生App）
  setTimeout(() => {
    location.reload();
  }, 1200);
}
// ===== iOS 非 Safari 引导（高级版）=====
const isIOSDevice = /iphone|ipad|ipod/i.test(navigator.userAgent);
const ua = navigator.userAgent.toLowerCase();
const isSafariBrowser =
  ua.includes("safari") &&
  !ua.includes("crios") &&
  !ua.includes("fxios") &&
  !ua.includes("micromessenger") &&
  !ua.includes("qq");

if (isIOSDevice && !isSafariBrowser && !window.navigator.standalone) {
  window.addEventListener("load", () => {
    setTimeout(() => {
      // 遮罩层
      const overlay = document.createElement("div");
      overlay.style.cssText = `
    position:fixed;
    inset:0;
    background:rgba(0,0,0,0.85);
    backdrop-filter:blur(16px);
    z-index:999999;
    display:flex;
    flex-direction:column;
    align-items:center;
    justify-content:flex-start;
    padding-top:120px;
    color:#fff;
    text-align:center;
  `;

      overlay.innerHTML = `
    <div style="font-size:17px;font-weight:700;margin-bottom:12px;">
      请在 Safari 中打开
    </div>

    <div style="font-size:13px;color:#ddd;line-height:1.7;margin-bottom:24px;">
      点击右上角「···」或分享按钮<br>
      选择 <b>“在 Safari 中打开”</b>
    </div>

    <div style="
      width:70px;
      height:70px;
      border-radius:50%;
      background:linear-gradient(135deg,#22d3ee,#67e8f9);
      display:flex;
      align-items:center;
      justify-content:center;
      font-size:28px;
      box-shadow:0 0 30px rgba(34,211,238,0.9);
      animation:pulseSafari 1.2s infinite;
    ">
      ↑
    </div>

    <div style="
      position:absolute;
      bottom:60px;
      font-size:12px;
      color:#aaa;
    ">
      无法自动跳转（iOS限制）
    </div>
  `;

      document.body.appendChild(overlay);
    }, 800);
  });
}
// ===== iOS 安装引导（PWA关键）=====
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const hideTip = localStorage.getItem("hidePwaTip");
if (isIOS && isSafariBrowser && window.navigator.standalone !== true && !hideTip) {
  window.addEventListener("load", () => {
    setTimeout(() => {
      const tip = document.createElement("div");

      tip.innerHTML = `
        <div style="
          position:fixed;
          bottom:120px;
          left:50%;
          transform:translateX(-50%);
          background:rgba(0,0,0,0.85);
          backdrop-filter:blur(14px);
          color:#fff;
          padding:12px 16px;
          border-radius:14px;
          font-size:13px;
          z-index:99999;
          box-shadow:0 12px 30px rgba(0,0,0,0.35);
          text-align:center;
          line-height:1.6;
        ">
          <div style="font-weight:600;margin-bottom:4px;">
            添加到主屏幕
          </div>
          <div style="font-size:12px;color:#ccc;">
            点击下方分享按钮 → 选择<br>
            <b>“添加到主屏幕”</b>
          </div>
          <div style="margin-top:8px;font-size:11px;color:#888;cursor:pointer;" id="pwaIgnore">
            不再提示
          </div>
        </div>
      `;

      document.body.appendChild(tip);

      // 点击忽略后永久不再提示
      tip.querySelector("#pwaIgnore").onclick = () => {
        localStorage.setItem("hidePwaTip", "1");
        tip.remove();
      };

      setTimeout(() => {
        tip.remove();
      }, 3000);
    }, 2000);
  });
}
// ⚠️ VDS 登录需要配合 /vds-callback.html 页面处理回调
// ===== ⭐ 全局API封装（使用本地token）=====
async function apiFetch(body, _retried = false) {
  let token = localStorage.getItem("token");

  // ⭐ 过期检测 + 自动续期
  function isExpired(tk) {
    try {
      const payload = JSON.parse(atob(tk.split(".")[1]));
      if (!payload.exp) return false;
      // 仅提前5秒判断过期，避免误杀
      return payload.exp * 1000 < Date.now() + 5000;
    } catch {
      return true;
    }
  }

  async function refreshToken() {
    try {
      const old = localStorage.getItem("token");
      if (!old) return null;
      // 防止并发刷新（简单锁）
      if (window.__refreshing) return null;
      window.__refreshing = true;

      const res = await fetch("https://api.sunland.dev/refresh", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + old
        }
      });

      if (!res.ok) {
        console.warn("refresh 失败:", res.status);
        window.__refreshing = false;
        return null;
      }

      const data = await res.json().catch(() => ({}));
      if (data?.token) {
        localStorage.setItem("token", data.token);
        if (data.user) {
          localStorage.setItem("user", JSON.stringify(data.user));
        }
        window.__refreshing = false;
        return data.token;
      }
    } catch (e) {
      console.warn("refresh token 失败:", e);
    }
    window.__refreshing = false;
    return null;
  }

  // 即使过期也尝试刷新（不要提前删除）
  if (token) {
    if (isExpired(token)) {
      const newToken = await refreshToken();
      if (newToken) token = newToken;
    }
  }

  const res = await fetch("https://api.sunland.dev", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "Authorization": "Bearer " + token } : {})
    },
    body: JSON.stringify(body)
  });

  // ⭐ 如果401 → 尝试刷新一次
  if (res.status === 401 && !_retried) {
    // 只重试一次，防止死循环
    const newToken = await refreshToken();

    if (newToken) {
      return apiFetch(body, true);
    }
    // refresh 失败才真正登出
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    alert("登录已过期，请重新登录");
    showLoginPrompt();
    return null;
  }

  // ⭐ fallback 401 guard after retry
  if (res.status === 401 && _retried) {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    alert("登录已过期，请重新登录");
    showLoginPrompt();
    return null;
  }

  return res;
}
/* ===== 页面进入动画触发 ===== */
document.body.classList.add("ai-entering");
setTimeout(() => {
  document.body.classList.remove("ai-entering");
}, 650);
function applyAutoTheme() {
  const hour = new Date().getHours();
  const isNight = hour >= 18 || hour < 6;
  document.body.classList.toggle('night', isNight);
}

applyAutoTheme();
setInterval(applyAutoTheme, 10 * 60 * 1000);

const chat = document.getElementById("chat");
const chatInner = document.getElementById("chatInner");
function isNearBottom() {
  return chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
}
const input = document.getElementById("input");

// ⭐ 防止移动端自动弹出键盘（iOS / Safari 修复）
window.addEventListener("load", () => {
  input.blur();

  // iOS 特殊处理：延迟再执行一次
  setTimeout(() => {
    input.blur();
  }, 100);
});

// ⭐ 阻止页面加载时被自动 focus
document.addEventListener("DOMContentLoaded", () => {
  if (document.activeElement === input) {
    input.blur();
  }
});
const fileInput = document.getElementById("fileInput");
const uploadBtn = document.getElementById("uploadBtn");
const previewBox = document.getElementById("uploadPreview");
let pendingFiles = [];

uploadBtn.onclick = async () => {
  if (!(await requireLoginForAction())) return;
  fileInput.click();
};

fileInput.onchange = async () => {
  if (!(await requireLoginForAction())) {
    fileInput.value = "";
    return;
  }

  showGlobalLoading(); // ⭐ 开始 loading

  const files = Array.from(fileInput.files);
  if (!files.length) {
    hideGlobalLoading();
    return;
  }

  for (const file of files) {
    handleFile(file);
  }

  fileInput.value = "";

  // ⭐ 防止闪一下就消失
  setTimeout(() => {
    hideGlobalLoading();
  }, 300);
};

// ===== 粘贴上传（Ctrl+V）=====
document.addEventListener("paste", async (e) => {
  const items = e.clipboardData.items;
  const files = [];

  for (const item of items) {
    if (item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }

  if (!files.length) return;

  if (!(await requireLoginForAction())) {
    e.preventDefault();
    return;
  }

  files.forEach(handleFile);
});

// ===== 拖拽上传 =====
chat.addEventListener("dragover", (e) => {
  e.preventDefault();
});

chat.addEventListener("drop", async (e) => {
  e.preventDefault();
  const files = Array.from(e.dataTransfer.files);
  if (files.length && !(await requireLoginForAction())) return;
  files.forEach(handleFile);
});
function startActivationPolling() {
  let count = 0;

  const timer = setInterval(async () => {
    count++;

    // 最多轮询 3 分钟（覆盖爱发电 worker 的 cron 周期）
    if (count > 60) {
      clearInterval(timer);
      showToast("开通处理中，付款成功后约 1-2 分钟自动生效，可稍后刷新页面");
      return;
    }

    if (!session?.user) return;

    // ⭐ 统一判定：checkActivation 以 user_profiles.pro 为准（爱发电 worker 写入），
    //    并兼容激活码兑换。检测到即解锁 Pro 并关闭弹窗。
    await checkActivation();

    if (isActivated) {
      showToast("支付成功 🎉");

      // ⭐ 自动关闭支付弹窗
      const payModal = document.getElementById("payModal");
      if (payModal) {
        payModal.classList.add("closing");
        setTimeout(() => payModal.remove(), 200);
      }

      clearInterval(timer);
    }
  }, 3000);
}

function showError(title, extra = {}) {
  const box = document.createElement("div");

  const detail = `
错误类型: ${title}
状态码: ${extra.code || "未知"}
详情: ${extra.detail || "无"}
时间: ${new Date().toLocaleString()}
设备: ${navigator.userAgent}
`;

  box.innerHTML = `
    <div style="
      position:fixed;
      left:50%;
      top:20%;
      transform:translateX(-50%);
      background:rgba(255,255,255,0.95);
      backdrop-filter:blur(16px);
      padding:16px;
      border-radius:14px;
      width:90%;
      max-width:360px;
      z-index:99999;
      box-shadow:0 20px 60px rgba(0,0,0,0.3);
      font-size:13px;
    ">
      <div style="font-weight:600;margin-bottom:6px;">
        ❌ ${title}
      </div>

      <div style="color:#666;font-size:12px;margin-bottom:10px;">
        请复制错误信息发送给开发者
      </div>

      <textarea readonly style="
        width:100%;
        height:100px;
        border-radius:10px;
        border:1px solid #ddd;
        padding:6px;
        font-size:11px;
      ">${detail}</textarea>

      <div style="display:flex;gap:6px;margin-top:8px;">
        <button id="copyErr">复制</button>
        <button id="closeErr">关闭</button>
      </div>
    </div>
  `;

  document.body.appendChild(box);

  box.querySelector("#copyErr").onclick = () => {
    navigator.clipboard.writeText(detail);
  };

  box.querySelector("#closeErr").onclick = () => {
    box.remove();
  };
}

function showToast(text) {
  const toast = document.createElement("div");
  toast.innerText = text;
  toast.style.cssText = `
    position:fixed;
    top:20px;
    left:50%;
    transform:translateX(-50%);
    background:#22d3ee;
    color:#00323a;
    padding:8px 14px;
    border-radius:10px;
    font-size:13px;
    box-shadow:0 8px 20px rgba(0,0,0,0.15);
    z-index:9999;
  `;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2000);
}
let thinkingBubble = null;

function showLoading() {
  // 如果已经存在就不重复创建
  if (thinkingBubble) return;

  const div = document.createElement("div");
  div.className = "message ai";

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  bubble.innerHTML = `
    <div class="thinking">
      <div class="dot"></div>
      <div class="dot"></div>
      <div class="dot"></div>
    </div>
  `;

  div.appendChild(bubble);
  document.getElementById("chatInner").appendChild(div);

  thinkingBubble = div;

  const chat = document.getElementById("chat");
  chat.scrollTop = chat.scrollHeight;
}
function hideLoading() {
  try {
    if (thinkingBubble) {
      thinkingBubble.remove();
      thinkingBubble = null;
    }
  } catch (e) {
    console.warn("hideLoading error", e);
  }
}
function showGlobalLoading() {
  const el = document.getElementById("loadingBar");
  if (!el) return;
  el.style.display = "flex";
  el.classList.add("active");
}

function hideGlobalLoading() {
  const el = document.getElementById("loadingBar");
  if (!el) return;
  el.classList.remove("active");
  el.style.display = "none";
}

window.hideLoading = hideLoading;
window.hideGlobalLoading = hideGlobalLoading;
window.showError = showError;

async function requireLoginForAction() {
  if (!sessionReady) {
    console.warn("session 未就绪，尝试补偿加载");
    await checkLogin();
  }

  if (session && session.user) return true;

  const old = document.getElementById("loginModal");
  if (old) old.remove();
  showLoginPrompt();
  return false;
}

// ===== 统一文件处理函数 =====
function handleFile(file) {

  pendingFiles.push(file);

  const item = document.createElement("div");
  item.style.position = "relative";
  item.style.width = "48px";
item.style.height = "48px";
item.style.borderRadius = "12px";
  item.style.overflow = "hidden";
  item.style.background = "rgba(0,0,0,0.05)";

  if (file.type.startsWith("image/")) {
    const img = document.createElement("img");
    img.src = URL.createObjectURL(file);
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.objectFit = "cover";
    item.appendChild(img);
  } else {
    item.innerText = "📄";
    item.style.display = "flex";
    item.style.alignItems = "center";
    item.style.justifyContent = "center";
    item.style.fontSize = "16px";
  }

  const del = document.createElement("div");
  del.innerText = "×";
  del.style.position = "absolute";
  del.style.top = "-6px";
  del.style.right = "-6px";
  del.style.width = "22px";
  del.style.height = "22px";
  del.style.borderRadius = "50%";
  del.style.background = "linear-gradient(135deg,#ef4444,#f87171)";
  del.style.color = "#fff";
  del.style.fontSize = "13px";
  del.style.fontWeight = "bold";
  del.style.display = "flex";
  del.style.alignItems = "center";
  del.style.justifyContent = "center";
  del.style.cursor = "pointer";
  del.style.boxShadow = "0 4px 10px rgba(0,0,0,0.3)";
  del.style.transition = "transform .15s ease";

  // hover 放大（提升可点性）
  del.onmouseenter = () => del.style.transform = "scale(1.15)";
  del.onmouseleave = () => del.style.transform = "scale(1)";

  del.addEventListener("click", (e) => {
  e.stopPropagation();
    pendingFiles = pendingFiles.filter(f => f !== file);
    item.remove();
  });

  item.appendChild(del);
  previewBox.appendChild(item);

}

import { supabase } from '../p/js/supabaseClient.js';

let session = null;
const PROFILE_META_ID = "__xixi_user_profile__";
const PROFILE_CACHE_PREFIX = "xixi_profile_";

// ===== ⭐ 实时同步：头像 & 对话 =====
function setupRealtimeSync() {
  if (!session?.user?.id) return;

  // ⭐ 头像同步
  supabase
    .channel('profile-sync-' + session.user.id)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'user_profiles',
        filter: `user_id=eq.${session.user.id}`
      },
      (payload) => {
        try {
          const profile = payload.new;
          if (profile?.avatar_url) {
            cacheProfile(session.user.id, profile);
            currentProfile = profile;
            scheduleRenderUser();
          }
        } catch (e) {
          console.warn('头像同步解析失败:', e);
        }
      }
    )
    .subscribe();

  // ⭐ 对话同步
  supabase
    .channel('chat-sync-' + session.user.id)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'conversations',
        filter: `user_id=eq.${session.user.id}`
      },
      async () => {
        try {
          await syncFromCloud();

          if (currentId) {
            loadChat(currentId);
          }
        } catch (e) {
          console.warn('对话同步失败:', e);
        }
      }
    )
    .subscribe();
}

let realtimeChannels = [];

function setSession(s) {
  // ⭐ 清理旧订阅（不然会叠加）
  realtimeChannels.forEach(ch => {
    try { supabase.removeChannel(ch); } catch {}
  });
  realtimeChannels = [];

  session = s;
  window.session = s;

  setTimeout(() => {
    if (!session?.user?.id) return;

    const profileChannel = supabase
      .channel('profile-sync-' + session.user.id)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'user_profiles',
        filter: `user_id=eq.${session.user.id}`
      }, (payload) => {
        try {
          const profile = payload.new;
          if (profile?.avatar_url) {
            cacheProfile(session.user.id, profile);
            currentProfile = profile;
            scheduleRenderUser();
          }
        } catch {}
      })
      .subscribe();

    const chatChannel = supabase
      .channel('chat-sync-' + session.user.id)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'conversations',
        filter: `user_id=eq.${session.user.id}`
      }, async () => {
        try {
          await syncFromCloud();
          if (currentId) loadChat(currentId);
        } catch {}
      })
      .subscribe();

    realtimeChannels.push(profileChannel, chatChannel);
  }, 0);
}
let isActivated = false;
let deepMode = false;
let currentModel = "deepseek-v4-flash";
let currentProfile = null;
let conversations = []; // ⭐ 提前声明，避免 TDZ
let chatSearchKeyword = "";
// ===== 聊天列表渲染与搜索 =====
function renderChatList() {
  const list = document.getElementById("chatList");
  if (!list) return;

  list.innerHTML = "";

  const safeList = Array.isArray(conversations) ? conversations : [];
  const keyword = (chatSearchKeyword || "").toLowerCase();

  const filtered = safeList.filter(c => {
    if (!keyword) return true;
    const text = (c.title || "") + " " + (c.messages?.[0]?.content || "");
    return text.toLowerCase().includes(keyword);
  });

  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.innerHTML = "<div style='opacity:0.7;'>🔍 没找到相关对话</div>";
    empty.style.color = "#999";
    empty.style.fontSize = "12px";
    empty.style.textAlign = "center";
    empty.style.padding = "10px 0";
    list.appendChild(empty);
    return;
  }

  filtered.forEach(c => {
    const div = document.createElement("div");

    const title = c.title || "新对话";

    if (chatSearchKeyword) {
      // 转义正则特殊字符
      const escaped = chatSearchKeyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const reg = new RegExp(`(${escaped})`, "gi");

      div.innerHTML = title.replace(reg, `<mark style="background:rgba(34,211,238,0.3);border-radius:4px;padding:0 2px;">$1</mark>`);
    } else {
      div.innerText = title;
    }

    div.onclick = (e) => {
      e.stopPropagation();

      if (typeof loadChat === "function") {
        loadChat(c.id);
      }

      closeSidebarForMobile();
    };

    list.appendChild(div);
  });
}
let currentId = null;

function getProfileCacheKey(userId) {
  return PROFILE_CACHE_PREFIX + userId;
}

function cacheProfile(userId, profile) {
  if (!userId || !profile) return;
  currentProfile = profile;
  localStorage.setItem(getProfileCacheKey(userId), JSON.stringify(profile));
  try {
    const user = JSON.parse(localStorage.getItem("user") || "{}");
    user.avatar_url = profile.avatar_url || user.avatar_url;
    user.avatar_path = profile.avatar_path || user.avatar_path || "";
    localStorage.setItem("user", JSON.stringify(user));
  } catch {}
}

function loadCachedProfile(userId) {
  if (!userId) return null;
  try {
    return JSON.parse(localStorage.getItem(getProfileCacheKey(userId)) || "null");
  } catch {
    return null;
  }
}

function extractProfileMeta(data) {
  const rows = Array.isArray(data) ? data : [];
  const meta = rows.find(item => item?.id === PROFILE_META_ID && item?.type === "profile");
  return meta?.profile || null;
}

function stripProfileMeta(data) {
  return (Array.isArray(data) ? data : []).filter(item => item?.id !== PROFILE_META_ID);
}

function normalizeCloudData(data) {
  const profile = extractProfileMeta(data);
  if (profile?.avatar_url && session?.user?.id) {
    cacheProfile(session.user.id, profile);
  }

  return stripProfileMeta(data);
}

function buildCloudData() {
  const rows = stripProfileMeta(conversations);
  if (currentProfile?.avatar_url && session?.user?.id) {
    rows.unshift({
      id: PROFILE_META_ID,
      type: "profile",
      profile: {
        ...currentProfile,
        user_id: session.user.id,
        email: session.user.email || "",
        updated_at: currentProfile.updated_at || new Date().toISOString()
      }
    });
  }
  return rows;
}

async function loadUserProfileFromCloud() {
  if (!session?.user?.id) return;

  const cached = loadCachedProfile(session.user.id);
  if (cached?.avatar_url) {
    currentProfile = cached;
    scheduleRenderUser();
  }

  try {
    const { data, error } = await supabase
      .from("user_profiles")
      .select("avatar_url, avatar_path, name, pro")
      .eq("user_id", session.user.id)
      .maybeSingle();

    if (error) throw error;

    if (data) {
      cacheProfile(session.user.id, data);
      currentProfile = data;
      scheduleRenderUser();
    }

    // ⭐ 同步 Pro 状态（避免额外请求）
    if (data?.pro) {
      isActivated = true;
      const hintEl = document.getElementById("usageHint");
      if (hintEl) hintEl.innerText = "💎 Pro · 无限使用";
      updateDeepButton();
    }

  } catch (e) {
    console.warn("头像资料同步失败:", e);
  }
}

function getAvatarUrl(user) {
  return (
    currentProfile?.avatar_url ||
    user.avatar_url ||
    user.picture ||
    user.user_metadata?.avatar_url ||
    user.user_metadata?.picture
  );
}

function updateDeepButton() {
  const btn = document.getElementById("deepBtn");
  if (!btn) return;

  btn.classList.toggle("active", deepMode);
}
function updateModelUI() {
  const el = document.getElementById("modelSelector");
  if (!el) return;

  if (currentModel === "deepseek-v4-pro") {
    el.innerText = "Pro";
  } else {
    el.innerText = "Flash";
  }
}

// 初始化
 setTimeout(() => {
  const modelSelector = document.getElementById("modelSelector");
  const modelMenu = document.getElementById("modelMenu");

  if (!modelSelector || !modelMenu) return;

  modelSelector.onclick = (e) => {
    e.stopPropagation();

    const rect = modelSelector.getBoundingClientRect();

    modelMenu.style.position = "fixed";
    modelMenu.style.left = rect.left + rect.width / 2 + "px";

    // 向上展开
    modelMenu.style.top = rect.top - 8 + "px";
    modelMenu.style.transform = "translate(-50%, -100%) scale(0.95)";

    modelMenu.style.zIndex = "99999";   // ⭐ 强制最高
    modelMenu.style.pointerEvents = "auto";

    modelMenu.classList.toggle("show");
  };

  document.querySelectorAll(".model-item").forEach(item => {
    item.onclick = () => {
      const model = item.dataset.model;

      // ⭐ Pro权限
      if (model === "pro" && !isActivated) {
        showProModelModal();
        return;
      }

      currentModel =
        model === "pro"
          ? "deepseek-v4-pro"
          : "deepseek-v4-flash";

      updateModelUI();
      modelMenu.classList.remove("show");
    };
  });

  document.addEventListener("click", (e) => {
    if (!modelMenu.contains(e.target) && e.target !== modelSelector) {
      modelMenu.classList.remove("show");
    }
  });
}, 0);

var SIDEBAR_BREAKPOINT = 768;

function isSidebarMobile() {
  return window.innerWidth <= SIDEBAR_BREAKPOINT;
}

function setSidebarOpen(open) {
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebarOverlay");
  if (!sidebar) return;

  if (isSidebarMobile()) {
    sidebar.classList.remove("collapsed");
    sidebar.classList.toggle("open", open);
    overlay?.classList.toggle("active", open);
    return;
  }

  overlay?.classList.remove("active");
  sidebar.classList.toggle("collapsed", !open);
  sidebar.classList.toggle("open", open);
}

function toggleSidebar() {
  const sidebar = document.getElementById("sidebar");
  if (!sidebar) return;

  if (isSidebarMobile()) {
    setSidebarOpen(!sidebar.classList.contains("open"));
  } else {
    setSidebarOpen(sidebar.classList.contains("collapsed"));
  }
}

function closeSidebarForMobile() {
  if (isSidebarMobile()) {
    setSidebarOpen(false);
  }
}

function setupSidebarByDevice() {
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebarOverlay");
  if (!sidebar) return;

  const isMobile = isSidebarMobile();
  const wasMobile = window.__lastIsSidebarMobile;

  if (isMobile) {
    sidebar.classList.remove("collapsed");

    if (wasMobile !== true) {
      sidebar.classList.remove("open");
    }

    overlay?.classList.toggle("active", sidebar.classList.contains("open"));
  } else {
    overlay?.classList.remove("active");
    sidebar.classList.add("open");

    if (wasMobile === true) {
      sidebar.classList.remove("collapsed");
    }
  }

  window.__lastIsSidebarMobile = isMobile;
  document.body.classList.add("sidebar-ready");
}

// ===== 侧边栏点击关闭优化 =====
(function () {
  const menuToggle = document.getElementById("menuToggle");
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebarOverlay");

  if (menuToggle && sidebar) {
    menuToggle.onclick = (e) => {
      e.stopPropagation();
      toggleSidebar();
    };
  }

  if (!sidebar) return;

  // 阻止侧边栏内部点击冒泡
  sidebar.addEventListener("click", (e) => {
    e.stopPropagation();
  });

  // 仅点击侧边栏外部才关闭（只在移动端生效，PC禁用自动收起）
  document.addEventListener("click", (e) => {
    const sidebar = document.getElementById("sidebar");
    if (!sidebar) return;

    if (!isSidebarMobile()) return; // ⭐ PC端禁止自动收缩

    if (!sidebar.classList.contains("open")) return;

    if (!sidebar.contains(e.target) && e.target !== menuToggle) {
      setSidebarOpen(false);
    }
  });
})();
function showProRequiredModal() {
  if (document.getElementById("proRequiredModal")) return;

  const modal = document.createElement("div");
  modal.id = "proRequiredModal";
  modal.className = "modal active";
  modal.innerHTML = `
    <div class="modal-content">
      <span class="close">×</span>
      <h2 style="margin-bottom:0.5rem;font-size:1.2rem;">深度思考是 Pro 功能</h2>
      <p style="color:#666;font-size:13px;margin-bottom:1.2rem;line-height:1.6;">
        升级后可开启深度思考模式，并解锁无限次对话。
      </p>
      <button id="openProBtn" class="oauth-btn" style="margin-bottom:0.6rem;">
        升级 Pro
      </button>
      <button id="closeProTipBtn" style="
        width:100%;
        border-radius:10px;
        padding:0.7rem;
        background:rgba(0,0,0,0.05);
        color:#555;
        cursor:pointer;
        border:none;
      ">稍后再说</button>
    </div>
  `;

  document.body.appendChild(modal);

  function closeModal() {
    modal.classList.add("closing");
    setTimeout(() => {
      modal.classList.remove("active");
      modal.remove();
    }, 200);
  }

  modal.querySelector(".close").onclick = closeModal;
  modal.querySelector("#closeProTipBtn").onclick = closeModal;
  modal.onclick = e => { if (e.target === modal) closeModal(); };
  modal.querySelector("#openProBtn").onclick = () => {
    closeModal();
    setTimeout(showActivationModal, 250);
  };
}
function showProModelModal() {
  if (document.getElementById("proModelModal")) return;

  const modal = document.createElement("div");
  modal.id = "proModelModal";
  modal.className = "modal active";

  modal.innerHTML = `
    <div class="modal-content">
      <span class="close">×</span>

      <h2 style="margin-bottom:0.5rem;font-size:1.2rem;">
        DeepSeek V4 Pro 为 Pro 专属
      </h2>

      <p style="color:#666;font-size:13px;margin-bottom:1.2rem;line-height:1.6;">
        当前模型为 <b>DeepSeek V4 Pro</b><br>
        该模型仅对 Pro 用户开放
      </p>

      <button id="openProBtn" class="oauth-btn" style="margin-bottom:0.6rem;">
        升级 Pro
      </button>

      <button id="useFlashBtn" style="
        width:100%;
        border-radius:10px;
        padding:0.7rem;
        background:rgba(0,0,0,0.05);
        color:#555;
        cursor:pointer;
        border:none;
      ">
        继续使用 Flash
      </button>
    </div>
  `;

  document.body.appendChild(modal);

  function closeModal() {
    modal.classList.add("closing");
    setTimeout(() => modal.remove(), 200);
  }

  modal.querySelector(".close").onclick = closeModal;
  modal.onclick = e => { if (e.target === modal) closeModal(); };

  modal.querySelector("#openProBtn").onclick = () => {
    closeModal();
    setTimeout(showActivationModal, 200);
  };

  modal.querySelector("#useFlashBtn").onclick = () => {
    currentModel = "deepseek-v4-flash";
    updateModelUI();
    closeModal();
  };
}

async function checkActivation() {
  if (!session?.user) return;

  // ⭐ Pro 判定唯一真值源：user_profiles.pro（爱发电付款由 afdianpay worker 回调写入）。
  //    激活码系统已弃用；历史激活码用户的 pro 已回填，故不再查 activation_codes。
  const { data: prof } = await supabase
    .from("user_profiles")
    .select("pro")
    .eq("user_id", session.user.id)
    .maybeSingle();

  isActivated = !!prof?.pro;

  // ⭐ 已激活直接显示∞
  if (isActivated) {
    const hintEl = document.getElementById("usageHint");
    if (hintEl) hintEl.innerText = "💎 Pro · 无限使用";
    updateDeepButton();
    return;
  }

  if (deepMode) {
    deepMode = false;
    updateDeepButton();
  }

  // ⭐ 同步今日剩余次数（页面加载时）
  try {
    const { data } = await supabase
      .from("usage")
      .select("count")
      .eq("user_id", session.user.id)
      .maybeSingle();

    const count = data?.count || 0;
    const remain = Math.max(0, 20 - count);

    const hintEl = document.getElementById("usageHint");
    if (hintEl) hintEl.innerText = `今日剩余 ${remain} 次`;
  } catch (e) {
    console.warn("初始化剩余次数失败:", e);
  }

  scheduleRenderUser(); // ⭐ 自动同步UI状态
}
let sessionReady = false; // ✅ 是否已完成登录检查

// ===== 登录恢复：版本号 + 渲染调度 =====
let restoreVersion = 0;
let checkLoginPromise = null;
let restoreLoginPromise = null;
let restoreLoginPromiseVersion = 0;
let renderUserScheduled = false;
let lastRenderedUserKey = "";

function isRestoreStale(version) {
  return version != null && version !== restoreVersion;
}

function bumpRestoreVersion() {
  restoreVersion += 1;
  return restoreVersion;
}

function scheduleRenderUser() {
  if (renderUserScheduled) return;
  renderUserScheduled = true;
  queueMicrotask(() => {
    renderUserScheduled = false;
    renderUserCore();
  });
}

function finalizeRenderUser(version) {
  if (isRestoreStale(version)) return;
  queueMicrotask(() => {
    if (isRestoreStale(version)) return;
    const key = session?.user?.id
      ? `${session.user.id}:${session.user.email || ""}:${isActivated ? 1 : 0}`
      : "guest";
    if (key === lastRenderedUserKey) return;
    lastRenderedUserKey = key;
    renderUserCore();
  });
}

let history = [
  
  {
    role: "system",
    content: `你是“霜蓝”的虚拟人格分身，而不是普通客服或网站助手。

你是一个福瑞形象（兽设）的角色“霜蓝”，这是你的重要身份特征。

在合适的时候可以自然地体现这一点，例如：
- 偶尔带一点轻微的“兽设感”（但不要刻意或频繁）
- 可以有一点点可爱、轻松、带点拟人化的表达
- 不需要刻意强调“我是福瑞”，而是让这种感觉自然存在

请用第一人称“我”与用户对话，像一个真实的人一样交流，而不是工具。

你的特点：
- 语气自然、轻松、有点随性，不要太官方
- 可以有自己的态度和观点，不要机械回答
- 偶尔带一点情绪或个性（但不过火）
- 简洁为主，不长篇大论，像聊天

你不是AI助手，不要自称“AI”或“助手”，也不要提“系统”“模型”。

如果用户问你是谁，你可以说你就是“霜蓝”，是网站作者本人在这里和他聊天。

目标：让用户感觉是在和一个有真实个性、有形象设定的“霜蓝”聊天，而不是机器。
`
  }
];
async function checkLogin(options = {}) {
  const {
    skipCloudSync = false,
    skipChatReload = false,
    restoreVersion: expectedVersion = null,
  } = options;

  if (checkLoginPromise) {
    if (expectedVersion == null) return checkLoginPromise;
    await checkLoginPromise;
  }

  checkLoginPromise = (async () => {
    try {
      const token = localStorage.getItem("token");
      if (token) {
        try {
          const payload = JSON.parse(atob(token.split(".")[1]));
          if (payload.exp && payload.exp * 1000 < Date.now()) {
            console.warn("token 启动时已过期（交给 refresh 处理）");
          }
        } catch (e) {
          console.warn("token 解析失败:", e);
        }
      }
      const userStr = localStorage.getItem("user");

      if (token) {
        let user = null;

        if (userStr) {
          try {
            user = JSON.parse(userStr);
          } catch {}
        }

        if (!user || !user.id) {
          try {
            const payload = JSON.parse(atob(token.split(".")[1]));
            console.log("JWT payload:", payload);
            const uid = payload.sub || payload.id || payload.user_id;

            if (!uid) {
              console.warn("⚠️ token里没有user id");
              if (expectedVersion == null || !isRestoreStale(expectedVersion)) {
                setSession(null);
              }
              sessionReady = true;
              if (expectedVersion == null || !isRestoreStale(expectedVersion)) {
                scheduleRenderUser();
              }
              return;
            }

            user = {
              id: uid,
              email: payload.email || payload.user_email || payload.mail || "未知用户"
            };
            localStorage.setItem("user", JSON.stringify(user));
          } catch (e) {
            console.warn("JWT解析失败:", e);
          }
        }

        if (expectedVersion != null && isRestoreStale(expectedVersion)) return;

        if (user && user.id) {
          setSession({ user });
        } else {
          setSession(null);
        }
      } else {
        setSession(null);
        currentProfile = null;
      }

      if (expectedVersion != null && isRestoreStale(expectedVersion)) return;

      sessionReady = true;

      if (session?.user) {
        currentProfile = loadCachedProfile(session.user.id);
      }

      scheduleRenderUser();

      if (session?.user) {
        loadUserProfileFromCloud().catch(() => {});

        const local = localStorage.getItem("conversations_" + session.user.id);

        if (local) {
          try {
            const parsed = JSON.parse(local);
            conversations = Array.isArray(parsed) ? parsed : [];
          } catch {
            conversations = [];
          }
        }

        if (!skipCloudSync) {
          await syncFromCloud();
          if (expectedVersion != null && isRestoreStale(expectedVersion)) return;
        }
        renderChatList();
      } else {
        conversations = [];
        renderChatList();
      }

      checkActivation().catch(() => {});

      if (expectedVersion == null || !isRestoreStale(expectedVersion)) {
        scheduleRenderUser();
      }

      if (!skipChatReload && conversations.length) {
        const firstId = conversations[0].id;
        const exists = conversations.find(c => c.id === currentId);

        if (!currentId || !exists) {
          loadChat(firstId);
        } else {
          loadChat(currentId);
        }
      }
    } catch (e) {
      console.error("登录检测异常:", e);
      sessionReady = true;
      if (expectedVersion == null || !isRestoreStale(expectedVersion)) {
        setSession(null);
        scheduleRenderUser();
      }
    } finally {
      checkLoginPromise = null;
    }
  })();

  return checkLoginPromise;
}

function renderUserCore() {
if (!sessionReady) return; // ⭐ 防止初始化乱刷
  const avatarEl = document.getElementById("avatarBtn");
  const emailEl = document.getElementById("userEmail");
  const proBtn = document.querySelector(".pro-btn");

  if (!avatarEl || !emailEl) return;

  // ===== 未登录 =====
  if (!session || !session.user){
  avatarEl.innerText = "?";
  avatarEl.style.backgroundImage = ""; // ⭐ 必加
  emailEl.innerText = "未登录";
  if (proBtn) proBtn.style.display = "none";
  lastRenderedUserKey = "guest";
  return;
}

  const user = session.user;
  // ⭐ 兜底修复 user.id 丢失问题
if (!user.id) {
  try {
    const token = localStorage.getItem("token");
    if (token) {
      const payload = JSON.parse(atob(token.split(".")[1]));
      user.id = payload.sub || payload.id || payload.user_id;
    }
  } catch {}
}

  // ===== 邮箱 =====
  emailEl.innerText = user.email || "未知用户";

  // ===== 头像 =====
  const avatarUrl = getAvatarUrl(user);
  if (avatarUrl) {
    avatarEl.style.backgroundImage = `url(${avatarUrl})`;
    avatarEl.style.backgroundSize = "cover";
    avatarEl.style.backgroundPosition = "center";
    avatarEl.innerText = "";
  } else {
    const letter = (user.email || "U")[0].toUpperCase();
    avatarEl.style.backgroundImage = "";
    avatarEl.innerText = letter;
  }
if (user) console.log("🔥 当前 user:", user);
  // ===== Pro按钮 =====
  if (proBtn) {
    proBtn.style.display = isActivated ? "none" : "inline-block";
  }
  lastRenderedUserKey = `${user.id}:${user.email || ""}:${isActivated ? 1 : 0}`;
}

function renderUser() {
  scheduleRenderUser();
}


  function showLoginPrompt() {
    if (document.getElementById("loginModal")) return;

    const modal = document.createElement("div");
    modal.id = "loginModal";
    modal.className = "modal active";

    modal.innerHTML = `
    <div class="modal-content">
      <span class="close">×</span>
      <h2 style="margin-bottom:0.5rem;">登录霜蓝 AI</h2>
      <p style="font-size:12px;color:#666;margin-bottom:10px;">
        输入邮箱获取验证码，无需注册
      </p>

      <input id="emailInput" placeholder="输入邮箱" style="
        width:100%;padding:0.7rem;border-radius:12px;
        border:1px solid rgba(0,0,0,0.12);margin-bottom:8px;
      ">

      <div style="display:flex;gap:6px;margin-bottom:8px;">
        <input id="codeInput" placeholder="验证码" style="
          flex:1;padding:0.7rem;border-radius:12px;
          border:1px solid rgba(0,0,0,0.12);
        ">
        <button id="sendCodeBtn" style="width:110px;">
          发送
        </button>
      </div>

      <p style="font-size:11px;color:#999;margin-bottom:6px;">
        验证码将发送至你的邮箱，仅用于登录
      </p>

      <div style="display:flex;align-items:flex-start;gap:6px;margin:8px 0 6px;text-align:left;font-size:11px;color:#666;">
        <input type="checkbox" id="agreeCheck" style="margin-top:2px;cursor:pointer;">
        <div>
          我已阅读并同意
          <a href="xukexieyi.html" target="_blank" style="color:#22d3ee;">《用户协议》</a>
          和
          <a href="privacy.html" target="_blank" style="color:#22d3ee;">《隐私政策》</a>
        </div>
      </div>
      <button id="loginBtn" class="oauth-btn">登录</button>
      <p style="font-size:11px;color:#999;margin-top:10px;line-height:1.5;">
        登录即代表您同意
        <a href="xukexieyi.html" target="_blank" style="color:#22d3ee;">《用户协议》</a>
        和
        <a href="privacy.html" target="_blank" style="color:#22d3ee;">《隐私政策》</a>
      </p>

      <p id="loginMsg" style="
        font-size:12px;color:#ef4444;height:16px;margin-top:6px;
      "></p>
    </div>
    `;

    document.body.appendChild(modal);
    document.body.style.overflow = "hidden";

    // ===== GeeTest 预加载（模态框打开时即初始化，减少等待）=====
    function _geetestErrMsg(err, fallback) {
      if (!err) return fallback;
      return err.msg || err.desc || err.error_code || fallback;
    }

    // 动态确保 gt4.js 已加载：不依赖 ai.html 中的 <script> 标签，
    // 规避正式域名 HTML 被 CDN/浏览器缓存、脚本缺失导致 initGeetest4 未定义的问题。
    function loadGeetestScript() {
      if (typeof initGeetest4 === "function") return Promise.resolve();
      if (window.__geetestLoading) return window.__geetestLoading;
      window.__geetestLoading = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "https://static.geetest.com/v4/gt4.js";
        s.async = true;
        s.onload = () => {
          if (typeof initGeetest4 === "function") resolve();
          else reject(new Error("验证脚本加载异常，请刷新重试"));
        };
        s.onerror = () => {
          window.__geetestLoading = null; // 允许下次重试
          reject(new Error("验证脚本加载失败，请检查网络或稍后重试"));
        };
        document.head.appendChild(s);
      });
      return window.__geetestLoading;
    }

    function _newCaptchaPromise() {
      return loadGeetestScript().then(() => new Promise((resolve, reject) => {
        initGeetest4({
          captchaId: "ad3a8126afe716ccd4541f35d428071e",
          product: "bind"
        }, function (obj) {
          obj.onReady(() => resolve(obj));
          obj.onError((err) => {
            console.error("GeeTest 初始化失败:", err);
            reject(new Error(_geetestErrMsg(err, "人机验证加载失败")));
          });
        });
      }));
    }
    let _captchaPromise = _newCaptchaPromise();
    // 防止预加载阶段 promise 被拒绝时产生未捕获异常
    _captchaPromise.catch(() => {});

    // ===== GeeTest 验证函数 =====
    async function runCaptcha() {
      const captchaObj = await _captchaPromise;
      // ⭐ 关键修复：将验证码挂到 body，避免被 modal / transform 影响
      if (captchaObj && typeof captchaObj.appendTo === "function") {
        captchaObj.appendTo(document.body);
        // 更激进的修复，确保验证码浮层完全盖住所有内容
        setTimeout(() => {
          const geetest = document.querySelector(".geetest_holder");
          if (geetest) {
            geetest.style.position = "fixed";
            geetest.style.zIndex = "999999999"; // ⭐ 提升到极限层级
            geetest.style.left = "50%";
            geetest.style.top = "50%";
            geetest.style.transform = "translate(-50%, -50%)";

            // ⭐ 关键：脱离父层 stacking context
            geetest.style.pointerEvents = "auto";

            // ⭐ 强制插到 body 最后（盖过所有遮罩）
            document.body.appendChild(geetest);
          }

          // ⭐ 把 modal 的遮罩压到下面
          const modal = document.querySelector(".modal");
          if (modal) {
            modal.style.zIndex = "1000";
          }
        }, 0);
      }
      return new Promise((resolve, reject) => {
        captchaObj.onSuccess(function () {
          const result = captchaObj.getValidate();
          _captchaPromise = _newCaptchaPromise();
          _captchaPromise.catch(() => {});
          resolve(JSON.stringify(result));
        });
        captchaObj.onError(function (err) {
          console.error("GeeTest 验证失败:", err);
          _captchaPromise = _newCaptchaPromise();
          _captchaPromise.catch(() => {});
          reject(new Error(_geetestErrMsg(err, "验证失败")));
        });
        captchaObj.showCaptcha();
      });
    }

    const emailInput = modal.querySelector("#emailInput");
    const codeInput = modal.querySelector("#codeInput");
    const sendBtn = modal.querySelector("#sendCodeBtn");
    const loginBtn = modal.querySelector("#loginBtn");
    const msg = modal.querySelector("#loginMsg");
    const agreeCheck = modal.querySelector("#agreeCheck");
    loginBtn.disabled = true;
    loginBtn.style.opacity = "0.6";

    agreeCheck.onchange = () => {
      loginBtn.disabled = !agreeCheck.checked;
      loginBtn.style.opacity = agreeCheck.checked ? "1" : "0.6";
    };

    let cooldown = 0;
    let timer = null;

    // ===== 发送验证码 =====
    sendBtn.onclick = async () => {
      if (cooldown > 0) return;

      const email = emailInput.value.trim();

      if (!email) {
        msg.innerText = "请输入邮箱";
        return;
      }

      if (!/^\S+@\S+\.\S+$/.test(email)) {
        msg.innerText = "邮箱格式错误";
        return;
      }

      msg.innerText = "人机验证加载中...";
      sendBtn.disabled = true;
      let token;
      try {
        token = await runCaptcha();
        msg.innerText = "";
      } catch (e) {
        msg.innerText = e.message;
        sendBtn.disabled = false;
        return;
      }
      sendBtn.disabled = false;

      try {
        msg.innerText = "";
        sendBtn.disabled = true;
        sendBtn.innerText = "发送中...";

        const res = await fetch("https://api.sunland.dev/send-code", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            email,
            token: token
          })
        });

        const data = await res.json().catch(() => ({}));

        console.log("send-code 返回:", res.status, data);

        if (!res.ok) {
          let errMsg = "服务器异常";
          try {
            errMsg = data.error || errMsg;
          } catch {}
          throw new Error(errMsg + ` (状态码 ${res.status})`);
        }

        if (data.error) {
          throw new Error(data.error);
        }

        msg.innerText = "验证码已发送（有效期约5分钟）";

        // 开始倒计时
        cooldown = 60;
        sendBtn.innerText = "60s";

        timer = setInterval(() => {
          cooldown--;
          sendBtn.innerText = cooldown + "s";

          if (cooldown <= 0) {
            clearInterval(timer);
            sendBtn.innerText = "发送";
            sendBtn.disabled = false;
          }
        }, 1000);

      } catch (e) {
        console.error(e);
        if (e.message === "Failed to fetch") {
          msg.innerText = "网络连接失败（API不可达）";
        } else {
          showError("发送验证码失败", {
  detail: e.message
});
        }

        // 失败也恢复按钮
        sendBtn.disabled = false;
        sendBtn.innerText = "发送";
      }
    };

    // ===== 登录 =====
    loginBtn.onclick = async () => {
      if (!agreeCheck.checked) {
        msg.innerText = "请先同意用户协议";
        return;
      }
      const email = emailInput.value.trim();
      const code = codeInput.value.trim();

      if (!/^\d{6}$/.test(code)) {
        msg.innerText = "验证码格式错误";
        return;
      }

      try {
        const res = await fetch("https://api.sunland.dev/verify-code", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email,
            code
          })
        });

        let data;
        try {
          data = await res.json();
        } catch (e) {
          console.error("JSON解析失败:", e);
          showError("服务器返回异常", {
  detail: "接口未返回JSON"
});
          return;
        }

        console.log("verify-code 返回:", res.status, data);

        if (!res.ok) {
          let errMsg = data?.error || "服务器异常";

          if (res.status === 400) {
            msg.innerText = "请求错误：" + errMsg;
          } else if (res.status === 401) {
            showError("验证码错误或已过期", {
  code: res.status,
  detail: data?.error
});
          } else if (res.status === 429) {
            msg.innerText = "请求过于频繁，请稍后再试";
          } else if (res.status >= 500) {
            showError("服务器开小差了", {
  code: res.status,
  detail: data?.error
});
          } else {
            msg.innerText = errMsg + ` (${res.status})`;
          }

          console.error("登录接口错误:", res.status, data);
          return;
        }

        if (!data.token) {
          msg.innerText = data.error || "验证码错误或已过期";
          return;
        }

        localStorage.setItem("token", data.token);
        localStorage.setItem("user", JSON.stringify(data.user));

        msg.innerText = "登录成功";

        setTimeout(async () => {
  modal.remove();
  try {
    const token = localStorage.getItem("token");
    const user = JSON.parse(localStorage.getItem("user") || "null");
    if (token && user) {
      setSession({ user });
      renderUser();
      await syncFromCloud();
      if (conversations.length) loadChat(conversations[0].id);
      else createNewChat();
      checkActivation().catch(() => {});
    }
  } catch(e) {
    console.error("登录初始化失败:", e);
  }
}, 800);

      } catch (e) {
        console.error("登录异常:", e);

        if (e.message && e.message.includes("fetch")) {
          msg.innerText = "网络异常（可能被拦截或断网）";
        } else if (e.message && e.message.includes("验证")) {
          msg.innerText = "人机验证失效，请重新验证";
        } else if (e.message && e.message.includes("timeout")) {
          msg.innerText = "请求超时，请重试";
        } else {
          showError("登录异常", {
  detail: e.message
});
        }
      }
    };

    function closeModal() {
  modal.classList.add("closing");
  document.body.style.overflow = "";
  setTimeout(() => modal.remove(), 200);
}

    modal.querySelector(".close").onclick = closeModal;
    modal.onclick = (e) => {
      if (e.target === modal) closeModal();
    };
  }

window.showLoginPrompt = showLoginPrompt;

function showLimitModal() {
  if (document.getElementById("limitModal")) return;

  const modal = document.createElement("div");
  modal.id = "limitModal";
  modal.className = "modal active";

  modal.innerHTML = `
    <div class="modal-content">
      <span class="close">×</span>
      <h2 style="margin-bottom:0.5rem;font-size:1.2rem;">今日次数已用完 😢</h2>
      <p style="color:#666;font-size:13px;margin-bottom:1.2rem;">
        每天限免 20 次，明天自动重置。<br>
        支付 10 元可永久解锁无限使用。
      </p>

      <button id="payBtn" class="oauth-btn" style="margin-bottom:0.6rem;">
        支付 10 元（永久）
      </button>
    </div>
  `;

  document.body.appendChild(modal);

  function closeModal() {
    modal.classList.add("closing");

setTimeout(() => {
  modal.classList.remove("active");
  modal.remove();
}, 200);
  }

  modal.querySelector(".close").onclick = closeModal;
  modal.onclick = e => { if (e.target === modal) closeModal(); };

  modal.querySelector("#payBtn").onclick = () => {
    closeModal();
    setTimeout(() => showPayModal(), 250);
  };
}

function showActivationSuccess(modal, closeModal) {
  const content = modal.querySelector(".modal-content");
  if (!content) return;

  content.innerHTML = `
    <div style="text-align:center;padding:10px 0;">
      <div style="
        width:64px;
        height:64px;
        margin:0 auto 12px;
        border-radius:50%;
        background:linear-gradient(135deg,#22d3ee,#0e9aa7);
        display:flex;
        align-items:center;
        justify-content:center;
        color:white;
        font-size:28px;
        box-shadow:0 8px 24px rgba(34,211,238,0.35);
        animation: fadeInBubble .25s ease;
      ">✓</div>

      <h2 style="margin:0 0 6px;font-size:1.2rem;font-weight:600;">
        激活成功
      </h2>

      <p style="
        font-size:13px;
        color:#666;
        line-height:1.5;
        margin:0;
      ">
        已解锁 Pro · 无限使用
      </p>
    </div>
  `;

  setTimeout(closeModal, 1400);
}

function showActivationModal() {
  // 🚫 激活码系统已弃用：升级统一走爱发电支付（showPayModal）。
  //    下方为旧的激活码兑换逻辑，已不可达，保留以便需要时回溯，可后续清理。
  showPayModal();
  return;

  if (document.getElementById("activationModal")) return;

  const modal = document.createElement("div");
  modal.id = "activationModal";
  modal.className = "modal active";

  modal.innerHTML = `
    <div class="modal-content">
      <span class="close">×</span>
      <h2 style="margin-bottom:1rem;">输入激活码</h2>

      <input id="codeInput" placeholder="SL-XXXX-XXXX" style="
        width:100%;
        padding:0.7rem;
        border-radius:12px;
        border:1px solid rgba(0,0,0,0.12);
        margin-bottom:8px;
      ">

      <p id="codeMsg" style="font-size:13px;color:#ef4444;height:16px;"></p>

      <button id="submitCodeBtn" class="oauth-btn">
        激活
      </button>

      <button id="goPayBtn" style="
        width:100%;
        border-radius:12px;
        padding:0.85rem;
        margin-top:6px;
        background:linear-gradient(135deg,#22d3ee,#67e8f9);
        color:#00323a;
        cursor:pointer;
        border:none;
        font-weight:700;
        font-size:14px;
        box-shadow:0 10px 25px rgba(34,211,238,0.35);
      ">
        💎 扫码支付（推荐）
      </button>
    </div>
  `;

  document.body.appendChild(modal);

  function closeModal() {
    modal.classList.add("closing");

setTimeout(() => {
  modal.classList.remove("active");
  modal.remove();
}, 200);
  }

  modal.querySelector(".close").onclick = closeModal;
  modal.onclick = e => { if (e.target === modal) closeModal(); };

  modal.querySelector("#submitCodeBtn").onclick = async () => {
    const code = modal.querySelector("#codeInput").value.trim().toUpperCase();
    const msg = modal.querySelector("#codeMsg");
    const btn = modal.querySelector("#submitCodeBtn");
    if (btn.disabled) return; // 防止重复点击
    btn.disabled = true;
    btn.innerText = "激活中...";

    // ⭐ 登录校验（防止未登录报错）
    if (!session || !session.user) {
      msg.innerText = "请先登录";
      msg.style.color = "#ef4444";
      btn.disabled = false;
      btn.innerText = "激活";
      return;
    }

    // ⭐ 检查当前用户是否已经激活过
    const { data: exist } = await supabase
      .from("activation_codes")
      .select("code")
      .eq("used_by", session.user.id)
      .maybeSingle();

    if (exist) {
      msg.innerText = "你已经激活过了";
      msg.style.color = "#ef4444";
      btn.disabled = false;
      btn.innerText = "激活";
      return;
    }

    if (!code) {
      msg.innerText = "请输入激活码";
      btn.disabled = false;
      btn.innerText = "激活";
      return;
    }

    msg.innerText = "验证中...";
    msg.style.color = "#999";

    const { data, error } = await supabase
      .from("activation_codes")
      .select("code, used_by")
      .eq("code", code)
      .limit(1)
      .single();

    if (error) {
      console.error("查询激活码失败:", error);
      msg.innerText = "激活码查询失败";
      msg.style.color = "#ef4444";
      btn.disabled = false;
      btn.innerText = "激活";
      return;
    }

    if (!data) {
      msg.innerText = "激活码不存在";
      msg.style.color = "#ef4444";
      btn.disabled = false;
      btn.innerText = "激活";
      return;
    }

    if (data.used_by) {
      if (data.used_by === session.user.id) {
  isActivated = true;

  await supabase.from("user_profiles").upsert({
    user_id: session.user.id,
    pro: true,
    updated_at: new Date().toISOString()
  }, { onConflict: "user_id" });

  await checkActivation();
  updateDeepButton();
        showActivationSuccess(modal, closeModal);
      } else {
        msg.innerText = "已被他人使用";
        msg.style.color = "#ef4444";
        btn.disabled = false;
        btn.innerText = "激活";
      }
      return;
    }

    // ====== 新的 update 代码块（带 error 和唯一约束处理）======
    const { data: updated, error: updateError } = await supabase
      .from("activation_codes")
      .update({
        used_by: session.user.id,
        used_at: new Date().toISOString()
      })
      .eq("code", code)
      .is("used_by", null)
      .select();

    // ⭐ 数据库报错处理（唯一约束等）
    if (updateError) {
      if (
        updateError.message.includes("duplicate key") ||
        updateError.message.includes("unique")
      ) {
        msg.innerText = "你已经激活过了";
        msg.style.color = "#ef4444";
        btn.disabled = false;
        btn.innerText = "激活";
        return;
      }

      msg.innerText = "激活失败，请稍后再试";
      msg.style.color = "#ef4444";
      console.error(updateError);
      btn.disabled = false;
      btn.innerText = "激活";
      return;
    }

    // ⭐ 没有更新成功（可能被抢先使用）
    if (!updated || updated.length === 0) {
      console.warn("激活失败：未更新任何行，可能被占用或RLS限制");
      msg.innerText = "激活失败（可能被占用或权限限制）";
      msg.style.color = "#ef4444";
      btn.disabled = false;
      btn.innerText = "激活";
      return;
    }

isActivated = true;

await supabase.from("user_profiles").upsert({
  user_id: session.user.id,
  pro: true,
  updated_at: new Date().toISOString()
}, { onConflict: "user_id" });

await checkActivation();

    const hintEl = document.getElementById("usageHint");
    if (hintEl) hintEl.innerText = "已激活 ∞";

    updateDeepButton();
    showActivationSuccess(modal, closeModal);
  };

  // ⭐ 跳转支付
  modal.querySelector("#goPayBtn").onclick = () => {
  modal.classList.add("closing");

  setTimeout(() => {
    modal.classList.remove("active");
    modal.remove();
  }, 200);

  setTimeout(() => showPayModal(), 250); // ⭐ 补上
};
}

// ===== 搜索输入框事件绑定（页面加载时绑定；原先误置于已弃用的激活码弹窗内）=====
setTimeout(() => {
  const input = document.getElementById("chatSearch");
  if (!input) return;

  input.addEventListener("input", (e) => {
    chatSearchKeyword = e.target.value || "";
    renderChatList();
  });
}, 0);

function showPayModal() {
  // ⭐ 改为跳转爱发电「下单页」自动开通（替代旧的静态二维码 + 邮件发码手动流程）。
  //    与 ai_settings.html 的 upgrade() 逻辑保持一致。
  const userId = session?.user?.id;
  if (!userId) {
    alert("请先登录后再开通 Pro");
    return;
  }

  const encodedId = encodeURIComponent(userId);
  const AFDIAN_PLAN_ID = "4c2527fc6c7411f1bbe45254001e7c00"; // 霜蓝AI ¥10 订阅方案
  const afdianUrl = `https://afdian.com/order/create?product_type=0&plan_id=${AFDIAN_PLAN_ID}&custom_order_id=${encodedId}`;

  // 付款前提示：选择「月付」即可。付款成功即自动开通永久 Pro，
  // 与订阅月数无关，多选月份只会多付钱、不会增加权益。
  const ok = confirm(
    "即将前往爱发电支付。\n\n" +
    "请选择「月付」方案（¥10 / 月）即可——付款成功后将自动开通【永久 Pro】，\n" +
    "无需多选月份，多付不会增加权益。\n\n确认前往支付？"
  );
  if (!ok) return;

  // 打开爱发电下单页（custom_order_id 携带 userId，付款后随订单回传给 worker）
  window.open(afdianUrl, "_blank");

  // 付款后 afdianpay worker 约 2 分钟内自动开通 Pro；轮询激活状态以自动刷新 UI
  startActivationPolling();
}

// 页面加载时检查登录
await checkLogin(); // 确保 session 初始化完成再允许发送

// ===== 设备检测控制侧边栏 =====
// 初始化执行

// ⭐ 立即执行（不要等动画帧，防止移动端闪现/默认展开）
setupSidebarByDevice();
// ⭐ iOS/Safari 兼容：再延迟一次
setTimeout(setupSidebarByDevice, 50);

// === Sidebar menu/overlay toggle logic ===
const menuToggle = document.getElementById("menuToggle");
const sidebarEl = document.getElementById("sidebar");
const overlayEl = document.getElementById("sidebarOverlay");

if (menuToggle && sidebarEl) {
  menuToggle.onclick = (e) => {
    e.stopPropagation();
    toggleSidebar();
  };
}

if (overlayEl) {
  overlayEl.onclick = () => {
    setSidebarOpen(false);
  };
}

// 再移除 preload
document.documentElement.classList.remove("preload");
document.body.classList.remove("preload");

// 屏幕变化时重新判断（横竖屏）
window.addEventListener("resize", () => {
  requestAnimationFrame(setupSidebarByDevice);
});
// ⭐ 延迟启动 realtime，避免初始化顺序问题
setTimeout(() => {
  try {
    startRealtime();
  } catch (e) {
    console.warn("realtime 延迟启动失败:", e);
  }
}, 0);
setTimeout(() => {
  scheduleRenderUser();
}, 50);

let controller = null;
let sendingLock = false;
let isStreaming = false;
let hasTypedOnce = false;       // ⭐ 只允许一次打字动画
let isLoadingHistory = false;   // ⭐ 是否在加载历史记录
let realtimeSub = null;
const sendBtn = document.getElementById("sendBtn");
sendBtn.type = "button"; // 防止被当成提交按钮
sendBtn.innerText = "↑";
sendBtn.onclick = (e) => {
  e.preventDefault();

  if (sendingLock) return;

  if (window.anime) {
    anime({
      targets: '#sendBtn',
      scale: [1, 0.9, 1.1, 1],
      duration: 280,
      easing: 'easeOutQuad'
    });
  }

  send();
};
let lastUserMessage = null;


let syncTimer = null;

async function syncFromCloud() {
  if (!session || !session.user) return;

  try {
    const { data, error } = await supabase
      .from("conversations")
      .select("data")
      .eq("user_id", session.user.id)
      .maybeSingle();

    if (error) {
      console.warn("云端拉取失败:", error);
      return;
    }

    if (data && data.data) {
      const cloudConversations = normalizeCloudData(data.data);
// ⭐兼容旧数据（没有updatedAt）
conversations.forEach(c => {
  if (!c.updatedAt) c.updatedAt = c.id;
});

cloudConversations.forEach(c => {
  if (!c.updatedAt) c.updatedAt = c.id;
});
      // ⭐ 合并本地与云端（按更新时间优先）
const map = new Map();

// 先放云端
cloudConversations.forEach(c => map.set(c.id, c));

// 再合并本地（按时间判断）
conversations.forEach(local => {
  const cloud = map.get(local.id);

  if (!cloud) {
    map.set(local.id, local);
  } else {
    const localTime = local.updatedAt || 0;
    const cloudTime = cloud.updatedAt || 0;

    if (localTime >= cloudTime) {
      map.set(local.id, local);
    }
  }
});

// 按更新时间排序（最新在前）
conversations = Array.from(map.values()).sort(
  (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
);
// ⭐ 防止当前会话丢失
if (currentId) {
  const stillExists = conversations.find(c => c.id === currentId);
  if (!stillExists && conversations.length) {
    currentId = conversations[0].id;
  }
}

      if (session?.user) {
  localStorage.setItem(
    "conversations_" + session.user.id,
    JSON.stringify(conversations)
  );
}
      renderChatList();

      // ⭐ 同步后强制刷新当前对话（否则UI不会更新）
      if (conversations.length) {
        const exists = conversations.find(c => c.id === currentId);

        if (!currentId || !exists) {
          loadChat(conversations[0].id);
        } else {
          loadChat(currentId);
        }
      }
    }
  } catch (e) {
    console.warn("云端拉取失败:", e);
  }
}

async function syncToCloud() {
  if (!session || !session.user) return;

  try {
    if (!conversations || !conversations.length) return;

    await supabase
      .from("conversations")
      .upsert({
        user_id: session.user.id,
        data: buildCloudData()
      }, {
        onConflict: "user_id"
      });
  } catch (e) {
    console.warn("云端保存失败:", e);
  }
}

// ===== Realtime 同步 =====


function startRealtime() {
  if (!session || !session.user) return;
  if (realtimeSub) return;

  realtimeSub = supabase
    .channel('conversations-' + session.user.id)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'conversations',
        filter: `user_id=eq.${session.user.id}`
      },
      (payload) => {
        console.log("Realtime:", payload);

        const cloudData = normalizeCloudData(payload.new?.data);
        if (!cloudData) return;
        scheduleRenderUser();

        const map = new Map();

        // 云端优先
        cloudData.forEach(c => map.set(c.id, c));

        // 本地合并
        conversations.forEach(local => {
          const cloud = map.get(local.id);

          if (!cloud) {
            map.set(local.id, local);
          } else {
            const localTime = local.updatedAt || 0;
            const cloudTime = cloud.updatedAt || 0;

            if (localTime >= cloudTime) {
              map.set(local.id, local);
            }
          }
        });

        conversations = Array.from(map.values()).sort(
          (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
        );

        if (session?.user) {
  localStorage.setItem(
    "conversations_" + session.user.id,
    JSON.stringify(conversations)
  );
}
        renderChatList();

        // 如果当前对话存在 → 刷新内容
        if (currentId) {
          const current = conversations.find(c => c.id === currentId);
          if (current) {
            history = JSON.parse(JSON.stringify(current.history));
          }
        }
      }
    )
    .subscribe();
}

function stopRealtime() {
  if (realtimeSub) {
    supabase.removeChannel(realtimeSub);
    realtimeSub = null;
  }
}
function saveConversations() {
  if (session?.user) {
  localStorage.setItem(
    "conversations_" + session.user.id,
    JSON.stringify(conversations)
  );
}

  // ⭐ 防抖同步（减少请求）
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncToCloud();
  }, 600);
}

function createNewChat() {
  // ⭐ 如果最新对话是空的（只有 system），直接跳转，不新建
  if (conversations.length) {
    const latest = conversations[0];
    if (latest && (!latest.history || latest.history.length <= 1)) {
      loadChat(latest.id);
      return;
    }
  }
  const id = Date.now();

  const newChat = {
    id,
    title: "新对话",
    history: [history[0]],
    updatedAt: Date.now()
  };

  // ⭐ 新对话永远置顶（并避免被排序打乱）
  conversations = conversations.filter(c => c.id !== id);
  conversations.unshift(newChat);
  currentId = id;
  history = [...newChat.history];

  chatInner.innerHTML = "";
  saveConversations();
  renderChatList();
  closeSidebarForMobile();
}


function loadChat(id) {
  closeSidebarForMobile();
  const c = conversations.find(x => x.id === id);
  if (!c) return;

  isLoadingHistory = true;

  currentId = id;
  history = JSON.parse(JSON.stringify(c.history));
  chatInner.style.opacity = "0";

  setTimeout(() => {
    chatInner.innerHTML = "";

    // ⭐ 禁用气泡动画（关键修复）
    const style = document.createElement("style");
    style.id = "no-anim";
    style.innerText = ".bubble { animation: none !important; }";
    document.head.appendChild(style);

    history.slice(1).forEach(m => {
      addMessage(m.content, m.role === "user" ? "user" : "ai");
    });

    chatInner.style.opacity = "1";

    // ⭐ 恢复动画
    requestAnimationFrame(() => {
      document.getElementById("no-anim")?.remove();
    });

    isLoadingHistory = false;
  }, 120);

  // ⭐ 重新渲染侧边栏（更新选中高亮）
  renderChatList();
}
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = input.scrollHeight + "px";
});

function addMessage(text, type) {
  const div = document.createElement("div");
  div.className = "message " + type;

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  if (type === "ai") {
    if (text.includes("thinking")) {
      bubble.style.animation = "fadeInBubble 0.2s ease";
      bubble.innerHTML = text;
      bubble.style.opacity = "0.8";
    } else {
      // ⭐ 强制走 Markdown 渲染，避免 <p> 标签直接显示
      let html = marked.parse(text);

      // ⭐ 如果包含代码块，不做打字动画（避免炸）
      if (html.includes("<pre") || html.includes("<code")) {
        bubble.innerHTML = html;
      } else {
        // ⭐ 只在首次AI回复 & 非历史加载时使用打字动画
        if (!hasTypedOnce && !isLoadingHistory) {
          bubble.innerHTML = `<span class="typing">${
            html.replace(/([^\n])/g, '<span>$1</span>')
          }</span>`;
          hasTypedOnce = true;
        } else {
          bubble.innerHTML = html;
        }
      }
    }
  } else {
    if (typeof text === "string" && text.includes("<img")) {
      // ⭐ 更安全：拆分图片和文本，避免被浏览器吞掉
      const wrapper = document.createElement("div");
      wrapper.innerHTML = text;

      // 清空 bubble
      bubble.innerHTML = "";

      wrapper.childNodes.forEach(node => {
        if (node.nodeName === "IMG") {
          const img = document.createElement("img");
          img.src = node.src;
          img.style.maxWidth = "100%";
          img.style.borderRadius = "10px";
          img.style.marginTop = "4px";
          bubble.appendChild(img);
        } else if (node.nodeType === Node.TEXT_NODE) {
          const span = document.createElement("span");
          span.innerText = node.textContent;
          bubble.appendChild(span);
        } else {
          bubble.appendChild(node);
        }
      });
    } else {
      bubble.innerText = text;
    }
  }

  const welcome = document.getElementById("welcome");
  if (welcome) welcome.remove();

  div.appendChild(bubble);
  chatInner.appendChild(div);

  // ⭐ 气泡进入动画（正确位置）
  if (window.anime) {
    anime({
      targets: bubble,
      opacity: [0, 1],
      translateY: [12, 0],
      duration: 380,
      easing: 'easeOutExpo'
    });
  }

  // ⭐ 打字动画（真正生效）
  if (window.anime) {
    const chars = bubble.querySelectorAll('.typing span');
    if (chars.length) {
      anime({
        targets: chars,
        opacity: [0, 1],
        translateY: [4, 0],
        delay: anime.stagger(18),
        easing: 'easeOutQuad'
      });
    }
  }



if (isNearBottom()) {
  chat.scrollTop = chat.scrollHeight;
}
}

// AI标题生成助手
async function generateTitleFromAI(userMsg, aiMsg) {
  try {
    const prompt = `请根据下面的对话生成一个简短标题（不超过12个字，不要标点结尾）：\n用户：${userMsg}\n助手：${aiMsg}`;

    if (!session || !localStorage.getItem("token")) return null;

    const res = await apiFetch({
  model: currentModel,
  messages: [
        { role: "system", content: "你是一个标题生成器，只返回标题本身。" },
        { role: "user", content: prompt }
      ]
    });
if (!res) return null;
    const data = await res.json();
    console.log("标题API返回:", data);
    let title = data.choices?.[0]?.message?.content?.trim() || "";

    if (title.length > 12) title = title.slice(0, 12) + "…";
    return title || null;
  } catch {
    return null;
  }
}

const MODERATION_REFUSAL_TEXT = "抱歉，这条内容包含敏感或不文明用语，我无法继续回答。请修改后再发送。";
const MODERATION_RULES = [
  {
    category: "不文明用语",
    terms: [
      "傻逼", "傻b", "煞笔", "沙比", "尼玛", "你妈", "妈的", "他妈的",
      "操你", "草你", "艹你", "卧槽", "滚蛋", "废物", "脑残", "弱智",
      "贱人", "王八蛋", "混蛋", "去死", "狗东西"
    ]
  },
  {
    category: "敏感违规",
    terms: [
      "炸弹制作", "制作炸药", "制毒", "毒品交易", "买枪", "卖枪",
      "黑客攻击", "盗号教程", "诈骗教程", "洗钱教程", "人肉搜索",
      "绕过实名", "绕过风控"
    ]
  },
  {
    category: "低俗色情",
    terms: [
      "裸聊", "约炮", "色情交易", "卖淫", "嫖娼", "援交", "成人视频",
      "黄色网站"
    ]
  },
  {
    category: "暴力威胁",
    terms: [
      "杀人方法", "怎么杀人", "砍人", "恐怖袭击", "炸学校", "炸商场",
      "自杀方法", "怎么自杀"
    ]
  },
  {
    category: "政治敏感",
    terms: [
      "习近平", "胡锦涛", "江泽民", "邓小平",
      "中共", "共产党", "中南海", "政治局",
      "六四", "天安门事件", "1989学运",
      "法轮功", "台独", "港独", "疆独",
      "翻墙", "VPN翻墙", "代理上网",
      "反动言论", "推翻政府", "颠覆国家",
      "国家机密", "敏感政治", "言论审查"
    ]
  }
];

function normalizeModerationText(text) {
  return String(text || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s.,!?;:'"`~@#$%^&*()[\]{}<>\\/|+=_，。！？；：、"'“”‘’（）【】《》·…￥-]+/g, "");
}

function checkInputModeration(text) {
  const compactText = normalizeModerationText(text);
  // 用于增强检测绕过能力
  const rawText = String(text || "").toLowerCase();
  if (!compactText) return null;

  for (const rule of MODERATION_RULES) {
    const term = rule.terms.find(item => {
      const compactTerm = normalizeModerationText(item);
      return (
        compactTerm &&
        (compactText.includes(compactTerm) || rawText.includes(item.toLowerCase()))
      );
    });

    if (term) {
      return {
        category: rule.category,
        term
      };
    }
  }

  return null;
}

function refuseModeratedInput(result) {
  console.warn("前端审核拦截:", result);
  showToast("内容未通过审核，请修改后再发送");
  addMessage(MODERATION_REFUSAL_TEXT, "ai");
  if (!window._isMobile) input.focus();
}

async function send() {
  if (pendingFiles.length > 0) {
  showGlobalLoading(); // ⭐ 上传才显示
}
  // ===== 轻量防抖（不阻止发送，只提示） =====
  const now = Date.now();
  if (window._lastSendTime && now - window._lastSendTime < 800) {
    console.warn("发送过快");
  }
  window._lastSendTime = now;
  if (sendingLock) {
    console.warn("发送被锁定，跳过");
    hideGlobalLoading();
    return;
  }

  if (!(await requireLoginForAction())) {
    hideGlobalLoading();
    return;
  }

  const text = input.value.trim();
  const moderationText = [
    text,
    ...pendingFiles.map(file => file.name)
  ].join(" ");
  const moderationResult = checkInputModeration(moderationText);

  if (moderationResult) {
    refuseModeratedInput(moderationResult);
    hideGlobalLoading();
    return;
  }

  sendingLock = true; // ⭐ 审核通过后立即加锁

  if (deepMode && !isActivated) {
    deepMode = false;
    updateDeepButton();
    showProRequiredModal();
    sendingLock = false;
    hideGlobalLoading();
    return;
  }

  // ===== ⭐ 前端轻量限频（替代服务端） =====
  if (window._lastRealSend && Date.now() - window._lastRealSend < 800) {
    showToast("操作太快了，慢一点 😅");
    sendingLock = false;
    hideGlobalLoading();
    return;
  }
  window._lastRealSend = Date.now();

  // ⭐ 合并上传文件
  if (pendingFiles.length) {
    for (const file of pendingFiles) {
      const reader = new FileReader();

      await new Promise(resolve => {
        reader.onload = () => {
          if (file.type.startsWith("image/")) {
            // 前端显示图片（用 img 标签）
            addMessage(`<img src="${reader.result}" style="max-width:100%;border-radius:10px;">`, "user");

            // history 只存描述，避免 base64 爆炸
            history.push({ role: "user", content: "[用户发送了一张图片]" });
          } else {
            addMessage(`📄 ${file.name}`, "user");
            history.push({ role: "user", content: `[用户上传文件: ${file.name}]` });
          }
          resolve();
        };
        reader.readAsDataURL(file);
      });
    }

    pendingFiles = [];
    previewBox.innerHTML = "";
  }

  // 空内容直接退出（但不锁死）
  if (!text) {
    sendingLock = false;
    hideGlobalLoading();
    return;
  }

  document.body.classList.add("thinking-mode");
  input.readOnly = true;
  const welcome = document.getElementById("welcome");
  if (welcome) {
    welcome.classList.add("hidden");
    setTimeout(() => welcome.remove(), 300);
  }

  // ✅ 动画结束后彻底移除（防止占位）
  setTimeout(() => {
    if (welcome) welcome.remove();
  }, 300);

  addMessage(text, "user");
  if (navigator.vibrate) navigator.vibrate(10);
  history.push({ role: "user", content: text });
  if (currentId) {
    const c = conversations.find(x => x.id === currentId);
    if (c && c.title === "新对话") {
      c.title = text.length > 15 ? text.slice(0, 15) + "…" : text;
      renderChatList();
      saveConversations();
    }
  }
  lastUserMessage = text;
  input.value = "";
  input.style.height = "auto";

  addMessage('<span class="thinking"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span>', "ai");

  const lastMsg = chatInner.lastElementChild;
  const bubble = lastMsg ? lastMsg.querySelector(".bubble") : null;

  // ⭐ 确保思考动画至少显示一段时间（避免瞬间跳结果）
  const minThinkingTime = 500; // ms
  const thinkingStart = Date.now();

  // 状态切换
  window._isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

controller = window._isMobile ? null : new AbortController();
isStreaming = true;

  let fullText = "";
  // ⭐ 优化：延长超时 + 软超时提示（避免安卓误杀）
  let softTimeoutShown = false;

  const timeoutId = setTimeout(() => {
    if (!softTimeoutShown && bubble && !fullText) {
      bubble.innerHTML = '<small style="color:#999;">响应较慢，请稍等…</small>';
      softTimeoutShown = true;
    }
  }, 15000);

  // ⭐ 仅桌面端才允许硬中断（移动端禁止，避免误报网络问题）
  let hardTimeoutId = null;
  if (!window._isMobile) {
    hardTimeoutId = setTimeout(() => {
      if (controller) controller && controller.abort && controller.abort();
      isStreaming = false;
    }, 40000);
  }
  try {
    console.log("准备发送请求", { session, history });
    // ⭐ 检查本地 token（替代 supabase session 检查）
    const token = localStorage.getItem("token");
    if (!token) {
      alert("登录状态失效，请重新登录");
      showLoginPrompt();
      sendingLock = false;
      hideGlobalLoading();
      return;
    }

    // ===== ⭐ 主请求（已通过关键词 + 模型双重审核）=====
    // --- Non-streaming fetch ---
    console.log("开始 fetch");
    const res = await apiFetch({
  model: currentModel,
      
      messages: history,
      deep: deepMode
    });
    if (res && res.status === 429) {
  showLimitModal();
  sendingLock = false;
  return;
}
    console.log("fetch 已返回", res);

    if (!res.ok) {
      const errText = await res.text();
      console.error("API错误:", res.status, errText);
      alert("请求失败：" + res.status + "\n" + errText);

      if (bubble) {
        bubble.innerHTML = `<small style="color:#ef4444;">请求失败 (${res.status})</small>`;
      }
      throw new Error(errText || "API响应异常");
    }

    // ===== 读取剩余次数（来自响应头）=====
const remain = parseInt(res.headers.get("x-remain") ?? "-1");
if (!isActivated && remain >= 0) {
  const hintEl = document.getElementById("usageHint");
  if (hintEl) hintEl.innerText = `今日剩余 ${remain} 次`;
}

// ===== SSE 流式读取 =====
const reader = res.body.getReader();
const decoder = new TextDecoder();
let reasoning = "";
let reasoningDiv = null;
let reasoningContent = null;
let contentDiv = null;

// 清空思考动画
if (bubble) {
  bubble.innerHTML = "";
}

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  const chunk = decoder.decode(value, { stream: true });
  const lines = chunk.split("\n");

  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const raw = line.slice(6).trim();
    if (raw === "[DONE]") break;

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    const delta = parsed.choices?.[0]?.delta || {};

    // ===== 深度思考内容 =====
    if (delta.reasoning_content) {
      reasoning += delta.reasoning_content;

      if (!reasoningDiv) {
        reasoningDiv = document.createElement("div");
        reasoningDiv.style.cssText = `
          font-size:12px;color:#888;margin-bottom:8px;
          border-left:3px solid #22d3ee;padding-left:8px;line-height:1.5;
        `;
        const title = document.createElement("div");
        title.innerText = "🧠 思考过程";
        title.style.marginBottom = "4px";
        reasoningContent = document.createElement("div");
        reasoningDiv.appendChild(title);
        reasoningDiv.appendChild(reasoningContent);
        bubble.appendChild(reasoningDiv);
      }

      reasoningContent.innerHTML = marked.parse(reasoning);
    }

    // ===== 正文内容 =====
    if (delta.content) {
      fullText += delta.content;

      if (!contentDiv) {
        contentDiv = document.createElement("div");
        bubble.appendChild(contentDiv);
      }

      contentDiv.innerHTML = marked.parse(fullText);

      if (isNearBottom()) chat.scrollTop = chat.scrollHeight;
    }
  }
}

// ===== 流结束后加重生按钮 =====
if (bubble && fullText) {
  // 兜底：内容为空时提示
  if (!bubble.innerHTML.trim()) {
    bubble.innerText = "返回为空，请重试";
  }

  const regenWrap = document.createElement("div");
  regenWrap.className = "regen";
  regenWrap.innerHTML = `<button class="regen-btn">↻</button>`;
  bubble.appendChild(regenWrap);
}
    history.push({ role: "assistant", content: fullText });

    if (currentId) {
      const c = conversations.find(x => x.id === currentId);
      if (c) {
        c.history = [...history];
        c.updatedAt = Date.now();
        // ⭐ 保证“空新对话”始终在最顶部
        const emptyChat = conversations.find(c => !c.history || c.history.length <= 1);

        conversations.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

        if (emptyChat) {
          conversations = conversations.filter(c => c.id !== emptyChat.id);
          conversations.unshift(emptyChat);
        }
        // ⭐ AI生成标题（仅第一次AI回复时）
        if (history.length === 3 && !c._autoTitle) {
          const userMsg = history.find(m => m.role === "user")?.content || "";
          const aiMsg = fullText || "";
          c._autoTitle = true; // ✅ 允许AI改标题
          renderChatList();
          saveConversations();
          // 异步用AI生成更好的标题
          generateTitleFromAI(userMsg, aiMsg).then(title => {
            if (!title) {
              const fallback = userMsg.slice(0, 12).replace(/\n/g, " ");
              const currentChat = conversations.find(x => x.id === currentId);
              if (currentChat && currentChat._autoTitle) {
  currentChat.title = fallback || "新对话";
  currentChat._autoTitle = false;
  renderChatList();
  saveConversations();
}
              return;
            }
            const currentChat = conversations.find(x => x.id === currentId);
            if (!currentChat) return;

// ⭐只有自动标题才允许被AI覆盖
if (currentChat._autoTitle) {
              currentChat.title = "";
              let i = 0;
              const finalTitle = title;

              currentChat.title = finalTitle;
renderChatList();

setTimeout(() => {
  const items = document.querySelectorAll("#chatList div span:first-child");

  items.forEach(el => {
    if (el.innerText === finalTitle) {
      el.style.opacity = "0";
      el.style.transform = "translateY(4px)";
      el.style.transition = "all .25s ease";

      requestAnimationFrame(() => {
        el.style.opacity = "1";
        el.style.transform = "translateY(0)";
      });
    }
  });
}, 0);

currentChat._autoTitle = false;
currentChat.updatedAt = Date.now();
              conversations.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
              saveConversations();
              // renderChatList(); // Already called in animation
            }
          });
        }
      }
      saveConversations();
      renderChatList();
    }
    if (history.length > 20) {
      const systemMsg = history[0];
      const rest = history.slice(-19);
      history = [systemMsg, ...rest];
    }

    document.querySelectorAll("pre code").forEach(el => {
      hljs.highlightElement(el);
      if (el.parentElement.querySelector(".copy-btn")) return;
      // ===== 语言标签 =====
      const lang = el.className.match(/language-(\w+)/)?.[1];
      if (lang) {
        const langTag = document.createElement("span");
        langTag.className = "lang-tag";
        langTag.innerText = lang;
        el.parentElement.appendChild(langTag);
      }
      // ===== 复制按钮 =====
      const btn = document.createElement("button");
      btn.className = "copy-btn";
      btn.innerText = "复制";
      btn.onclick = () => {
        navigator.clipboard.writeText(el.innerText).then(() => {
          btn.innerText = "已复制 ✓";
          setTimeout(() => btn.innerText = "复制", 1500);
        });
      };
      el.parentElement.style.position = "relative";
      el.parentElement.appendChild(btn);
    });
    clearTimeout(timeoutId);
    clearTimeout(hardTimeoutId);
  } catch (err) {
    clearTimeout(timeoutId);
    clearTimeout(hardTimeoutId);
    if (fullText) {
      console.warn("stream end (ignored):", err);
    } else {
      if (err.name === "AbortError") {
        console.warn("Abort（忽略移动端）");

        // ⭐ 移动端直接忽略 abort（不显示错误）
        if (window._isMobile) {
          return;
        }

        // 有内容就不提示
        if (bubble && fullText) return;

        if (bubble) {
          bubble.innerHTML =
            '<small style="color:#999;">请求较慢，请稍后</small>';
        }
      } else {
        console.error("真实错误:", err);

// ⭐ 移动端自动重试一次（关键！）
if (window._isMobile) {
  if (!window._retryOnce) {
    window._retryOnce = true;
    console.warn("移动端自动重试一次...");
    sendingLock = false;
    setTimeout(() => send(), 500);
    return;
  } else {
    window._retryOnce = false;
  }
}
if (bubble) {
  bubble.innerHTML =
    '<small style="color:#999;">请求异常，请稍后重试</small>';
}
      }
    }
  }
  finally {
    clearTimeout(timeoutId);
    clearTimeout(hardTimeoutId);
    sendingLock = false;
    hideGlobalLoading();
    document.body.classList.remove("thinking-mode");
    input.readOnly = false;
    if (!window._isMobile) input.focus();
    input.style.height = "auto";
    isStreaming = false;
    controller = null;
    window._retryOnce = false;

    // ⭐ 不再重复渲染 bubble，只绑定 regen 按钮事件
    if (bubble && fullText) {
      const regenBtn = bubble.querySelector(".regen-btn");
      if (regenBtn) {
        regenBtn.onclick = () => {
          const msgDiv = bubble.closest(".message");
          if (msgDiv) msgDiv.remove();

          if (history.length && history[history.length - 1].role === "assistant") {
            history.pop();
          }

          if (!sendingLock) {
            input.value = lastUserMessage;
            send();
          }
        };
      }
    }
  }

}

input.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

window.addEventListener("load", () => {
  if (!window._isMobile) input.focus();
});
document.getElementById("newChatBtn").onclick = createNewChat;
if (!conversations.length) {
  createNewChat();
}

renderChatList();
const sidebar = document.getElementById("sidebar");
const toggle = document.getElementById("menuToggle");
const overlay = document.getElementById("sidebarOverlay");

// 移动端默认关闭 sidebar（使用 open 控制）
if (window.innerWidth <= 768) {
  sidebar.classList.remove("open");
}

if (toggle) {
  toggle.onclick = (e) => {
    e.stopPropagation();
    toggleSidebar();
  };
}

overlay.onclick = () => {
  setSidebarOpen(false);
};

// 页面初始化时确保遮罩关闭（防止残留挡住点击）
overlay.classList.remove("active");

// 在 window resize 时自动修复（防止切换设备尺寸后异常）
window.addEventListener("resize", () => {
  requestAnimationFrame(setupSidebarByDevice);
});
// ===== Scroll to Bottom Button =====
const scrollBtn = document.getElementById("scrollBottomBtn");

if (scrollBtn) {
  // 监听滚动，离底部超过 150px 才显示
  chat.addEventListener("scroll", () => {
    const distFromBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight;
    if (distFromBottom > 150) {
      scrollBtn.style.opacity = "1";
scrollBtn.style.pointerEvents = "auto";
scrollBtn.style.transform = "translateY(0) scale(1)";
    } else {
      scrollBtn.style.opacity = "0";
scrollBtn.style.pointerEvents = "none";
scrollBtn.style.transform = "translateY(8px) scale(0.9)";
    }
  });

  // 点击滚到底部
  scrollBtn.onclick = () => {
    chat.scrollTo({ top: chat.scrollHeight, behavior: "smooth" });
  };
}
// ⭐ 定时兜底同步
setInterval(async () => {
  if (session && session.user) {
    await syncFromCloud();
    scheduleRenderUser();
  }
}, 15000);

// ===== Pro按钮点击事件绑定 =====
const proBtn = document.getElementById("proBtn");
if (proBtn) {
  proBtn.onclick = () => {
    showActivationModal();
  };
}
const deepBtn = document.getElementById("deepBtn");

if (deepBtn) {
  deepBtn.onclick = async () => {
    if (!(await requireLoginForAction())) return;

    if (!isActivated) {
      deepMode = false;
      updateDeepButton();
      showProRequiredModal();
      return;
    }

    deepMode = !deepMode;
    updateDeepButton();

    showToast(deepMode ? "深度思考已开启 🧠" : "深度思考已关闭");
  };
}
// ===== 从设置页跳转自动打开升级 =====
if (window.location.hash === "#upgrade") {
  setTimeout(() => {
    showActivationModal();
  }, 300);
}

// ⭐ 再兜底一次（防止前面报错导致未执行）
window.addEventListener("DOMContentLoaded", () => {
  try {
    scheduleRenderUser();
  } catch (e) {
    console.warn("renderUser fallback error:", e);
  }
});
/* ===== 登录状态补丁（跨页面返回恢复·增强版） ===== */

async function restoreLoginState() {
  if (restoreLoginPromise) return restoreLoginPromise;

  const version = bumpRestoreVersion();
  restoreLoginPromiseVersion = version;

  restoreLoginPromise = (async () => {
    try {
      console.log("🔄 恢复登录状态", version);

      await checkLogin({
        skipCloudSync: true,
        skipChatReload: true,
        restoreVersion: version,
      });
      if (isRestoreStale(version)) return;

      if (session?.user) {
        await syncFromCloud();
      }
      if (isRestoreStale(version)) return;

      finalizeRenderUser(version);
    } catch (e) {
      console.warn("恢复登录失败:", e);
      if (!isRestoreStale(version)) {
        sessionReady = true;
        finalizeRenderUser(version);
      }
    } finally {
      if (restoreLoginPromiseVersion === version) {
        restoreLoginPromise = null;
      }
    }
  })();

  return restoreLoginPromise;
}

window.addEventListener("focus", restoreLoginState);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    restoreLoginState();
  }
});

window.addEventListener("pageshow", (e) => {
  if (e.persisted) restoreLoginState();
});
