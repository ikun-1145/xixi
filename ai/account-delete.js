import { normalizeUserId } from "./user-identity.js";

const API_BASE = "https://klyrasrqgxijwrxuoevj.supabase.co/functions/v1/sunland-account-delete";
const SEND_CODE_URL = "https://api.sunland.dev/send-code";
const CONFIRMATION_TEXT = "删除我的账号";
const GEE_TEST_CAPTCHA_ID = "ad3a8126afe716ccd4541f35d428071e";
const COOLDOWN_SECONDS = 60;

let dialog = null;
let openBtn = null;
let closeBtn = null;
let bodyEl = null;
let currentStep = 0;
let deletionJobId = "";
let deletionToken = "";
let cleanupIdentity = null;
let cooldownTimer = null;
let busy = false;

function decodeJwtPayload(token) {
  try {
    const part = String(token || "").split(".")[1];
    if (!part) return null;
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

function getAppToken() {
  try {
    return localStorage.getItem("token") || "";
  } catch {
    return "";
  }
}

function getCurrentUser() {
  try {
    const user = JSON.parse(localStorage.getItem("user") || "null");
    if (user && (user.id || user.email)) {
      return { id: String(user.id || user.email), email: String(user.email || user.id) };
    }
  } catch {}

  try {
    const token = getAppToken();
    if (token) {
      const payload = decodeJwtPayload(token);
      const id = payload?.sub || payload?.id || payload?.user_id || payload?.email;
      const email = payload?.email || payload?.user_email || payload?.mail || "";
      if (id) return { id: String(id), email: String(email || id) };
    }
  } catch {}

  return null;
}

function setStatus(el, message, type = "") {
  if (!el) return;
  el.textContent = message;
  el.className = `account-delete-status${type ? ` ${type}` : ""}`;
}

function setBusy(value) {
  busy = value;
  if (closeBtn) closeBtn.disabled = value;
}

function loadGeetestScript() {
  if (typeof window.initGeetest4 === "function") return Promise.resolve();
  if (window.__accountDeleteGeetestLoading) return window.__accountDeleteGeetestLoading;
  window.__accountDeleteGeetestLoading = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://static.geetest.com/v4/gt4.js";
    script.async = true;
    script.onload = () => {
      if (typeof window.initGeetest4 === "function") resolve();
      else reject(new Error("验证脚本加载异常，请刷新重试"));
    };
    script.onerror = () => {
      window.__accountDeleteGeetestLoading = null;
      reject(new Error("验证脚本加载失败，请检查网络或稍后重试"));
    };
    document.head.appendChild(script);
  });
  return window.__accountDeleteGeetestLoading;
}

function newCaptchaPromise() {
  return loadGeetestScript().then(() => new Promise((resolve, reject) => {
    window.initGeetest4({ captchaId: GEE_TEST_CAPTCHA_ID, product: "bind" }, (obj) => {
      obj.onReady(() => resolve(obj));
      obj.onError((err) => reject(new Error(err?.msg || err?.desc || "人机验证加载失败")));
    });
  }));
}

let captchaPromise = null;

function ensureCaptchaPromise() {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("browser required"));
  }
  if (!captchaPromise) {
    captchaPromise = newCaptchaPromise();
    captchaPromise.catch(() => {});
  }
  return captchaPromise;
}

async function runCaptcha() {
  const captcha = await ensureCaptchaPromise();
  if (captcha && typeof captcha.appendTo === "function") {
    captcha.appendTo(dialog || document.body);
  }
  return new Promise((resolve, reject) => {
    captcha.onSuccess(() => {
      const result = captcha.getValidate();
      captchaPromise = newCaptchaPromise();
      captchaPromise.catch(() => {});
      resolve(JSON.stringify(result));
    });
    captcha.onError((err) => {
      captchaPromise = newCaptchaPromise();
      captchaPromise.catch(() => {});
      reject(new Error(err?.msg || err?.desc || "人机验证失败"));
    });
    captcha.showCaptcha();
  });
}

