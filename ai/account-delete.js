import { normalizeUserId } from "./user-identity.js";
import { vaultPrefix } from './history-vault.js';

const API_BASE = "https://klyrasrqgxijwrxuoevj.supabase.co/functions/v1/sunland-account-delete";
const CONFIRMATION_TEXT = "删除我的账号";
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
let generation = 0;
let deletionSession = null;
let phoneClient = null;
let verificationMode = 'email';
let phoneChallenge = null;
let backdrop = null;
let authorizationExpiresAt = 0;
const controllers = new Set();
const tr = source => window.SunlandPhoneAuth?.text?.(source) || source;
const codedError = code => Object.assign(new Error(), { code });
function captureFlow() { return { generation, token: getAppToken(), userId: deletionSession?.id }; }
function currentFlow(attempt) { return generation === attempt.generation && getAppToken() === attempt.token; }
function requireCurrent(attempt) { if (!currentFlow(attempt)) throw codedError('SESSION_CHANGED'); }
function safeMessage(error) { return window.SunlandPhoneAuth?.errorText?.(error) || tr('当前身份校验失败，请重新登录'); }
function invalidateFlow() {
  generation++; phoneClient?.cancel();
  for (const controller of controllers) controller.abort();
  controllers.clear(); stopCooldown();
  deletionSession = null; phoneChallenge = null; deletionJobId = ''; deletionToken = ''; cleanupIdentity = null; authorizationExpiresAt = 0;
  bodyEl?.querySelectorAll('input').forEach(input => { input.value = ''; });
  setBusy(false);
}
async function edgeRequest(payload, attempt) {
  requireCurrent(attempt);
  const controller = new AbortController(); controllers.add(controller); let timer;
  try {
    const result = await Promise.race([(async () => {
      const response = await fetch(API_BASE, { method: 'POST', credentials: 'omit', redirect: 'error', headers: { 'Content-Type': 'application/json', 'x-sunland-token': attempt.token }, body: JSON.stringify(payload), signal: controller.signal });
      const data = await response.json(); requireCurrent(attempt);
      if (!response.ok && !(payload.action === 'execute' && data?.already_completed)) throw codedError(response.status === 401 ? 'UNAUTHORIZED' : 'SERVICE_UNAVAILABLE');
      return data;
    })(), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(codedError('TIMEOUT')); }, 30000); })]);
    requireCurrent(attempt); return result;
  } finally { clearTimeout(timer); controllers.delete(controller); }
}

function getAppToken() {
  try {
    return localStorage.getItem("token") || "";
  } catch {
    return "";
  }
}

function getCurrentUser() {
  return deletionSession && deletionSession.token === getAppToken() ? deletionSession : null;
}

function setStatus(el, message, type = "") {
  if (!el) return;
  el.dataset.deleteMessage = message;
  el.textContent = tr(message);
  el.className = `account-delete-status${type ? ` ${type}` : ""}`;
}

function setBusy(value) {
  busy = value;
  if (closeBtn) closeBtn.disabled = value && currentStep === 4;
}

async function sendVerificationCode(sendBtn, statusEl) {
  if (busy || sendBtn.disabled || !getCurrentUser()) return;
  const attempt = captureFlow(); setStatus(statusEl, ''); setBusy(true); sendBtn.disabled = true;
  try {
    if (verificationMode === 'email') {
      await phoneClient.emailSend(deletionSession.email); requireCurrent(attempt); startCooldown(sendBtn);
    } else {
      const value = bodyEl.querySelector('#accountDeletePhoneInput').value;
      const phone = window.SunlandPhoneAuth.normalizePhone(value);
      const result = await phoneClient.send(phone, 'reauth'); requireCurrent(attempt);
      phoneChallenge = { phone, id: result.challenge_id, expiresAt: Date.now() + result.expires_in * 1000 };
      startCooldown(sendBtn, Date.now() + result.retry_after * 1000);
    }
    setStatus(statusEl, '验证码已发送（有效期约5分钟）', 'success');
  } catch (error) {
    if (currentFlow(attempt)) { setStatus(statusEl, safeMessage(error), 'error'); sendBtn.disabled = false; sendBtn.textContent = tr('发送验证码'); }
  } finally { if (currentFlow(attempt)) setBusy(false); }
}

