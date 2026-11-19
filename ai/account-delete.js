import { normalizeUserId } from "./user-identity.js";
import { vaultPrefix } from './history-vault.js';

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
let phoneClient = null;

// Copy for the phone-only verification path: zh-CN, zh-Hant, en, ja, ko, es.
const PHONE_COPY = {
  intro: ["你的账号未绑定邮箱，请通过已绑定手机号的短信验证码重新验证身份。", "你的帳號未綁定郵箱，請透過已綁定手機號碼的簡訊驗證碼重新驗證身分。", "Your account has no email. Verify with a text message to your linked phone.", "アカウントにメールが登録されていません。登録済みの電話番号へのSMSで本人確認してください。", "계정에 이메일이 없습니다. 연결된 전화번호로 받은 문자 인증번호로 확인하세요.", "Tu cuenta no tiene correo. Verifica con un SMS a tu teléfono vinculado."],
  bound: ["已绑定手机号", "已綁定手機號碼", "Linked phone", "登録済みの電話番号", "연결된 전화번호", "Teléfono vinculado"],
  full: ["请输入完整手机号", "請輸入完整手機號碼", "Enter the full phone number", "電話番号をすべて入力してください", "전체 전화번호를 입력하세요", "Introduce el número completo"],
  mismatch: ["手机号与已绑定号码不一致", "手機號碼與已綁定號碼不一致", "This is not the linked phone number", "登録済みの電話番号と一致しません", "연결된 전화번호와 일치하지 않습니다", "No coincide con el teléfono vinculado"],
  code: ["短信验证码", "簡訊驗證碼", "SMS code", "SMS認証コード", "문자 인증번호", "Código SMS"],
  send: ["发送验证码", "傳送驗證碼", "Send code", "コードを送信", "인증번호 보내기", "Enviar código"],
  sent: ["验证码已发送", "驗證碼已傳送", "Code sent", "コードを送信しました", "인증번호를 보냈습니다", "Código enviado"],
  verify: ["验证并继续", "驗證並繼續", "Verify and continue", "認証して続行", "확인 후 계속", "Verificar y continuar"],
  sendFirst: ["请先获取短信验证码", "請先取得簡訊驗證碼", "Request an SMS code first", "先にSMSコードを取得してください", "먼저 문자 인증번호를 받으세요", "Solicita primero el código SMS"],
  badCode: ["验证码格式错误", "驗證碼格式錯誤", "Enter the 6-digit code", "6桁のコードを入力してください", "6자리 인증번호를 입력하세요", "Introduce el código de 6 dígitos"],
  loading: ["正在确认账号验证方式...", "正在確認帳號驗證方式...", "Checking how to verify your account...", "本人確認の方法を確認しています...", "계정 인증 방법을 확인하는 중...", "Comprobando cómo verificar tu cuenta..."],
  unavailable: ["暂时无法确认账号验证方式，请稍后重试。", "暫時無法確認帳號驗證方式，請稍後重試。", "Can't check how to verify your account. Try again later.", "本人確認の方法を確認できません。しばらくしてから再試行してください。", "계정 인증 방법을 확인할 수 없습니다. 잠시 후 다시 시도하세요.", "No se puede comprobar la verificación. Inténtalo más tarde."],
  manual: ["你的账号没有可用于自助验证的邮箱或手机号。为保护账号安全，请发送邮件至 support@sunland.dev 申请人工核验后注销。", "你的帳號沒有可用於自助驗證的郵箱或手機號碼。為保護帳號安全，請寄信至 support@sunland.dev 申請人工核驗後註銷。", "Your account has no email or phone for self-service verification. To protect it, email support@sunland.dev for a manual identity check.", "セルフ認証に使えるメールまたは電話番号がありません。安全のため support@sunland.dev へご連絡のうえ、本人確認を受けてください。", "자체 인증에 사용할 이메일이나 전화번호가 없습니다. 계정 보호를 위해 support@sunland.dev 로 수동 확인을 요청하세요.", "Tu cuenta no tiene correo ni teléfono para verificarte. Escribe a support@sunland.dev para una verificación manual."],
  relogin: ["请退出后重新登录，再使用邮箱验证码注销账号。", "請登出後重新登入，再使用郵箱驗證碼註銷帳號。", "Sign out and sign in again, then verify with your email to delete the account.", "一度ログアウトして再ログインし、メール認証で削除してください。", "로그아웃 후 다시 로그인한 다음 이메일 인증으로 삭제하세요.", "Cierra sesión, vuelve a entrar y verifica con tu correo para eliminar la cuenta."],
  support: ["当前账号暂时无法自助验证，请发送邮件至 support@sunland.dev 申请人工核验后注销。", "目前帳號暫時無法自助驗證，請寄信至 support@sunland.dev 申請人工核驗後註銷。", "This account can't be verified here right now. Email support@sunland.dev for a manual check to delete it.", "このアカウントは現在ここで本人確認できません。削除するには support@sunland.dev に本人確認をご依頼ください。", "현재 이 계정은 여기서 인증할 수 없습니다. 삭제하려면 support@sunland.dev 로 수동 확인을 요청하세요.", "Esta cuenta no se puede verificar aquí ahora. Escribe a support@sunland.dev para una verificación manual."],
  noSms: ["收不到短信？请发送邮件至 support@sunland.dev 申请人工核验，无法跳过验证。", "收不到簡訊？請寄信至 support@sunland.dev 申請人工核驗，無法略過驗證。", "No SMS? Email support@sunland.dev for a manual check. Verification can't be skipped.", "SMSが届かない場合は support@sunland.dev へ本人確認をご依頼ください。認証は省略できません。", "문자를 받지 못했나요? support@sunland.dev 로 수동 확인을 요청하세요. 인증은 생략할 수 없습니다.", "¿Sin SMS? Escribe a support@sunland.dev para una verificación manual. No se puede omitir."],
};
const PHONE_LANGS = ["zh-CN", "zh-Hant", "en", "ja", "ko", "es"];
function phoneText(key) {
  const lang = globalThis.SiteI18n?.getLanguage?.() || "zh-CN";
  return PHONE_COPY[key]?.[Math.max(0, PHONE_LANGS.indexOf(lang))] || PHONE_COPY[key]?.[0] || "";
}
function phoneErrorText(error) {
  return globalThis.SunlandPhoneAuth?.errorText?.(error) || phoneText("unavailable");
}

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
      return { id: String(user.id || user.email), email: typeof user.email === "string" ? user.email : "" };
    }
  } catch {}

  try {
    const token = getAppToken();
    if (token) {
      const payload = decodeJwtPayload(token);
      const id = payload?.sub || payload?.id || payload?.user_id || payload?.email;
      const email = payload?.email || payload?.user_email || payload?.mail || "";
      if (id) return { id: String(id), email: typeof email === "string" ? email : "" };
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
  const owner=normalizeUserId(userId),prefix=vaultPrefix(owner);
  for (let i=0;i<localStorage.length;i++) {
    const key=localStorage.key(i);
    if(key?.startsWith(prefix)) {
      let branch;
      try { branch=JSON.parse(localStorage.getItem(key)); }
      catch { throw new Error('本机分支格式无效，原数据已保留'); }
      if(branch?.owner===owner) keys.push(key);
    }
  }
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
  const email = user?.email?.trim() || "";
  if (!email) {
    void renderPhoneStep2();
    return;
  }
  renderEmailStep2(email);
}

// Accounts without an email reauthenticate with the bound phone. The phone
// Worker binds the SMS challenge and grant to this user, session and the
// delete purpose; the resulting job then runs through the unchanged execute.
async function renderPhoneStep2() {
  const step = currentStep;
  bodyEl.innerHTML = '<div class="account-delete-step active"><p class="account-delete-copy" id="accountDeletePhoneLoading"></p></div>';
  bodyEl.querySelector("#accountDeletePhoneLoading").textContent = phoneText("loading");
  let status = null;
  let failure = null;
  try {
    phoneClient = phoneClient || globalThis.SunlandPhoneAuth?.createClient?.() || null;
    if (phoneClient) status = await phoneClient.status();
  } catch (error) {
    failure = error;
  }
  if (currentStep !== step || !dialog?.open) return;
  if (failure?.code === "ACCOUNT_BANNED") {
    renderNotice(phoneText("support"));
    return;
  }
  if (!status) {
    renderNotice(phoneText("unavailable"));
    return;
  }
  if (!status.bound) {
    renderNotice(phoneText(status.has_email ? "relogin" : "manual"));
    return;
  }
  bodyEl.innerHTML = `
    <div class="account-delete-step active">
      <p class="account-delete-copy" id="accountDeletePhoneIntro"></p>
      <div class="account-delete-field">
        <label for="accountDeletePhoneMasked" data-copy="bound"></label>
        <input id="accountDeletePhoneMasked" class="account-delete-input" type="text" readonly>
      </div>
      <div class="account-delete-field">
        <label for="accountDeletePhoneInput" data-copy="full"></label>
        <div class="account-delete-email-row">
          <input id="accountDeletePhoneInput" class="account-delete-input" type="tel" inputmode="numeric" autocomplete="tel-national" maxlength="11">
          <button id="accountDeleteSendBtn" class="account-delete-send" type="button" data-copy="send"></button>
        </div>
      </div>
      <div class="account-delete-field">
        <label for="accountDeleteCodeInput" data-copy="code"></label>
        <input id="accountDeleteCodeInput" class="account-delete-input" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6">
      </div>
      <div id="accountDeleteOtpStatus" class="account-delete-status" role="status" aria-live="polite"></div>
      <button id="accountDeleteVerifyBtn" class="account-delete-btn primary" type="button" data-copy="verify"></button>
      <p class="account-delete-copy" id="accountDeletePhoneHelp"></p>
    </div>
  `;
  bodyEl.querySelectorAll("[data-copy]").forEach((el) => { el.textContent = phoneText(el.dataset.copy); });
  bodyEl.querySelector("#accountDeletePhoneIntro").textContent = phoneText("intro");
  bodyEl.querySelector("#accountDeletePhoneHelp").textContent = phoneText("noSms");
  bodyEl.querySelector("#accountDeletePhoneMasked").value = status.phone;

  const phoneInput = bodyEl.querySelector("#accountDeletePhoneInput");
  const codeInput = bodyEl.querySelector("#accountDeleteCodeInput");
  const sendBtn = bodyEl.querySelector("#accountDeleteSendBtn");
  const verifyBtn = bodyEl.querySelector("#accountDeleteVerifyBtn");
  const statusEl = bodyEl.querySelector("#accountDeleteOtpStatus");
  const last4 = status.phone.slice(-4);
  let challenge = null;

  sendBtn.onclick = async () => {
    if (busy || sendBtn.disabled) return;
    const phone = phoneInput.value.replace(/\D/g, "");
    if (!/^1[3-9]\d{9}$/.test(phone)) { setStatus(statusEl, phoneText("full"), "error"); return; }
    if (phone.slice(-4) !== last4) { setStatus(statusEl, phoneText("mismatch"), "error"); return; }
    setBusy(true);
    sendBtn.disabled = true;
    setStatus(statusEl, "");
    try {
      const sent = await phoneClient.send(phone, "reauth");
      challenge = { phone, id: sent.challenge_id };
      setStatus(statusEl, phoneText("sent"), "success");
      codeInput.focus();
    } catch (error) {
      setStatus(statusEl, phoneErrorText(error), "error");
    } finally {
      sendBtn.disabled = false;
      setBusy(false);
    }
  };
  verifyBtn.onclick = async () => {
    if (busy) return;
    const code = codeInput.value.trim();
    if (!challenge) { setStatus(statusEl, phoneText("sendFirst"), "error"); return; }
    if (!/^\d{6}$/.test(code)) { setStatus(statusEl, phoneText("badCode"), "error"); return; }
    setBusy(true);
    verifyBtn.disabled = true;
    setStatus(statusEl, "");
    try {
      const proof = await phoneClient.phoneProof(challenge.phone, challenge.id, code, "delete");
      const authorized = await phoneClient.authorizeDelete(proof?.reauth_token);
      deletionJobId = authorized.deletion_job_id;
      deletionToken = authorized.deletion_token;
      cleanupIdentity = await prepareCleanupIdentity();
      renderStep3();
    } catch (error) {
      setStatus(statusEl, phoneErrorText(error), "error");
    } finally {
      verifyBtn.disabled = false;
      setBusy(false);
    }
  };
}

function renderNotice(message) {
  bodyEl.innerHTML = '<div class="account-delete-step active"><p class="account-delete-copy" id="accountDeleteNotice"></p></div>';
  bodyEl.querySelector("#accountDeleteNotice").textContent = message;
}

function renderEmailStep2(email) {
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
  phoneClient = null;
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
  currentStep = 0;
  try { phoneClient?.cancel?.(); } catch {}
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