async function sendEmailCode(email, sendBtn, statusEl) {
  if (busy) return;
  if (sendBtn.disabled) return;

  setStatus(statusEl, "");
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    setStatus(statusEl, "邮箱格式错误", "error");
    return;
  }

  setBusy(true);
  sendBtn.disabled = true;
  let captchaToken;
  try {
    captchaToken = await runCaptcha();
  } catch (error) {
    setStatus(statusEl, error.message || "人机验证失败", "error");
    sendBtn.disabled = false;
    setBusy(false);
    return;
  }

  try {
    sendBtn.textContent = "发送中...";
    const res = await fetch(SEND_CODE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, token: captchaToken }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      throw new Error(data.error || `发送失败（${res.status}）`);
    }

    setStatus(statusEl, "验证码已发送（有效期约5分钟）", "success");
    startCooldown(sendBtn);
  } catch (error) {
    const message = error.message === "Failed to fetch" ? "网络连接失败" : error.message;
    setStatus(statusEl, message, "error");
    sendBtn.disabled = false;
    sendBtn.textContent = "发送验证码";
  } finally {
    setBusy(false);
  }
}

function startCooldown(sendBtn) {
  if (cooldownTimer) clearInterval(cooldownTimer);
  let remaining = COOLDOWN_SECONDS;
  sendBtn.disabled = true;
  sendBtn.textContent = `${remaining}s`;
  cooldownTimer = setInterval(() => {
    remaining -= 1;
    sendBtn.textContent = `${remaining}s`;
    if (remaining <= 0) {
      clearInterval(cooldownTimer);
      cooldownTimer = null;
      sendBtn.textContent = "发送验证码";
      sendBtn.disabled = false;
    }
  }, 1000);
}

function stopCooldown() {
  if (cooldownTimer) {
    clearInterval(cooldownTimer);
    cooldownTimer = null;
  }
}

async function prepareCleanupIdentity() {
  if (cleanupIdentity) return cleanupIdentity;
  try {
    const { IdentityAuthority, isVerifiedIdentity } = await import("./verified-identity.js");
    const token = getAppToken();
    if (!token) return null;
    const cached = JSON.parse(localStorage.getItem("user") || "null");
    const authority = new IdentityAuthority();
    const result = await authority.resolve({ token, cachedUser: cached });
    cleanupIdentity = result.ok && isVerifiedIdentity(result.identity) ? result.identity : null;
  } catch {
    cleanupIdentity = null;
  }
  return cleanupIdentity;
}

export function collectAccountLocalStorageKeys(userId) {
  const id = normalizeUserId(userId);
  if (!id) return [];
  return [
    "token",
    "user",
    `conversations_${id}`,
    `current_conversation_${id}`,
    `xixi_profile_${id}`,
    `sunland_knowledge_${id}`,
    `sunland_knowledge_${id}::memory`,
    `sunland_remote_legacy_knowledge_${id}`,
    `sunland_remote_legacy_memory_${id}`,
    `sunland_remote_legacy_conversations_${id}`,
    `sunland_remote_migration_${id}`,
    `sunland:pro-payment-pending:${id}`,
  ];
}

export async function clearAccountLocalStorage(userId, { clearDiagnostics = async () => {} } = {}) {
  const keys = collectAccountLocalStorageKeys(userId);
  try {
    await clearDiagnostics();
  } catch {}

  try {
    window.SunlandDatabaseToken?.clear?.();
  } catch {}
  try {
    window.clearVerifiedSession?.();
  } catch {}

  for (const key of keys) {
    try {
      localStorage.removeItem(key);
    } catch {}
  }
}

async function clearDiagnosticsForIdentity(identity) {
  if (!identity) return;
  const { createBetaDiagnosticsStorage } = await import("./beta-diagnostics/index.js");
  const storage = createBetaDiagnosticsStorage({
    storage: localStorage,
    cryptoImpl: globalThis.crypto,
  });
  await storage.clearSnapshot(identity);
  await storage.clearMode(identity);
}