function startCooldown(sendBtn, until = Date.now() + COOLDOWN_SECONDS * 1000) {
  stopCooldown(); sendBtn.disabled = true;
  function tick() {
    const remaining = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    sendBtn.textContent = remaining ? `${remaining}s` : tr('发送验证码');
    sendBtn.disabled = remaining > 0;
    if (!remaining) stopCooldown();
  }
  tick(); if (until > Date.now()) cooldownTimer = setInterval(tick, 1000);
}

function stopCooldown() {
  if (cooldownTimer) {
    clearInterval(cooldownTimer);
    cooldownTimer = null;
  }
}

async function prepareCleanupIdentity() {
  if (cleanupIdentity && getCurrentUser()) return cleanupIdentity;
  const attempt = captureFlow();
  try {
    const { IdentityAuthority, isVerifiedIdentity } = await import("./verified-identity.js");
    const token = getAppToken();
    if (!token) return null;
    const cached = getCurrentUser();
    const authority = new IdentityAuthority();
    const result = await authority.resolve({ token, cachedUser: cached });
    if (!currentFlow(attempt)) return null;
    cleanupIdentity = result.ok && isVerifiedIdentity(result.identity) && result.identity.userId === attempt.userId ? result.identity : null;
  } catch {
    if (currentFlow(attempt)) cleanupIdentity = null;
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

export async function clearAccountLocalStorage(userId, { clearDiagnostics = async () => {}, expectedToken = localStorage.getItem("token") } = {}) {
  const unchanged = () => { if (localStorage.getItem("token") !== expectedToken) throw codedError("SESSION_CHANGED"); };
  unchanged();
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

  unchanged();
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
    void beginVerification();
  };
}

async function beginVerification() {
  if (busy) return;
  const attempt = captureFlow(); setBusy(true);
  const loading = document.createElement('p'); bodyEl.replaceChildren(loading); setStatus(loading, '正在确认账号状态…');
  try {
    if (!phoneClient || !attempt.token) throw codedError('UNAUTHORIZED');
    const verified = await phoneClient.deletionIdentity(); requireCurrent(attempt);
    if (!normalizeUserId(verified.user_id) || verified.identity_status !== 'active') throw codedError('ACCOUNT_NOT_ACTIVE');
    let status = null;
    try { status = await phoneClient.status(); }
    catch (error) { if (['ACCOUNT_NOT_ACTIVE', 'UNAUTHORIZED', 'SESSION_CHANGED'].includes(error.code)) throw error; }
    requireCurrent(attempt);
    deletionSession = { id: verified.user_id, email: typeof verified.email === 'string' && /^\S+@\S+\.\S+$/.test(verified.email) ? verified.email : '', token: attempt.token,
      allowPhone: status?.bound === true || !verified.email || verified.is_banned === true };
    verificationMode = deletionSession.email ? 'email' : 'phone'; renderStep2();
  } catch (error) { if (currentFlow(attempt)) { bodyEl.replaceChildren(loading); setStatus(loading, safeMessage(error), 'error'); } }
  finally { if (currentFlow(attempt)) setBusy(false); }
}
function renderStep2() {
  currentStep = 2;
  const user = getCurrentUser(); if (!user) return;
  phoneChallenge = null;
  bodyEl.innerHTML = `
    <div class="account-delete-step active">
      <p class="account-delete-copy" id="accountDeleteMethodCopy"></p>
      <div class="phone-tabs" role="group" aria-label="安全验证" data-site-i18n-ignore>
        <button id="accountDeleteEmailMode" type="button"></button><button id="accountDeletePhoneMode" type="button"></button>
      </div>
      <div class="account-delete-field" id="accountDeleteEmailField">
        <label for="accountDeleteEmailInput">当前邮箱</label><input id="accountDeleteEmailInput" class="account-delete-input" type="email" readonly>
      </div>
      <div class="account-delete-field" id="accountDeletePhoneField">
        <label for="accountDeletePhoneInput">当前绑定的手机号</label><div class="phone-input-row"><span>+86</span><input id="accountDeletePhoneInput" class="account-delete-input" type="tel" inputmode="tel" autocomplete="off" maxlength="14"></div>
      </div>
      <div class="account-delete-field">
        <label for="accountDeleteCodeInput">验证码</label><div class="account-delete-email-row"><input id="accountDeleteCodeInput" class="account-delete-input" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="输入 6 位验证码"><button id="accountDeleteSendBtn" class="account-delete-send" type="button">发送验证码</button></div>
      </div>
      <div id="accountDeleteOtpStatus" class="account-delete-status" role="status" aria-live="polite"></div>
      <button id="accountDeleteVerifyBtn" class="account-delete-btn primary" type="button">验证并继续</button>
    </div>`;
  const emailInput = bodyEl.querySelector('#accountDeleteEmailInput'), codeInput = bodyEl.querySelector('#accountDeleteCodeInput');
  const phoneInput = bodyEl.querySelector('#accountDeletePhoneInput'), sendBtn = bodyEl.querySelector('#accountDeleteSendBtn');
  const verifyBtn = bodyEl.querySelector('#accountDeleteVerifyBtn'), statusEl = bodyEl.querySelector('#accountDeleteOtpStatus');
  emailInput.value = user.email;
  const emailMode = bodyEl.querySelector('#accountDeleteEmailMode'), phoneMode = bodyEl.querySelector('#accountDeletePhoneMode');
  function select(mode, initial = false) {
    if (busy && !initial) return;
    if (!initial) { generation++; phoneClient.cancel(); }
    stopCooldown(); phoneChallenge = null; codeInput.value = ''; phoneInput.value = ''; verificationMode = mode;
    bodyEl.querySelector('#accountDeleteEmailField').hidden = mode !== 'email'; bodyEl.querySelector('#accountDeletePhoneField').hidden = mode !== 'phone';
    emailMode.setAttribute('aria-pressed', String(mode === 'email')); phoneMode.setAttribute('aria-pressed', String(mode === 'phone'));
    bodyEl.querySelector('#accountDeleteMethodCopy').textContent = tr(mode === 'phone' ? '删除账号属于高风险操作，请先通过短信验证码重新验证身份。' : '删除账号属于高风险操作，请先通过邮箱验证码重新验证身份。');
    sendBtn.disabled = false; sendBtn.textContent = tr('发送验证码'); setStatus(statusEl, '');
  }
  emailMode.hidden = !user.email; phoneMode.hidden = !user.allowPhone;
  emailMode.textContent = tr('使用邮箱验证'); phoneMode.textContent = tr('使用当前手机号验证');
  select(verificationMode, true);
  emailMode.onclick = () => select('email'); phoneMode.onclick = () => select('phone');
  phoneInput.oninput = () => { phoneChallenge = null; codeInput.value = ''; };
  sendBtn.onclick = () => void sendVerificationCode(sendBtn, statusEl);
  verifyBtn.onclick = () => void authorizeDeletion(codeInput.value.trim(), emailInput.value.trim(), verifyBtn, statusEl);
}
async function authorizeDeletion(code, email, verifyBtn, statusEl) {
  if (busy || !getCurrentUser()) return;
  if (!/^\d{6}$/.test(code)) { setStatus(statusEl, '验证码格式错误', 'error'); return; }
  const attempt = captureFlow(); setBusy(true); verifyBtn.disabled = true; setStatus(statusEl, '正在验证...');
  try {
    let data;
    if (verificationMode === 'phone') {
      const phone = window.SunlandPhoneAuth.normalizePhone(bodyEl.querySelector('#accountDeletePhoneInput').value);
      if (!phoneChallenge || phoneChallenge.phone !== phone || phoneChallenge.expiresAt <= Date.now()) throw codedError('CHALLENGE_EXPIRED');
      const proof = await phoneClient.phoneProof(phone, phoneChallenge.id, code, 'delete'); requireCurrent(attempt);
      // A proof is never returned to the UI or persisted; the existing job is authoritative.
      data = await phoneClient.authorizeDelete(proof.reauth_token); requireCurrent(attempt); phoneChallenge = null;
    } else {
      if (email !== deletionSession.email) throw codedError('UNAUTHORIZED');
      data = await edgeRequest({ action: 'authorize', email, code }, attempt);
    }
    requireCurrent(attempt);
    if (!data?.deletion_job_id || !data?.deletion_token) throw codedError('SERVICE_UNAVAILABLE');
    deletionJobId = data.deletion_job_id; deletionToken = data.deletion_token;
    authorizationExpiresAt = Date.now() + Math.min(600, Number(data.expires_in) || 600) * 1000;
    bodyEl.querySelectorAll('input').forEach(input => { input.value = ''; }); stopCooldown();
    cleanupIdentity = await prepareCleanupIdentity(); requireCurrent(attempt); renderStep3();
  } catch (error) { if (currentFlow(attempt)) { phoneChallenge = null; bodyEl.querySelector('#accountDeleteCodeInput').value = ''; setStatus(statusEl, safeMessage(error), 'error'); } }
  finally { if (currentFlow(attempt)) { verifyBtn.disabled = false; setBusy(false); } }
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
  if (busy || !deletionJobId || !deletionToken || !getCurrentUser()) return;
  if (currentStep === 3 && Date.now() >= authorizationExpiresAt) {
    deletionJobId = ''; deletionToken = ''; authorizationExpiresAt = 0;
    renderStep2(); setStatus(bodyEl.querySelector('#accountDeleteOtpStatus'), '安全验证已失效，请重新验证', 'error'); return;
  }
  const attempt = captureFlow(), job = deletionJobId, token = deletionToken;
  renderStep4(); setBusy(true);
  try {
    const identity = cleanupIdentity || await prepareCleanupIdentity(); requireCurrent(attempt);
    const data = await edgeRequest({ action: 'execute', deletion_job_id: job, deletion_token: token, confirmation: CONFIRMATION_TEXT }, attempt);
    requireCurrent(attempt);
    const userId = normalizeUserId(data.user_id);
    if (userId !== attempt.userId) throw codedError('UNAUTHORIZED');
    await clearAccountLocalStorage(userId, { clearDiagnostics: () => clearDiagnosticsForIdentity(identity), expectedToken: attempt.token });
    if (generation !== attempt.generation) return;
    deletionJobId = ''; deletionToken = ''; cleanupIdentity = null; phoneChallenge = null; deletionSession = null;
    renderStep5(true, '账号已删除，正在返回登录页...');
    setTimeout(() => { if (generation === attempt.generation && !getAppToken()) window.location.replace('login.html'); }, 1600);
  } catch (error) { if (currentFlow(attempt)) renderStep5(false, safeMessage(error)); }
  finally { if (generation === attempt.generation) setBusy(false); }
}

function openDialog() {
  if (!dialog) return;
  invalidateFlow(); renderStep1();
  // Keep third-party captcha portals interactive rather than making body inert.
  if (typeof dialog.show === 'function') dialog.show(); else dialog.setAttribute('open', '');
  backdrop.hidden = false; bodyEl.querySelector('button')?.focus();
}
function closeDialog(force = false) {
  if (!dialog || (busy && currentStep === 4 && !force)) return;
  invalidateFlow();
  if (typeof dialog.close === 'function' && dialog.open) dialog.close(); else dialog.removeAttribute('open');
  if (backdrop) backdrop.hidden = true; openBtn?.focus();
}

export function initAccountDelete() {
  dialog = document.getElementById("accountDeleteDialog");
  openBtn = document.getElementById("openAccountDeleteBtn");
  closeBtn = document.getElementById("accountDeleteCloseBtn");
  bodyEl = document.getElementById("accountDeleteBody");
  if (!dialog || !openBtn || !closeBtn || !bodyEl) return;

  if (dialog.dataset.accountDeleteBound === '1') return;
  dialog.dataset.accountDeleteBound = '1';
  phoneClient = window.SunlandPhoneAuth?.createClient?.() || null;
  dialog.classList.add('phone-auth', 'phone-dialog'); dialog.setAttribute('aria-modal', 'true');
  backdrop = document.createElement('div'); backdrop.className = 'phone-settings-backdrop'; backdrop.hidden = true; backdrop.setAttribute('aria-hidden', 'true'); document.body.appendChild(backdrop);
  openBtn.onclick = openDialog;
  closeBtn.onclick = () => closeDialog();
  backdrop.onclick = () => closeDialog();
  window.addEventListener('storage', event => { if (event.key === 'token' || event.key === null) closeDialog(true); });
  window.addEventListener('pagehide', () => closeDialog(true));
  const tokenWatcher = setInterval(() => { if (dialog.open && deletionSession && deletionSession.token !== getAppToken()) closeDialog(true); }, 250);
  window.addEventListener('pagehide', () => clearInterval(tokenWatcher), { once: true });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeDialog(); return; }
    if (event.key !== 'Tab') return;
    const controls = Array.from(dialog.querySelectorAll('button,input')).filter(node => !node.disabled && !node.closest('[hidden]'));
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault(); closeDialog();
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
