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

// ===== ⭐ 登录跳转：统一改为独立登录页 login.html（携带来源页，登录后自动返回）=====
function goToLogin() {
  // ⭐ 关键修复：跳转前必须清掉本地残留的 token/user。
  //    login.html 头部有一个“已登录守卫”——只要 localStorage 里存在一个
  //    未过期的 token，就会立即把用户弹回来源页（return 参数指向的页面）。
  //    如果这里不清掉，就会出现“点击登录却又被弹回 ai.html 原地”的现象。
  //    我们能走到这里，说明本地会话在 ai.html 侧已经被判定为不可用，
  //    所以直接清空是安全的，能保证真正进入登录表单。
  try {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
  } catch (e) {}
  window.clearVerifiedSession?.();
  location.href = "login.html?return=ai.html";
}
window.goToLogin = goToLogin;
// 兼容旧调用点（如 ai/user-menu.js）：showLoginPrompt 现在直接跳转到 login.html
window.showLoginPrompt = goToLogin;

// ===== ⭐ 全局API封装（使用本地token）=====
async function apiFetch(body, _retried = false, signal = undefined) {
  let token = localStorage.getItem("token");
  if (!token) return null;

  async function refreshToken() {
    const old = localStorage.getItem("token");
    if (!old) return null;
    const identity = await resolveAndStoreIdentity({
      token: old,
      expectedUserId: session?.userId ?? null,
      force: true,
    });
    return getVerifiedToken(identity);
  }

  // Session 中的身份与 Token 必须来自同一次服务端验证。
  const currentIdentity = getCurrentVerifiedIdentity();
  if (token && (!currentIdentity || getVerifiedToken(currentIdentity) !== token)) {
    const newToken = await refreshToken();
    if (!newToken) return null;
    token = newToken;
  }

  const res = await fetch("https://api.sunland.dev", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "Authorization": "Bearer " + token } : {})
    },
    body: JSON.stringify(body),
    signal,
  });

  // ⭐ 如果401 → 尝试刷新一次
  if (res.status === 401 && !_retried) {
    // 只重试一次，防止死循环
    const newToken = await refreshToken();

    if (newToken) {
      return apiFetch(body, true, signal);
    }
    // refresh 失败才真正登出
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    alert("登录已过期，请重新登录");
    goToLogin();
    return null;
  }

  // ⭐ fallback 401 guard after retry
  if (res.status === 401 && _retried) {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    alert("登录已过期，请重新登录");
    goToLogin();
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
const deepBtn = document.getElementById("deepBtn");
const previewBox = document.getElementById("uploadPreview");
let pendingFiles = [];
let providerCapabilityState = {
  deepThinking: true,
  fileUpload: true,
};

function clearPendingAttachments() {
  previewBox.querySelectorAll('img[src^="blob:"]').forEach(img => {
    try { URL.revokeObjectURL(img.src); } catch {}
  });
  pendingFiles = [];
  fileInput.value = "";
  previewBox.innerHTML = "";
}

uploadBtn.onclick = async () => {
  if (!providerCapabilityState.fileUpload) return;
  if (!(await requireLoginForAction())) return;
  if (!providerCapabilityState.fileUpload) return;
  fileInput.click();
};

fileInput.onchange = async () => {
  if (!providerCapabilityState.fileUpload) {
    fileInput.value = "";
    return;
  }
  if (!(await requireLoginForAction())) {
    fileInput.value = "";
    return;
  }
  if (!providerCapabilityState.fileUpload) {
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

  if (!providerCapabilityState.fileUpload) {
    e.preventDefault();
    return;
  }

  if (!(await requireLoginForAction())) {
    e.preventDefault();
    return;
  }
  if (!providerCapabilityState.fileUpload) {
    e.preventDefault();
    return;
  }

  files.forEach(handleFile);
});

// ===== 拖拽上传 =====
chat.addEventListener("dragover", (e) => {
  e.preventDefault();
  if (!providerCapabilityState.fileUpload && e.dataTransfer) {
    e.dataTransfer.dropEffect = "none";
  }
});

chat.addEventListener("drop", async (e) => {
  e.preventDefault();
  const files = Array.from(e.dataTransfer.files);
  if (files.length && !providerCapabilityState.fileUpload) return;
  if (files.length && !(await requireLoginForAction())) return;
  if (!providerCapabilityState.fileUpload) return;
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

    if (!session?.userId) return;

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
      <div data-error-title style="font-weight:600;margin-bottom:6px;">
      </div>

      <div style="color:#666;font-size:12px;margin-bottom:10px;">
        请复制错误信息发送给开发者
      </div>

      <textarea data-error-detail readonly style="
        width:100%;
        height:100px;
        border-radius:10px;
        border:1px solid #ddd;
        padding:6px;
        font-size:11px;
      "></textarea>

      <div style="display:flex;gap:6px;margin-top:8px;">
        <button id="copyErr">复制</button>
        <button id="closeErr">关闭</button>
      </div>
    </div>
  `;

  box.querySelector("[data-error-title]").textContent = `❌ ${title}`;
  box.querySelector("[data-error-detail]").value = detail;

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

  if (getCurrentVerifiedIdentity()) return true;

  await checkLogin();
  if (getCurrentVerifiedIdentity()) return true;

  goToLogin();
  return false;
}

// ===== 统一文件处理函数 =====
function handleFile(file) {
  if (!providerCapabilityState.fileUpload) return false;

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

  return true;
}

// ⭐ Sunland AI Provider 框架（Stage 3.5-3.7）：ai.html 只通过 providerRegistry
// 统一接口与各 Provider 通信；DeepSeek 现有逻辑保持不变，只有新增的 Sunland
// 分支会用到这个 registry。
import { createProviderRegistry } from './providers/registry.js';
import {
  filterConversationsForUser,
  persistCurrentConversationId,
  restoreLocalConversationState,
} from './conversation-recovery.js';
import { renderSafeMarkdown } from './safe-markdown.js';
import {
  RequestCoordinator,
  applyRequestTitle,
  cloneRequestHistory,
  isRequestVisibleForConversation,
} from './request-context.js';
import {
  getSunlandKnowledgeStorageKey,
  isSameUserIdentity,
  SUNLAND_LOGIN_STATE_MESSAGE,
} from './user-identity.js';
import {
  createConversation,
  hasConversationStarted,
  isSupportedProviderId,
  mergeConversationCollections,
  setConversationProvider,
} from './providers/conversation.js';
import {
  getVerifiedToken,
  getVerifiedUserId,
  IdentityAuthority,
  isVerifiedIdentity,
} from './verified-identity.js';
import { createSunlandDiagnosticsRuntime } from './beta-diagnostics/runtime.js';

const identityAuthority = new IdentityAuthority();
const sunlandDiagnosticsRuntime = createSunlandDiagnosticsRuntime({
  getIdentity: getCurrentVerifiedIdentity,
  storageRef: localStorage,
  windowRef: window,
});

// `apiFetch` is a hoisted function declaration (defined below), so it's
// already safely referenceable here at module-eval time.
let providerRegistry = createProviderRegistry({ sendRequest: apiFetch });

function createOfflineSupabaseClient() {
  const offlineResult = () => Promise.resolve({ data: null, error: null });
  const createQuery = () => {
    const query = {
      select: () => query,
      eq: () => query,
      is: () => query,
      limit: () => query,
      order: () => query,
      update: () => query,
      upsert: () => query,
      maybeSingle: offlineResult,
      single: offlineResult,
      then: (resolve, reject) => offlineResult().then(resolve, reject),
      catch: (reject) => offlineResult().catch(reject)
    };
    return query;
  };

  return {
    __offline: true,
    from: () => createQuery(),
    channel: () => {
      const channel = {
        on: () => channel,
        subscribe: () => channel
      };
      return channel;
    },
    removeChannel: () => {}
  };
}

let supabase = createOfflineSupabaseClient();

import('../p/js/supabaseClient.js')
  .then((module) => {
    if (module?.supabase) {
      supabase = module.supabase;
      if (session?.userId) {
        const identity = getCurrentVerifiedIdentity();
        if (identity) setSession(identity);
        restoreLoginState();
      }
    }
  })
  .catch((error) => {
    console.warn("Supabase 客户端加载失败，已启用本地离线模式:", error);
  });

let session = null;
const PROFILE_META_ID = "__xixi_user_profile__";
const PROFILE_CACHE_PREFIX = "xixi_profile_";

let realtimeChannels = [];

function getCurrentVerifiedIdentity() {
  const identity = identityAuthority.current();
  return identity && session?.identity === identity ? identity : null;
}

function getCurrentUserId() {
  return getVerifiedUserId(getCurrentVerifiedIdentity());
}

function readCachedDisplayUser() {
  try {
    const cached = JSON.parse(localStorage.getItem("user") || "null");
    return cached && typeof cached === "object" && !Array.isArray(cached) ? cached : null;
  } catch {
    return null;
  }
}

function persistVerifiedIdentity(identity) {
  const userId = getVerifiedUserId(identity);
  const token = getVerifiedToken(identity);
  if (!userId || !token) return false;
  localStorage.setItem("token", token);
  localStorage.setItem("user", JSON.stringify({
    ...identity.user,
    // Compatibility cache only. Authentication never reads this field.
    id: userId,
  }));
  return true;
}

async function resolveIdentityResult({ token, expectedUserId = null, force = false } = {}) {
  const result = await identityAuthority.resolve({
    token,
    cachedUser: readCachedDisplayUser(),
    expectedUserId,
    force,
  });
  if (!result.ok || !isVerifiedIdentity(result.identity)) return result;
  persistVerifiedIdentity(result.identity);
  if (session?.identity !== result.identity) setSession(result.identity);
  await sunlandDiagnosticsRuntime.initialize();
  return result;
}

async function resolveAndStoreIdentity(options = {}) {
  const result = await resolveIdentityResult(options);
  return result.ok ? result.identity : null;
}

function setSession(identity) {
  const previousUserId = session?.userId ?? null;
  // ⭐ 清理旧订阅（不然会叠加）
  stopRealtime();
  realtimeChannels.forEach(ch => {
    try { supabase.removeChannel(ch); } catch {}
  });
  realtimeChannels = [];

  if (identity != null && !isVerifiedIdentity(identity)) {
    throw new TypeError("Session requires a verified identity");
  }
  const userId = getVerifiedUserId(identity);
  session = userId
    ? { userId, identity, user: identity.user }
    : null;
  window.session = session;
  if (previousUserId && previousUserId !== userId) {
    deletedConversationIds.clear();
    deletingConversationIds.clear();
  }

  if (!userId) return;

    const profileChannel = supabase
      .channel('profile-sync-' + userId)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'user_profiles',
        filter: `user_id=eq.${userId}`
      }, (payload) => {
        if (getCurrentUserId() !== userId) return;
        try {
          const profile = payload.new;
          if (profile?.avatar_url) {
            cacheProfile(userId, profile);
            currentProfile = profile;
            scheduleRenderUser();
          }
        } catch {}
      })
      .subscribe();

    const chatChannel = supabase
      .channel('chat-sync-' + userId)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'conversations',
        filter: `user_id=eq.${userId}`
      }, async () => {
        if (getCurrentUserId() !== userId) return;
        try {
          await syncFromCloud();
          if (getCurrentUserId() === userId && currentId) loadChat(currentId);
        } catch {}
      })
      .subscribe();

    realtimeChannels.push(profileChannel, chatChannel);
}

function clearVerifiedSession() {
  identityAuthority.clear();
  setSession(null);
  void sunlandDiagnosticsRuntime.initialize();
  deletedConversationIds.clear();
  deletingConversationIds.clear();
  conversations = [];
  currentId = null;
  history = history.length ? [history[0]] : [];
}
window.clearVerifiedSession = clearVerifiedSession;
let isActivated = false;
let deepMode = false;
let currentModel = "deepseek-v4-flash";
let currentProfile = null;
let conversations = []; // ⭐ 提前声明，避免 TDZ
let chatSearchKeyword = "";
const deletedConversationIds = new Set();
const deletingConversationIds = new Set();

function renderHighlightedTitle(target, title, keyword) {
  target.textContent = "";

  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = title.matchAll(new RegExp(escaped, "gi"));
  let lastIndex = 0;

  for (const match of matches) {
    target.appendChild(document.createTextNode(title.slice(lastIndex, match.index)));

    const mark = document.createElement("mark");
    mark.style.cssText = "background:rgba(34,211,238,0.3);border-radius:4px;padding:0 2px;";
    mark.textContent = match[0];
    target.appendChild(mark);
    lastIndex = match.index + match[0].length;
  }

  target.appendChild(document.createTextNode(title.slice(lastIndex)));
}

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
    div.className = "chat-list-item";

    const title = c.title || "新对话";
    const titleEl = document.createElement("span");
    titleEl.className = "chat-list-title";

    if (chatSearchKeyword) {
      renderHighlightedTitle(titleEl, title, chatSearchKeyword);
    } else {
      titleEl.innerText = title;
    }
    div.appendChild(titleEl);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "delete-chat";
    deleteBtn.innerText = "×";
    deleteBtn.setAttribute("aria-label", `删除对话：${title}`);
    deleteBtn.title = "删除对话";
    deleteBtn.disabled = deletingConversationIds.has(c.id);
    deleteBtn.onclick = async (e) => {
      e.stopPropagation();
      await deleteConversationForCurrentUser(c);
    };
    div.appendChild(deleteBtn);

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

function normalizeCloudData(data, userId = getCurrentUserId()) {
  const profile = extractProfileMeta(data);
  const profileMatchesUser = profile?.user_id == null || profile.user_id === userId;
  if (profile?.avatar_url && profileMatchesUser && userId && getCurrentUserId() === userId) {
    cacheProfile(userId, profile);
  }

  return stripProfileMeta(data);
}

function buildCloudData(
  userId = getCurrentUserId(),
  sourceConversations = conversations,
) {
  const rows = filterConversationsForUser(
    stripProfileMeta(sourceConversations),
    userId,
  )
    .filter(conversation => !deletedConversationIds.has(conversation.id));
  if (currentProfile?.avatar_url && userId) {
    rows.unshift({
      id: PROFILE_META_ID,
      type: "profile",
      profile: {
        ...currentProfile,
        user_id: userId,
        email: session.user.email || "",
        updated_at: currentProfile.updated_at || new Date().toISOString()
      }
    });
  }
  return rows;
}

async function loadUserProfileFromCloud() {
  const userId = getCurrentUserId();
  if (!userId) return;

  const cached = loadCachedProfile(userId);
  if (cached?.avatar_url) {
    currentProfile = cached;
    scheduleRenderUser();
  }

  try {
    const { data, error } = await supabase
      .from("user_profiles")
      .select("avatar_url, avatar_path, name, pro")
      .eq("user_id", userId)
      .maybeSingle();

    if (getCurrentUserId() !== userId) return;

    if (error) throw error;

    if (data) {
      cacheProfile(userId, data);
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

  btn.classList.toggle(
    "active",
    providerCapabilityState.deepThinking && deepMode,
  );
}

function updateProviderCapabilityUI() {
  const conversation = conversations.find(item => item.id === currentId);
  const isSunland = conversation?.provider === "sunland";

  providerCapabilityState = {
    deepThinking: !isSunland,
    fileUpload: !isSunland,
  };

  const deepDisabledMessage = "Sunland AI · Beta 暂不支持深度思考";
  const uploadDisabledMessage = "Sunland AI · Beta 暂不支持文件上传";

  deepBtn.disabled = isSunland;
  deepBtn.setAttribute("aria-disabled", String(isSunland));
  deepBtn.setAttribute(
    "aria-label",
    isSunland ? deepDisabledMessage : "深度思考",
  );
  deepBtn.title = isSunland ? deepDisabledMessage : "深度思考";
  deepBtn.dataset.tooltip = isSunland ? deepDisabledMessage : "深度思考";
  deepBtn.classList.toggle("provider-capability-disabled", isSunland);

  uploadBtn.disabled = isSunland;
  uploadBtn.setAttribute("aria-disabled", String(isSunland));
  uploadBtn.setAttribute(
    "aria-label",
    isSunland ? uploadDisabledMessage : "上传文件",
  );
  uploadBtn.title = isSunland ? uploadDisabledMessage : "上传文件";
  uploadBtn.dataset.tooltip = isSunland ? uploadDisabledMessage : "上传文件";
  uploadBtn.classList.toggle("provider-capability-disabled", isSunland);

  fileInput.disabled = isSunland;
  fileInput.setAttribute("aria-disabled", String(isSunland));
  fileInput.title = isSunland ? uploadDisabledMessage : "";

  if (isSunland) clearPendingAttachments();

  updateDeepButton();
}
function updateModelUI() {
  const el = document.getElementById("modelSelector");
  updateProviderCapabilityUI();
  if (!el) return;

  // ⭐ Sunland AI: Provider 一旦绑定即锁定显示，不再跟随 currentModel。
  const c = conversations.find(x => x.id === currentId);
  if (c && c.provider === "sunland") {
    const isLocked = hasConversationStarted(c);
    const label = "Sunland AI · Beta";
    const lockMessage = "当前对话已绑定 Sunland AI。请新建对话以切换模型。";
    el.innerHTML = '<img src="p/studio.png" alt="" aria-hidden="true" style="width:20px;height:20px;border-radius:5px;flex-shrink:0;">Sunland AI · Beta';
    el.classList.toggle("locked", isLocked);
    el.setAttribute("aria-label", isLocked ? lockMessage : label);
    el.title = isLocked ? lockMessage : label;
    return;
  }
  el.classList.remove("locked");

  if (currentModel === "deepseek-v4-pro") {
    el.innerText = "Pro";
    el.setAttribute("aria-label", "DeepSeek V4 Pro");
    el.title = "DeepSeek V4 Pro";
  } else {
    el.innerText = "Flash";
    el.setAttribute("aria-label", "DeepSeek V4 Flash");
    el.title = "DeepSeek V4 Flash";
  }
}

function getProviderBindingMessage(conversation) {
  return conversation?.provider === "sunland"
    ? "当前对话已绑定 Sunland AI。请新建对话以切换模型。"
    : "当前对话已绑定 DeepSeek。请新建对话以切换模型。";
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
      const c = conversations.find(x => x.id === currentId);
      if (!["sunland", "flash", "pro"].includes(model)) {
        modelMenu.classList.remove("show");
        return;
      }
      // Provider 在第一条非 system 消息写入后立即锁定。
      const hasStarted = hasConversationStarted(c);

      // ⭐ Sunland AI（新增分支，完全独立于下面 DeepSeek 的现有逻辑）
      if (model === "sunland") {
        if (hasStarted && c.provider !== "sunland") {
          showToast(getProviderBindingMessage(c));
          modelMenu.classList.remove("show");
          return;
        }
        if (c) {
          if (!setConversationProvider(c, "sunland", "frost")) {
            showToast(getProviderBindingMessage(c));
            modelMenu.classList.remove("show");
            return;
          }
          saveConversations();
        }
        updateModelUI();
        modelMenu.classList.remove("show");
        return;
      }
      if (hasStarted && c.provider === "sunland") {
        showToast(getProviderBindingMessage(c));
        modelMenu.classList.remove("show");
        return;
      }

      // ⭐ Pro权限（DeepSeek 现有逻辑，不变）
      if (model === "pro" && !isActivated) {
        showProModelModal();
        return;
      }

      currentModel =
        model === "pro"
          ? "deepseek-v4-pro"
          : "deepseek-v4-flash";

      // 🆕 记录这条对话使用的 provider/model（不影响任何既有行为，仅补充字段）
      if (c) {
        if (!setConversationProvider(c, "deepseek", currentModel)) {
          showToast(getProviderBindingMessage(c));
          modelMenu.classList.remove("show");
          return;
        }
        saveConversations();
      }

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
  const userId = getCurrentUserId();
  if (!userId) return;

  // ⭐ Pro 判定唯一真值源：user_profiles.pro（爱发电付款由 afdianpay worker 回调写入）。
  //    激活码系统已弃用；历史激活码用户的 pro 已回填，故不再查 activation_codes。
  const { data: prof } = await supabase
    .from("user_profiles")
    .select("pro")
    .eq("user_id", userId)
    .maybeSingle();

  if (getCurrentUserId() !== userId) return;

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
      .eq("user_id", userId)
      .maybeSingle();

    if (getCurrentUserId() !== userId) return;

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
let lastIdentityErrorReason = "";

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
    const key = session?.userId
      ? `${session.userId}:${session.user.email || ""}:${isActivated ? 1 : 0}`
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
    const previousUserId = getCurrentUserId();

    try {
      const token = localStorage.getItem("token");
      if (!token) {
        identityAuthority.clear();
        setSession(null);
        await sunlandDiagnosticsRuntime.initialize();
        currentProfile = null;
      } else {
        const resolution = await identityAuthority.resolve({
          token,
          cachedUser: readCachedDisplayUser(),
        });
        if (expectedVersion != null && isRestoreStale(expectedVersion)) return;

        if (!resolution.ok || !isVerifiedIdentity(resolution.identity)) {
          if (resolution.reason === "stale-resolution") return;
          const hardFailure = [
            "invalid-input",
            "invalid-token",
            "invalid-verification-response",
            "invalid-verified-token",
            "identity-mismatch",
            "missing-identity",
            "expired-verified-token",
          ].includes(resolution.reason);
          if (hardFailure) {
            localStorage.removeItem("token");
            localStorage.removeItem("user");
          }
          identityAuthority.clear();
          setSession(null);
          await sunlandDiagnosticsRuntime.initialize();
          currentProfile = null;
          conversations = [];
          currentId = null;
          sessionReady = true;
          renderChatList();
          updateProviderCapabilityUI();
          if (lastIdentityErrorReason !== resolution.reason) {
            lastIdentityErrorReason = resolution.reason;
            showToast(SUNLAND_LOGIN_STATE_MESSAGE);
          }
          scheduleRenderUser();
          return;
        }

        lastIdentityErrorReason = "";
        persistVerifiedIdentity(resolution.identity);
        if (session?.identity !== resolution.identity) setSession(resolution.identity);
        await sunlandDiagnosticsRuntime.initialize();
      }

      if (expectedVersion != null && isRestoreStale(expectedVersion)) return;

      sessionReady = true;

      if (session?.userId) {
        currentProfile = loadCachedProfile(session.userId);
      }

      scheduleRenderUser();

      if (session?.userId) {
        loadUserProfileFromCloud().catch(() => {});

        const sameUserFallback = previousUserId === session.userId
          ? conversations
          : [];
        const restored = restoreLocalConversationState({
          storage: localStorage,
          userId: session.userId,
          fallbackConversations: sameUserFallback,
          fallbackCurrentId: previousUserId === session.userId ? currentId : null,
        });

        conversations = restored.conversations;
        currentId = restored.currentId;
        if (restored.status === "damaged" || restored.status === "invalid") {
          console.warn("本地会话数据无法解析，已保留可用的内存会话");
        }

        if (!skipCloudSync) {
          await syncFromCloud();
          if (expectedVersion != null && isRestoreStale(expectedVersion)) return;
        }
        renderChatList();
      } else {
        conversations = [];
        currentId = null;
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
      updateProviderCapabilityUI();
    } catch (e) {
      if (e?.name === "ReferenceError") throw e;

      console.error("登录检测异常:", e);
      sessionReady = true;
      if (expectedVersion == null || !isRestoreStale(expectedVersion)) {
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
  if (!session?.userId || !session.user){
  avatarEl.innerText = "?";
  avatarEl.style.backgroundImage = ""; // ⭐ 必加
  emailEl.innerText = "未登录";
  if (proBtn) proBtn.style.display = "none";
  lastRenderedUserKey = "guest";
  return;
}

  const user = session.user;
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
  // ===== Pro按钮 =====
  if (proBtn) {
    proBtn.style.display = isActivated ? "none" : "inline-block";
  }
  lastRenderedUserKey = `${session.userId}:${user.email || ""}:${isActivated ? 1 : 0}`;
}

function renderUser() {
  scheduleRenderUser();
}

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
      .eq("used_by", session.userId)
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
      if (data.used_by === session.userId) {
  isActivated = true;

  await supabase.from("user_profiles").upsert({
    user_id: session.userId,
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
        used_by: session.userId,
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
  user_id: session.userId,
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
  const userId = getCurrentUserId();
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
let controller = null;
let sendingLock = false;
let isStreaming = false;
let hasTypedOnce = false;       // ⭐ 只允许一次打字动画
let isLoadingHistory = false;   // ⭐ 是否在加载历史记录
let chatRenderVersion = 0;
let realtimeSub = null;
const sendBtn = document.getElementById("sendBtn");
sendBtn.type = "button"; // 防止被当成提交按钮
sendBtn.innerText = "↑";
let suppressNextSendClick = false;

const requestCoordinator = new RequestCoordinator({
  getConversation: conversationId => conversations.find(c => c.id === conversationId),
  getCurrentUserId,
  onConversationChanged: (requestContext, conversation) => {
    if (currentId === requestContext.conversationId) {
      history = cloneRequestHistory(conversation.history);
    }
    conversations.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    saveConversations();
    renderChatList();
    updateProviderCapabilityUI();
  },
});

function resetSunlandRuntimeCache(userId) {
  if (!userId || getCurrentUserId() !== userId) return;

  conversations.forEach(conversation => {
    if (conversation.provider !== "sunland") return;
    const activeRequest = requestCoordinator.activeForConversation(conversation.id);
    if (!activeRequest) return;
    requestCoordinator.abort(activeRequest, "sunland-data-cleared");
    requestCoordinator.finish(activeRequest, "aborted");
  });

  providerRegistry = createProviderRegistry({ sendRequest: apiFetch });
  updateRequestUiState();
}

window.addEventListener("storage", (event) => {
  const userId = getCurrentUserId();
  const knowledgeKey = getSunlandKnowledgeStorageKey(userId);
  if (!knowledgeKey) return;
  if (event.key !== knowledgeKey && event.key !== `${knowledgeKey}::memory`) return;
  resetSunlandRuntimeCache(userId);
});

if (typeof BroadcastChannel === "function") {
  const sunlandDataChannel = new BroadcastChannel("sunland-data-control-v1");
  sunlandDataChannel.addEventListener("message", event => {
    if (
      event.data?.type === "sunland-data-cleared" &&
      event.data.userId === getCurrentUserId()
    ) {
      resetSunlandRuntimeCache(event.data.userId);
    }
  });
}

function getVisibleRequest() {
  return requestCoordinator.activeForConversation(currentId);
}

function updateRequestUiState() {
  const visibleRequest = getVisibleRequest();
  sendingLock = Boolean(visibleRequest);
  controller = visibleRequest?.controller ?? null;
  isStreaming = visibleRequest?.providerId === "deepseek";
  input.readOnly = sendingLock;
  document.body.classList.toggle("thinking-mode", sendingLock);
  sendBtn.innerText = sendingLock ? "■" : "↑";
  sendBtn.setAttribute("aria-label", sendingLock ? "停止当前对话生成" : "发送消息");
}

function stopRequest(requestContext, reason = "user") {
  if (!requestCoordinator.abort(requestContext, reason)) return false;
  updateRequestUiState();
  return true;
}

function handleSendButtonIntent(e, source) {
  if (e) {
    e.preventDefault();
  }

  if (source === "click" && suppressNextSendClick) {
    suppressNextSendClick = false;
    return;
  }
  const visibleRequest = getVisibleRequest();
  if (visibleRequest) {
    stopRequest(visibleRequest, "user");
    return;
  }

  if (window.anime) {
    anime({
      targets: '#sendBtn',
      scale: [1, 0.9, 1.1, 1],
      duration: 280,
      easing: 'easeOutQuad'
    });
  }

  send();
}

if (window.PointerEvent) {
  sendBtn.addEventListener("pointerdown", (e) => {
    if (e.isPrimary === false) return;
    if (e.pointerType !== "touch" && e.pointerType !== "pen") return;

    suppressNextSendClick = true;
    handleSendButtonIntent(e, "pointer");
  });
} else {
  sendBtn.addEventListener("touchstart", (e) => {
    suppressNextSendClick = true;
    handleSendButtonIntent(e, "touch");
  }, { passive: false });
}

sendBtn.addEventListener("click", (e) => {
  handleSendButtonIntent(e, "click");
});
let lastUserMessage = null;


let syncTimer = null;

async function syncFromCloud() {
  const userId = getCurrentUserId();
  if (!userId) return;

  try {
    const { data, error } = await supabase
      .from("conversations")
      .select("data")
      .eq("user_id", userId)
      .maybeSingle();

    if (getCurrentUserId() !== userId) return;

    if (error) {
      console.warn("云端拉取失败:", error);
      return;
    }

    if (data && data.data) {
      const cloudConversations = filterConversationsForUser(
        normalizeCloudData(data.data, userId),
        userId,
      ).filter(conversation => !deletedConversationIds.has(conversation.id));
// ⭐兼容旧数据（没有updatedAt）
conversations.forEach(c => {
  if (!c.updatedAt) c.updatedAt = c.id;
});

cloudConversations.forEach(c => {
  if (!c.updatedAt) c.updatedAt = c.id;
});
// ⭐ 合并本地与云端；Provider 不变量由统一 merge 策略保护。
conversations = mergeConversationCollections(conversations, cloudConversations).sort(
  (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
);
// ⭐ 防止当前会话丢失
if (currentId) {
  const stillExists = conversations.find(c => c.id === currentId);
  if (!stillExists && conversations.length) {
    currentId = conversations[0].id;
  }
}

      if (getCurrentUserId() === userId) {
  localStorage.setItem(
    "conversations_" + userId,
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

async function writeConversationsToCloud(
  expectedUserId,
  sourceConversations = conversations,
) {
  const userId = getCurrentUserId();
  if (!userId || userId !== expectedUserId || supabase.__offline) return false;

  try {
    const data = buildCloudData(userId, sourceConversations);

    const { error } = await supabase
      .from("conversations")
      .upsert({
        user_id: userId,
        data,
      }, {
        onConflict: "user_id"
      });
    if (error || getCurrentUserId() !== userId) {
      if (error) console.warn("云端保存失败:", error);
      return false;
    }
    return true;
  } catch (e) {
    console.warn("云端保存失败:", e);
    return false;
  }
}

async function syncToCloud(expectedUserId = getCurrentUserId()) {
  await writeConversationsToCloud(expectedUserId);
}

// ===== Realtime 同步 =====


function startRealtime() {
  const userId = getCurrentUserId();
  if (!userId) return;
  if (realtimeSub) return;

  realtimeSub = supabase
    .channel('conversations-' + userId)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'conversations',
        filter: `user_id=eq.${userId}`
      },
      (payload) => {
        if (getCurrentUserId() !== userId) return;
        if (payload.new?.user_id != null && payload.new.user_id !== userId) return;
        const cloudData = filterConversationsForUser(
          normalizeCloudData(payload.new?.data, userId),
          userId,
        ).filter(conversation => !deletedConversationIds.has(conversation.id));
        scheduleRenderUser();

        conversations = mergeConversationCollections(conversations, cloudData).sort(
          (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
        );

        if (getCurrentUserId() === userId) {
  localStorage.setItem(
    "conversations_" + userId,
    JSON.stringify(conversations)
  );
}
        renderChatList();
        updateProviderCapabilityUI();

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

function persistConversationStateLocally(userId) {
  if (!userId || getCurrentUserId() !== userId) return false;
  localStorage.setItem(
    "conversations_" + userId,
    JSON.stringify(conversations)
  );
  return persistCurrentConversationId(
    localStorage,
    userId,
    currentId,
  );
}

function saveConversations() {
  const userId = getCurrentUserId();
  if (userId) persistConversationStateLocally(userId);

  // ⭐ 防抖同步（减少请求）
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncToCloud(userId);
  }, 600);
}

function belongsToCurrentConversationNamespace(conversation, userId) {
  if (!conversation || !userId) return false;
  if (conversation.userId === userId) return true;
  return conversation.userId == null && conversation.provider === "deepseek";
}

async function deleteConversationForCurrentUser(targetConversation) {
  const identity = getCurrentVerifiedIdentity();
  const userId = getVerifiedUserId(identity);
  const target = conversations.find(conversation => conversation === targetConversation);
  if (
    !identity ||
    !userId ||
    !target ||
    !belongsToCurrentConversationNamespace(target, userId)
  ) {
    showToast(SUNLAND_LOGIN_STATE_MESSAGE);
    return false;
  }
  if (deletingConversationIds.has(target.id)) return false;
  if (!confirm("确定删除这个对话吗？删除后无法恢复。")) return false;

  const targetWasCurrentAtStart = currentId === target.id;
  deletingConversationIds.add(target.id);
  deletedConversationIds.add(target.id);
  renderChatList();

  const activeRequest = requestCoordinator.activeForConversation(target.id);
  if (activeRequest) {
    requestCoordinator.abort(activeRequest, "conversation-deleted");
    requestCoordinator.finish(activeRequest, "aborted");
    updateRequestUiState();
  }

  const systemMessage = target.history?.find(message => message?.role === "system")
    || history.find(message => message?.role === "system")
    || null;
  const nextConversations = conversations.filter(conversation => conversation !== target);
  if (!nextConversations.length) {
    const replacement = createConversation({
      provider: "deepseek",
      model: currentModel,
      userId,
      title: "新对话",
    });
    replacement.history = systemMessage ? [{ ...systemMessage }] : [];
    nextConversations.push(replacement);
  }

  clearTimeout(syncTimer);
  const cloudDeleted = await writeConversationsToCloud(userId, nextConversations);
  if (!cloudDeleted || getCurrentUserId() !== userId) {
    deletedConversationIds.delete(target.id);
    deletingConversationIds.delete(target.id);
    renderChatList();
    if (currentId === target.id) loadChat(target.id);
    showToast("暂时无法删除这个对话，请稍后再试。");
    return false;
  }

  const targetIsCurrent = currentId === target.id;
  conversations = conversations.filter(conversation => conversation !== target);
  if (!conversations.length) conversations = nextConversations;
  deletingConversationIds.delete(target.id);

  const nextConversation = targetIsCurrent
    ? conversations[0]
    : conversations.find(conversation => conversation.id === currentId) || conversations[0];
  currentId = nextConversation.id;
  history = cloneRequestHistory(nextConversation.history);
  chatRenderVersion += 1;
  if (targetWasCurrentAtStart || targetIsCurrent) clearPendingAttachments();

  saveConversations();
  loadChat(currentId);
  updateRequestUiState();
  showToast("对话已删除。");
  return true;
}

function createNewChat() {
  const userId = getCurrentUserId();
  if (!userId) {
    showToast(SUNLAND_LOGIN_STATE_MESSAGE);
    return;
  }
  // ⭐ 如果最新对话是空的（只有 system），直接跳转，不新建
  if (conversations.length) {
    const latest = conversations[0];
    if (latest && !hasConversationStarted(latest)) {
      loadChat(latest.id);
      return;
    }
  }
  const newChat = createConversation({
    // 🆕 默认绑定 DeepSeek（与改造前完全一致的默认行为）；用户可以在对话
    // 还是空的时候，通过右下角模型选择器切到 Sunland AI —— 一旦发出第一
    // 条消息，provider 就锁定，需要新建对话才能更换。
    provider: "deepseek",
    model: currentModel,
    userId,
    title: "新对话",
  });
  newChat.history = [history[0]];
  const id = newChat.id;

  // ⭐ 新对话永远置顶（并避免被排序打乱）
  conversations = conversations.filter(c => c.id !== id);
  conversations.unshift(newChat);
  currentId = id;
  history = [...newChat.history];
  chatRenderVersion += 1;

  chatInner.innerHTML = "";
  saveConversations();
  renderChatList();
  updateModelUI();
  updateRequestUiState();
  closeSidebarForMobile();
}


function loadChat(id) {
  closeSidebarForMobile();
  const c = conversations.find(x => x.id === id);
  if (!c) return false;

  isLoadingHistory = true;
  const renderVersion = ++chatRenderVersion;

  currentId = id;
  if (c.provider !== "sunland") {
    currentModel = c.model === "deepseek-v4-pro"
      ? "deepseek-v4-pro"
      : "deepseek-v4-flash";
  }
  if (session?.userId) {
    persistCurrentConversationId(localStorage, session.userId, currentId);
  }
  history = JSON.parse(JSON.stringify(c.history));
  chatInner.style.opacity = "0";
  updateRequestUiState();

  setTimeout(() => {
    if (renderVersion !== chatRenderVersion || currentId !== id) return;
    const latestConversation = conversations.find(item => item.id === id);
    if (!latestConversation) {
      isLoadingHistory = false;
      chatInner.style.opacity = "1";
      return;
    }
    const renderHistory = cloneRequestHistory(latestConversation.history);
    history = cloneRequestHistory(renderHistory);
    chatInner.innerHTML = "";

    // ⭐ 禁用气泡动画（关键修复）
    const style = document.createElement("style");
    style.id = "no-anim";
    style.innerText = ".bubble { animation: none !important; }";
    document.head.appendChild(style);

    renderHistory.slice(1).forEach(m => {
      addMessage(m.content, m.role === "user" ? "user" : "ai");
    });

    const activeRequest = requestCoordinator.activeForConversation(id);
    if (activeRequest) {
      addMessage("", "ai", { thinking: true });
      const pendingMessage = chatInner.lastElementChild;
      activeRequest.bubble = pendingMessage?.querySelector(".bubble") ?? null;
    }

    chatInner.style.opacity = "1";

    // ⭐ 恢复动画
    requestAnimationFrame(() => {
      document.getElementById("no-anim")?.remove();
    });

    isLoadingHistory = false;
  }, 120);

  // ⭐ 重新渲染侧边栏（更新选中高亮）
  renderChatList();
  updateModelUI();
  return true;
}
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = input.scrollHeight + "px";
});

const SAFE_INLINE_IMAGE_PATTERN = /^data:image\/(?:avif|gif|jpeg|png|webp);base64,/i;

function addMessage(text, type, options = {}) {
  const div = document.createElement("div");
  div.className = "message " + type;

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  if (type === "ai") {
    if (options.thinking === true) {
      bubble.style.animation = "fadeInBubble 0.2s ease";
      bubble.style.opacity = "0.8";

      const thinking = document.createElement("span");
      thinking.className = "thinking";
      for (let index = 0; index < 3; index += 1) {
        const dot = document.createElement("span");
        dot.className = "dot";
        thinking.appendChild(dot);
      }
      bubble.appendChild(thinking);
    } else {
      // 实时回复与历史恢复统一走白名单 Markdown 渲染入口。
      const result = renderSafeMarkdown(bubble, text, {
        animateText: !hasTypedOnce && !isLoadingHistory,
      });
      if (result.animated) hasTypedOnce = true;
    }
  } else {
    if (options.imageSrc && SAFE_INLINE_IMAGE_PATTERN.test(options.imageSrc)) {
      const img = document.createElement("img");
      img.src = options.imageSrc;
      img.alt = String(text || "用户上传的图片");
      img.style.maxWidth = "100%";
      img.style.borderRadius = "10px";
      img.style.marginTop = "4px";
      bubble.appendChild(img);
    } else {
      bubble.textContent = String(text ?? "");
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
async function generateTitleFromAI(userMsg, aiMsg, { model, signal } = {}) {
  try {
    const prompt = `请根据下面的对话生成一个简短标题（不超过12个字，不要标点结尾）：\n用户：${userMsg}\n助手：${aiMsg}`;

    if (!session || !localStorage.getItem("token")) return null;

    const res = await apiFetch({
  model: model || currentModel,
  messages: [
        { role: "system", content: "你是一个标题生成器，只返回标题本身。" },
        { role: "user", content: prompt }
      ]
    }, false, signal);
if (!res) return null;
    const data = await res.json();
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

/**
 * Sunland AI 的发送路径：完全在浏览器本地运行（符号推理，无 LLM、无网络
 * 请求），通过统一的 providerRegistry 调用，不复用/不触碰 DeepSeek 的
 * apiFetch/SSE 逻辑。`history`（本对话的聊天记录）与 Sunland 的知识图谱
 * （跨对话共享的"大脑"）是两回事：这里只把最新一句用户输入交给引擎。
 */
function isRequestVisible(requestContext) {
  return requestCoordinator.canWrite(requestContext) && isRequestVisibleForConversation(
    requestContext,
    currentId,
    requestContext.bubble?.isConnected === true,
  );
}

function renderRequestMarkdown(requestContext, target, markdown) {
  if (!isRequestVisible(requestContext) || !target) return;
  renderSafeMarkdown(target, markdown);
}

function abortMissingTarget(requestContext) {
  if (requestCoordinator.canWrite(requestContext)) return false;
  requestCoordinator.abort(requestContext, "target-missing-or-stale");
  return true;
}

function appendRequestMessage(requestContext, message) {
  const changed = requestCoordinator.appendMessage(requestContext, message);
  if (!changed) abortMissingTarget(requestContext);
  return changed;
}

function scheduleRequestTitle(requestContext, aiText) {
  const conversation = requestCoordinator.target(requestContext);
  if (!conversation || requestContext.history.length !== 3 || conversation._autoTitle) return;

  const userMsg = requestContext.history.find(message => message.role === "user")?.content || "";
  const titleRequestId = requestContext.requestId;
  const conversationId = requestContext.conversationId;
  const userId = requestContext.userId;
  conversation._autoTitle = true;
  conversation._autoTitleRequestId = titleRequestId;
  saveConversations();
  renderChatList();

  generateTitleFromAI(userMsg, aiText, { model: requestContext.model }).then(title => {
    const fallback = userMsg.slice(0, 12).replace(/\n/g, " ");
    const applied = applyRequestTitle({
      conversations,
      conversationId,
      userId,
      requestId: titleRequestId,
      title,
      fallbackTitle: fallback,
    });
    if (!applied) return;
    conversations.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    saveConversations();
    renderChatList();
  });
}

function addRegenerateButton(requestContext, fullText) {
  const bubble = requestContext.bubble;
  if (!fullText || !isRequestVisible(requestContext) || !bubble) return;

  const regenWrap = document.createElement("div");
  regenWrap.className = "regen";
  const regenBtn = document.createElement("button");
  regenBtn.className = "regen-btn";
  regenBtn.innerText = "↻";
  regenWrap.appendChild(regenBtn);
  bubble.appendChild(regenWrap);

  regenBtn.onclick = () => {
    if (currentId !== requestContext.conversationId) return;
    const conversation = conversations.find(item => item.id === requestContext.conversationId);
    if (!conversation || conversation.userId !== requestContext.userId) return;
    if (requestCoordinator.activeForConversation(conversation.id)) return;

    if (conversation.history.at(-1)?.role === "assistant") {
      conversation.history = conversation.history.slice(0, -1);
      conversation.updatedAt = Date.now();
      history = cloneRequestHistory(conversation.history);
      saveConversations();
    }
    input.value = requestContext.userText || "";
    loadChat(conversation.id);
    send();
  };
}

async function sendSunlandMessage(requestContext) {
  const errorMessage = "Sunland AI · Beta 暂时出了点问题，请稍后重试";
  try {
    if (isRequestVisible(requestContext)) requestContext.bubble.innerHTML = "";
    const provider = providerRegistry.get("sunland");
    if (!provider) throw new Error("Sunland provider is unavailable");
    const result = await provider.send({
      conversation: requestCoordinator.target(requestContext),
      messages: cloneRequestHistory(requestContext.history),
      identity: requestContext.identity,
      semanticContext: requestContext.semanticContext,
      turnId: requestContext.requestId,
      signal: requestContext.controller.signal,
      canCommitSemanticContext: () =>
        requestCoordinator.canCommitSemanticContext(requestContext),
      observationMode:
        requestContext.diagnostics?.observationMode ?? "off",
      onDelta: text => renderRequestMarkdown(requestContext, requestContext.bubble, text),
    });

    if (result.blocked) {
      renderRequestMarkdown(requestContext, requestContext.bubble, result.content);
      return;
    }
    const saved = requestCoordinator.appendMessageWithSemanticContext(
      requestContext,
      { role: "assistant", content: result.content },
      result.semanticContextUpdate,
    );
    if (!saved.messageSaved) {
      abortMissingTarget(requestContext);
      return;
    }
    renderRequestMarkdown(requestContext, requestContext.bubble, result.content);
    void sunlandDiagnosticsRuntime.record(
      result.observationSummary,
      requestContext,
    );
  } catch (err) {
    console.error("Sunland AI 出错:", err);
    if (requestCoordinator.canWrite(requestContext)) {
      appendRequestMessage(requestContext, { role: "assistant", content: errorMessage });
      renderRequestMarkdown(requestContext, requestContext.bubble, errorMessage);
    }
  }
}

function decorateVisibleCodeBlocks(requestContext) {
  if (currentId !== requestContext.conversationId) return;
  document.querySelectorAll("pre code").forEach(el => {
    hljs.highlightElement(el);
    if (el.parentElement.querySelector(".copy-btn")) return;
    const lang = el.className.match(/language-(\w+)/)?.[1];
    if (lang) {
      const langTag = document.createElement("span");
      langTag.className = "lang-tag";
      langTag.innerText = lang;
      el.parentElement.appendChild(langTag);
    }
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
}

async function runDeepSeekRequest(requestContext) {
  let fullText = "";
  let attempt = 0;

  while (attempt < (window._isMobile ? 2 : 1)) {
    attempt += 1;
    let softTimeoutShown = false;
    const timeoutId = setTimeout(() => {
      if (!softTimeoutShown && isRequestVisible(requestContext) && !fullText) {
        requestContext.bubble.textContent = "响应较慢，请稍等…";
        softTimeoutShown = true;
      }
    }, 15000);
    const hardTimeoutId = window._isMobile ? null : setTimeout(() => {
      stopRequest(requestContext, "timeout");
    }, 40000);

    try {
      if (!localStorage.getItem("token")) {
        const message = "登录状态已失效，请重新登录";
        appendRequestMessage(requestContext, { role: "assistant", content: message });
        renderRequestMarkdown(requestContext, requestContext.bubble, message);
        goToLogin();
        return;
      }

      const res = await apiFetch({
        model: requestContext.model,
        messages: cloneRequestHistory(requestContext.history),
        deep: requestContext.deep,
      }, false, requestContext.controller.signal);
      if (!res || abortMissingTarget(requestContext)) return;

      if (res.status === 429) {
        if (currentId === requestContext.conversationId) showLimitModal();
        const message = "今天的使用次数已达上限，请稍后再试";
        appendRequestMessage(requestContext, { role: "assistant", content: message });
        renderRequestMarkdown(requestContext, requestContext.bubble, message);
        return;
      }

      if (!res.ok) {
        const errText = await res.text();
        console.error("API错误:", res.status, errText);
        const message = `请求失败（${res.status}），请稍后重试`;
        appendRequestMessage(requestContext, { role: "assistant", content: message });
        renderRequestMarkdown(requestContext, requestContext.bubble, message);
        return;
      }

      const remain = parseInt(res.headers.get("x-remain") ?? "-1");
      if (!isActivated && remain >= 0 && currentId === requestContext.conversationId) {
        const hintEl = document.getElementById("usageHint");
        if (hintEl) hintEl.innerText = `今日剩余 ${remain} 次`;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let reasoning = "";
      let reasoningDiv = null;
      let reasoningContent = null;
      let contentDiv = null;
      if (isRequestVisible(requestContext)) requestContext.bubble.innerHTML = "";

      while (true) {
        if (abortMissingTarget(requestContext)) {
          await reader.cancel().catch(() => {});
          return;
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (abortMissingTarget(requestContext)) continue;

        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (raw === "[DONE]") break;

          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch {
            continue;
          }
          if (!requestCoordinator.canWrite(requestContext)) continue;
          const delta = parsed.choices?.[0]?.delta || {};

          if (delta.reasoning_content) {
            reasoning += delta.reasoning_content;
            if (isRequestVisible(requestContext)) {
              if (!reasoningDiv || !reasoningDiv.isConnected) {
                reasoningDiv = document.createElement("div");
                reasoningDiv.style.cssText = "font-size:12px;color:#888;margin-bottom:8px;border-left:3px solid #22d3ee;padding-left:8px;line-height:1.5;";
                const title = document.createElement("div");
                title.innerText = "🧠 思考过程";
                title.style.marginBottom = "4px";
                reasoningContent = document.createElement("div");
                reasoningDiv.appendChild(title);
                reasoningDiv.appendChild(reasoningContent);
                requestContext.bubble.appendChild(reasoningDiv);
              }
              renderSafeMarkdown(reasoningContent, reasoning);
            }
          }

          if (delta.content) {
            fullText += delta.content;
            if (isRequestVisible(requestContext)) {
              if (!contentDiv || !contentDiv.isConnected) {
                contentDiv = document.createElement("div");
                requestContext.bubble.appendChild(contentDiv);
              }
              renderSafeMarkdown(contentDiv, fullText);
              if (isNearBottom()) chat.scrollTop = chat.scrollHeight;
            }
          }
        }
      }

      if (!requestCoordinator.canWrite(requestContext)) return;
      if (!appendRequestMessage(requestContext, { role: "assistant", content: fullText })) return;
      scheduleRequestTitle(requestContext, fullText);
      addRegenerateButton(requestContext, fullText);
      decorateVisibleCodeBlocks(requestContext);
      return;
    } catch (err) {
      if (requestContext.controller.signal.aborted || err?.name === "AbortError") return;
      if (fullText && requestCoordinator.canWrite(requestContext)) {
        appendRequestMessage(requestContext, { role: "assistant", content: fullText });
        renderRequestMarkdown(requestContext, requestContext.bubble, fullText);
        return;
      }
      if (window._isMobile && attempt < 2 && requestCoordinator.canWrite(requestContext)) {
        console.warn("移动端自动重试一次...");
        await new Promise(resolve => setTimeout(resolve, 500));
        continue;
      }

      console.error("真实错误:", err);
      const message = "请求异常，请稍后重试";
      if (requestCoordinator.canWrite(requestContext)) {
        appendRequestMessage(requestContext, { role: "assistant", content: message });
        renderRequestMarkdown(requestContext, requestContext.bubble, message);
      }
      return;
    } finally {
      clearTimeout(timeoutId);
      clearTimeout(hardTimeoutId);
    }
  }
}

const lastRealSendByConversation = new Map();

async function send() {
  if (pendingFiles.length > 0) showGlobalLoading();
  const now = Date.now();
  if (window._lastSendTime && now - window._lastSendTime < 800) console.warn("发送过快");
  window._lastSendTime = now;

  if (!(await requireLoginForAction())) {
    hideGlobalLoading();
    return;
  }

  const sendingConversation = conversations.find(x => x.id === currentId);
  if (!sendingConversation) {
    hideGlobalLoading();
    return;
  }
  if (deletingConversationIds.has(sendingConversation.id)) {
    showToast("正在删除这个对话，请稍候。");
    hideGlobalLoading();
    return;
  }
  if (requestCoordinator.activeForConversation(sendingConversation.id)) {
    console.warn("当前会话已有请求，跳过重复发送");
    hideGlobalLoading();
    return;
  }

  const currentIdentity = getCurrentVerifiedIdentity();
  const verifiedUserId = getVerifiedUserId(currentIdentity);
  if (!currentIdentity || !verifiedUserId || !isSupportedProviderId(sendingConversation.provider)) {
    showToast(SUNLAND_LOGIN_STATE_MESSAGE);
    hideGlobalLoading();
    return;
  }
  if (sendingConversation.userId != null && sendingConversation.userId !== verifiedUserId) {
    showToast(SUNLAND_LOGIN_STATE_MESSAGE);
    hideGlobalLoading();
    return;
  }

  const text = input.value.trim();
  const isSunlandConversation = sendingConversation.provider === "sunland";
  if (isSunlandConversation && pendingFiles.length) {
    clearPendingAttachments();
    updateProviderCapabilityUI();
  }
  const files = isSunlandConversation ? [] : [...pendingFiles];
  if (isSunlandConversation && !text) {
    showToast("好像还没有输入内容呢，可以跟我说点什么。");
    hideGlobalLoading();
    return;
  }
  const moderationResult = checkInputModeration([text, ...files.map(file => file.name)].join(" "));
  if (moderationResult) {
    refuseModeratedInput(moderationResult);
    hideGlobalLoading();
    return;
  }

  if (
    sendingConversation?.provider === "sunland" &&
    !isSameUserIdentity(verifiedUserId, sendingConversation.userId)
  ) {
    addMessage(SUNLAND_LOGIN_STATE_MESSAGE, "ai");
    hideGlobalLoading();
    return;
  }

  // 旧 DeepSeek 会话可能没有 owner 字段；它已从当前用户专属命名空间恢复，
  // 在首次发送时补齐所有者，后续请求即可执行同样的身份绑定校验。
  if (sendingConversation.provider === "deepseek" && sendingConversation.userId == null) {
    sendingConversation.userId = verifiedUserId;
    saveConversations();
  }

  const requestDeepMode = !isSunlandConversation && deepMode;
  if (requestDeepMode && !isActivated) {
    deepMode = false;
    updateDeepButton();
    showProRequiredModal();
    hideGlobalLoading();
    return;
  }

  const lastSentAt = lastRealSendByConversation.get(sendingConversation.id) || 0;
  if (Date.now() - lastSentAt < 800) {
    showToast("操作太快了，慢一点 😅");
    hideGlobalLoading();
    return;
  }
  lastRealSendByConversation.set(sendingConversation.id, Date.now());

  const diagnostics = sunlandDiagnosticsRuntime.captureRequest(
    sendingConversation.provider,
    currentIdentity,
  );
  const requestContext = requestCoordinator.begin({
    conversation: sendingConversation,
    identity: currentIdentity,
    userId: verifiedUserId,
    providerId: sendingConversation.provider,
    model: sendingConversation.provider === "sunland" ? "frost" : currentModel,
    deep: requestDeepMode,
    history: sendingConversation.history,
    diagnostics,
  });
  if (!requestContext) {
    hideGlobalLoading();
    return;
  }

  requestContext.canRecordDiagnostics = () =>
    requestCoordinator.canWrite(requestContext);
  requestContext.userText = text;
  clearPendingAttachments();
  updateRequestUiState();

  try {
    for (const file of files) {
      const reader = new FileReader();
      const fileData = await new Promise((resolve, reject) => {
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error("文件读取失败"));
        reader.readAsDataURL(file);
      });
      if (abortMissingTarget(requestContext)) return;

      if (file.type.startsWith("image/")) {
        if (currentId === requestContext.conversationId) {
          addMessage(`🖼️ ${file.name}`, "user", { imageSrc: fileData });
        }
        if (!appendRequestMessage(requestContext, { role: "user", content: "[用户发送了一张图片]" })) return;
      } else {
        if (currentId === requestContext.conversationId) addMessage(`📄 ${file.name}`, "user");
        if (!appendRequestMessage(requestContext, { role: "user", content: `[用户上传文件: ${file.name}]` })) return;
      }
    }

    if (!text) return;
    const welcome = document.getElementById("welcome");
    if (welcome && currentId === requestContext.conversationId) {
      welcome.classList.add("hidden");
      setTimeout(() => welcome.remove(), 300);
    }

    if (currentId === requestContext.conversationId) addMessage(text, "user");
    if (navigator.vibrate) navigator.vibrate(10);
    if (!appendRequestMessage(requestContext, { role: "user", content: text })) return;

    const target = requestCoordinator.target(requestContext);
    if (target?.title === "新对话") {
      target.title = text.length > 15 ? text.slice(0, 15) + "…" : text;
      saveConversations();
      renderChatList();
    }

    lastUserMessage = text;
    input.value = "";
    input.style.height = "auto";
    if (currentId === requestContext.conversationId) {
      addMessage("", "ai", { thinking: true });
      requestContext.bubble = chatInner.lastElementChild?.querySelector(".bubble") ?? null;
    }

    window._isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (requestContext.providerId === "sunland") {
      await sendSunlandMessage(requestContext);
    } else {
      await runDeepSeekRequest(requestContext);
    }
  } catch (err) {
    console.error("发送流程出错:", err);
    const message = "消息处理失败，请稍后重试";
    if (requestCoordinator.canWrite(requestContext)) {
      appendRequestMessage(requestContext, { role: "assistant", content: message });
      renderRequestMarkdown(requestContext, requestContext.bubble, message);
    }
  } finally {
    const shouldReload = (
      currentId === requestContext.conversationId &&
      (!requestContext.bubble?.isConnected || requestContext.status === "aborted")
    );
    requestCoordinator.finish(requestContext);
    updateRequestUiState();
    if (requestCoordinator.size === 0) hideGlobalLoading();
    if (shouldReload && conversations.some(item => item.id === requestContext.conversationId)) {
      loadChat(requestContext.conversationId);
    }
    if (!window._isMobile && !sendingLock) input.focus();
    input.style.height = "auto";
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
window.addEventListener("pagehide", () => {
  void sunlandDiagnosticsRuntime.flush();
}, { once: true });
document.getElementById("newChatBtn").onclick = createNewChat;

// 所有恢复流程可能访问的模块状态与事件处理器均已初始化，之后才开始登录、
// Provider/会话恢复。这里故意不依赖定时器，也不吞掉初始化 ReferenceError。
await checkLogin();
startRealtime();
scheduleRenderUser();

if (getCurrentVerifiedIdentity() && !conversations.length) {
  createNewChat();
}

renderChatList();
updateProviderCapabilityUI();
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
  if (getCurrentVerifiedIdentity()) {
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
if (deepBtn) {
  deepBtn.onclick = async () => {
    if (!providerCapabilityState.deepThinking) return;
    if (!(await requireLoginForAction())) return;
    if (!providerCapabilityState.deepThinking) return;

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

      if (getCurrentVerifiedIdentity()) {
        await syncFromCloud();
      }
      if (isRestoreStale(version)) return;

      finalizeRenderUser(version);
    } catch (e) {
      if (e?.name === "ReferenceError") throw e;

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