function renderStep1() {
  currentStep = 1;
  bodyEl.innerHTML = `
    <div class="account-delete-step active">
      <p class="account-delete-copy">删除账号后，与该账号关联的数据将被永久删除，并且无法恢复。</p>
      <ul class="account-delete-list">
        <li>用户资料与头像文件</li>
        <li>云端聊天记录与消息记录</li>
        <li>用户设置与免费额度记录</li>
        <li>上传的文件或图片</li>
        <li>你教给 Sunland AI 的知识、姓名记忆与语义上下文</li>
        <li>护福宝使用记录与支付激活记录</li>
      </ul>
      <button id="accountDeleteContinueBtn" class="account-delete-btn primary" type="button">继续删除</button>
    </div>
  `;
  bodyEl.querySelector("#accountDeleteContinueBtn").onclick = () => {
    void prepareCleanupIdentity();
    renderStep2();
  };
}

function renderStep2() {
  currentStep = 2;
  const user = getCurrentUser();
  const email = user?.email || "";
  bodyEl.innerHTML = `
    <div class="account-delete-step active">
      <p class="account-delete-copy">删除账号属于高风险操作，请先通过邮箱验证码重新验证身份。</p>
      <div class="account-delete-field">
        <label for="accountDeleteEmailInput">当前邮箱</label>
        <div class="account-delete-email-row">
          <input id="accountDeleteEmailInput" class="account-delete-input" type="email" readonly>
          <button id="accountDeleteSendBtn" class="account-delete-send" type="button">发送验证码</button>
        </div>
      </div>
      <div class="account-delete-field">
        <label for="accountDeleteCodeInput">验证码</label>
        <input id="accountDeleteCodeInput" class="account-delete-input" type="text" inputmode="numeric" placeholder="输入 6 位验证码">
      </div>
      <div id="accountDeleteOtpStatus" class="account-delete-status" role="status" aria-live="polite"></div>
      <button id="accountDeleteVerifyBtn" class="account-delete-btn primary" type="button">验证并继续</button>
    </div>
  `;

  const emailInput = bodyEl.querySelector("#accountDeleteEmailInput");
  const codeInput = bodyEl.querySelector("#accountDeleteCodeInput");
  const sendBtn = bodyEl.querySelector("#accountDeleteSendBtn");
  const verifyBtn = bodyEl.querySelector("#accountDeleteVerifyBtn");
  const statusEl = bodyEl.querySelector("#accountDeleteOtpStatus");

  emailInput.value = email;
  sendBtn.onclick = () => void sendEmailCode(emailInput.value.trim(), sendBtn, statusEl);
  verifyBtn.onclick = () => void authorizeDeletion(codeInput.value.trim(), emailInput.value.trim(), verifyBtn, statusEl);
}

async function authorizeDeletion(code, email, verifyBtn, statusEl) {
  if (busy) return;
  const appToken = getAppToken();
  if (!appToken) {
    setStatus(statusEl, "登录状态已失效，请重新登录", "error");
    return;
  }
  if (!/^\d{6}$/.test(code)) {
    setStatus(statusEl, "验证码格式错误", "error");
    return;
  }

  setBusy(true);
  verifyBtn.disabled = true;
  setStatus(statusEl, "正在验证...");
  try {
    const res = await fetch(API_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-sunland-token": appToken,
      },
      body: JSON.stringify({ action: "authorize", email, code }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.deletion_job_id || !data.deletion_token) {
      throw new Error(data.error || "验证失败，请稍后重试");
    }
    deletionJobId = data.deletion_job_id;
    deletionToken = data.deletion_token;
    stopCooldown();
    cleanupIdentity = await prepareCleanupIdentity();
    renderStep3();
  } catch (error) {
    setStatus(statusEl, error.message || "验证失败，请稍后重试", "error");
  } finally {
    verifyBtn.disabled = false;
    setBusy(false);
  }
}

function renderStep3() {
  currentStep = 3;
  bodyEl.innerHTML = `
    <div class="account-delete-step active">
      <p class="account-delete-copy">此操作不可撤销。请输入下方文字以确认：</p>
      <div class="account-delete-field">
        <label for="accountDeleteConfirmInput">删除我的账号</label>
        <input id="accountDeleteConfirmInput" class="account-delete-input" type="text" autocomplete="off">
      </div>
      <div id="accountDeleteConfirmStatus" class="account-delete-status" role="status" aria-live="polite"></div>
      <button id="accountDeleteFinalBtn" class="account-delete-btn danger" type="button" disabled>永久删除账号</button>
    </div>
  `;

  const input = bodyEl.querySelector("#accountDeleteConfirmInput");
  const finalBtn = bodyEl.querySelector("#accountDeleteFinalBtn");
  const statusEl = bodyEl.querySelector("#accountDeleteConfirmStatus");

  input.oninput = () => {
    finalBtn.disabled = input.value !== CONFIRMATION_TEXT;
    setStatus(statusEl, "");
  };
  finalBtn.onclick = () => {
    if (input.value !== CONFIRMATION_TEXT) {
      setStatus(statusEl, "输入内容不一致", "error");
      return;
    }
    void executeDeletion();
  };
}

function renderStep4() {
  currentStep = 4;
  bodyEl.innerHTML = `
    <div class="account-delete-step active">
      <p class="account-delete-copy">正在删除账号及关联数据，请勿关闭此页面...</p>
      <div id="accountDeleteDeletingStatus" class="account-delete-status" role="status" aria-live="polite"></div>
    </div>
  `;
}

function renderStep5(success, message) {
  currentStep = 5;
  bodyEl.innerHTML = `
    <div class="account-delete-step active">
      <p id="accountDeleteResultMessage" class="account-delete-copy"></p>
      <div id="accountDeleteResultStatus" class="account-delete-status ${success ? "success" : "error"}" role="status" aria-live="polite"></div>
      ${success ? "" : '<button id="accountDeleteRetryBtn" class="account-delete-btn primary" type="button">重试删除</button>'}
    </div>
  `;
  bodyEl.querySelector("#accountDeleteResultMessage").textContent = message;
  if (!success) {
    bodyEl.querySelector("#accountDeleteRetryBtn").onclick = () => void executeDeletion();
  }
}

async function executeDeletion() {
  if (busy || !deletionJobId || !deletionToken) return;
  renderStep4();
  setBusy(true);

  try {
    const identity = cleanupIdentity || await prepareCleanupIdentity();
    const appToken = getAppToken();
    const res = await fetch(API_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-sunland-token": appToken,
      },
      body: JSON.stringify({
        action: "execute",
        deletion_job_id: deletionJobId,
        deletion_token: deletionToken,
        confirmation: CONFIRMATION_TEXT,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && !data.already_completed) {
      throw new Error(data.error || "账号删除失败，请稍后重试");
    }

    const userId = typeof data.user_id === "string" ? data.user_id : getCurrentUser()?.id || "";
    await clearAccountLocalStorage(userId, {
      clearDiagnostics: () => clearDiagnosticsForIdentity(identity),
    });
    deletionJobId = "";
    deletionToken = "";

    renderStep5(true, "账号已删除，正在返回登录页...");
    setTimeout(() => {
      window.location.replace("login.html");
    }, 1600);
  } catch (error) {
    renderStep5(false, error.message || "账号删除失败，请稍后重试");
  } finally {
    setBusy(false);
  }
}

function openDialog() {
  if (!dialog) return;
  stopCooldown();
  deletionJobId = "";
  deletionToken = "";
  cleanupIdentity = null;
  setBusy(false);
  renderStep1();
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
  } else {
    dialog.setAttribute("open", "");
  }
}

function closeDialog() {
  if (!dialog || busy) return;
  stopCooldown();
  if (typeof dialog.close === "function") {
    dialog.close();
  } else {
    dialog.removeAttribute("open");
  }
}

export function initAccountDelete() {
  dialog = document.getElementById("accountDeleteDialog");
  openBtn = document.getElementById("openAccountDeleteBtn");
  closeBtn = document.getElementById("accountDeleteCloseBtn");
  bodyEl = document.getElementById("accountDeleteBody");
  if (!dialog || !openBtn || !closeBtn || !bodyEl) return;

  openBtn.onclick = openDialog;
  closeBtn.onclick = closeDialog;
  dialog.addEventListener("cancel", (event) => {
    if (busy) event.preventDefault();
  });
}

if (typeof document !== "undefined") {
  if (document.getElementById("accountDeleteDialog")) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", initAccountDelete, { once: true });
    } else {
      initAccountDelete();
    }
  }
}
