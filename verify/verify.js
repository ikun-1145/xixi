import { applyTranslations, getLocale, t } from "./i18n.js?v=20260822-1";
import { renderReport } from "./render.js";
import {
  compressChatImage,
  MAX_PREPARED_CHAT_IMAGE_BYTES,
} from "../ai/multimodal.js?v=20260822-2";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js";
const elements = Object.fromEntries([
  "textTab", "imageTab", "textPanel", "imagePanel", "verifyText", "charCount", "dropzone", "imageInput",
  "imagePreview", "previewImage", "previewName", "previewMeta", "removeImage", "verifyButton",
  "progressSection", "progressNote", "errorPanel", "errorMessage", "loginLink", "reportSection",
  "reportRoot", "capabilityNotice", "usageHint", "toast",
].map((id) => [id, document.getElementById(id)]));

let inputType = "text";
let selectedFile = null;
let previewUrl = "";
let tesseractPromise = null;
let toastTimer = 0;
let usageState = null;

function translate(key) { return t(key, getLocale()); }

function renderUsageHint() {
  const unlimited = Boolean(usageState?.unlimited);
  const usageKey = usageState?.unlimited ? "proAuthHint" : "authHint";
  const text = translate(usageKey);
  elements.usageHint.classList.toggle("is-pro", unlimited);
  if (!unlimited) {
    elements.usageHint.textContent = text;
    return;
  }
  const icon = document.createElement("span");
  icon.className = "ui-svg-icon icon-gem";
  icon.setAttribute("aria-hidden", "true");
  elements.usageHint.replaceChildren(icon, document.createTextNode(text));
}

function applyUsage(usage) {
  if (!usage || typeof usage.unlimited !== "boolean") return;
  usageState = usage.unlimited ? { unlimited: true } : { unlimited: false };
  renderUsageHint();
}

function clearLocalSession() {
  try { localStorage.removeItem("token"); } catch {}
  try { localStorage.removeItem("user"); } catch {}
}

function redirectToLogin() {
  location.replace("login.html?return=verify.html");
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => elements.toast.classList.remove("show"), 2600);
}

function selectInputType(nextType) {
  inputType = nextType;
  const textActive = nextType === "text";
  elements.textTab.classList.toggle("active", textActive);
  elements.imageTab.classList.toggle("active", !textActive);
  elements.textTab.setAttribute("aria-selected", String(textActive));
  elements.imageTab.setAttribute("aria-selected", String(!textActive));
  elements.textPanel.hidden = !textActive;
  elements.imagePanel.hidden = textActive;
}

function clearImage() {
  selectedFile = null;
  elements.imageInput.value = "";
  elements.imagePreview.hidden = true;
  elements.dropzone.hidden = false;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = "";
  elements.previewImage.removeAttribute("src");
}

function selectImage(file) {
  if (!file || !ALLOWED_TYPES.has(file.type)) {
    showToast(translate("invalidImage"));
    return;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    showToast(translate("imageTooLarge"));
    return;
  }
  clearImage();
  selectedFile = file;
  previewUrl = URL.createObjectURL(file);
  elements.previewImage.src = previewUrl;
  elements.previewName.textContent = file.name;
  elements.previewMeta.textContent = `${file.type} · ${(file.size / 1024 / 1024).toFixed(2)} MB`;
  elements.dropzone.hidden = true;
  elements.imagePreview.hidden = false;
}

async function prepareVerificationImage(file) {
  if (file.size <= MAX_PREPARED_CHAT_IMAGE_BYTES) return file;
  const compressed = await compressChatImage(file, {
    targetBytes: MAX_PREPARED_CHAT_IMAGE_BYTES,
  });
  const baseName = String(file.name || "image").replace(/\.[^.]*$/u, "").slice(0, 150) || "image";
  return new File([compressed], `${baseName}.jpg`, {
    type: compressed.type,
    lastModified: Number.isFinite(file.lastModified) ? file.lastModified : Date.now(),
  });
}

function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (tesseractPromise) return tesseractPromise;
  tesseractPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TESSERACT_URL;
    script.async = true;
    script.referrerPolicy = "no-referrer";
    script.onload = () => window.Tesseract ? resolve(window.Tesseract) : reject(new Error("OCR runtime missing"));
    script.onerror = () => reject(new Error("OCR runtime failed to load"));
    document.head.append(script);
  });
  return tesseractPromise;
}

async function extractImageText(file) {
  elements.progressNote.textContent = translate("ocrWorking");
  const Tesseract = await loadTesseract();
  let worker;
  try {
    worker = await Tesseract.createWorker("chi_sim+eng", 1, {
      logger(message) {
        if (message?.status) elements.progressNote.textContent = translate("ocrWorking");
      },
    });
    const result = await worker.recognize(file);
    return String(result?.data?.text || "").trim().slice(0, 12_000);
  } finally {
    if (worker) await worker.terminate();
  }
}

function setLoading(loading) {
  elements.verifyButton.disabled = loading;
  elements.verifyButton.classList.toggle("loading", loading);
  elements.progressSection.hidden = !loading;
  if (loading) {
    elements.progressNote.textContent = translate("progressNote");
    setProgressStage(0);
  }
}

function setProgressStage(activeIndex) {
  document.querySelectorAll("#analysisSteps li").forEach((step, index) => {
    step.classList.toggle("active", index === activeIndex);
    step.classList.toggle("complete", index < activeIndex);
  });
}

function completeProgress() {
  document.querySelectorAll("#analysisSteps li").forEach((step) => {
    step.classList.remove("active");
    step.classList.add("complete");
  });
}

function showError(message, code = "") {
  elements.errorMessage.textContent = message;
  elements.errorPanel.hidden = false;
  elements.loginLink.hidden = code !== "AUTH_REQUIRED";
  elements.errorPanel.scrollIntoView({ behavior: "smooth", block: "center" });
}

function localizedError(code, fallback) {
  const known = {
    AUTH_REQUIRED: "authRequired",
    CONTENT_REQUIRED: "contentRequired",
    IMAGE_REQUIRED: "imageRequired",
    IMAGE_TOO_LARGE: "imageTooLarge",
    IMAGE_TYPE_INVALID: "invalidImage",
    IMAGE_SIGNATURE_INVALID: "invalidImage",
    REQUEST_TOO_LARGE: "imageTooLarge",
    SEARCH_UNAVAILABLE: "searchUnavailable",
    SEARCH_AUTH_ERROR: "searchFailed",
    SEARCH_FORBIDDEN: "searchFailed",
    SEARCH_PROVIDER_ERROR: "searchFailed",
    SEARCH_RESPONSE_INVALID: "searchFailed",
    SEARCH_RATE_LIMITED: "searchRateLimited",
    SEARCH_TIMEOUT: "requestTimeout",
    MODEL_TIMEOUT: "requestTimeout",
  };
  return known[code] ? translate(known[code]) : fallback;
}

async function submitVerification() {
  elements.errorPanel.hidden = true;
  elements.reportSection.hidden = true;
  const token = localStorage.getItem("token") || "";
  if (!token) {
    redirectToLogin();
    return;
  }
  if (inputType === "text" && !elements.verifyText.value.trim()) {
    showToast(translate("contentRequired"));
    elements.verifyText.focus();
    return;
  }
  if (inputType === "image" && !selectedFile) {
    showToast(translate("imageRequired"));
    return;
  }

  setLoading(true);
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 95_000);
  try {
    let ocrText = "";
    let ocrStatus = "complete";
    let requestImageFile = selectedFile;
    const textContent = inputType === "text" ? elements.verifyText.value.trim() : "";
    if (inputType === "image") {
      try {
        requestImageFile = await prepareVerificationImage(selectedFile);
      } catch {
        throw Object.assign(new Error(translate("invalidImage")), { code: "IMAGE_SIGNATURE_INVALID" });
      }
      try {
        ocrText = await extractImageText(requestImageFile);
      } catch {
        ocrStatus = "failed";
      }
    }

    const runStage = async (stage, claims) => {
      const headers = { authorization: `Bearer ${token}` };
      let body;
      if (inputType === "image") {
        const form = new FormData();
        form.set("type", "image");
        form.set("locale", getLocale());
        form.set("stage", stage);
        form.set("file", requestImageFile, requestImageFile.name);
        form.set("ocrText", ocrText);
        form.set("ocrStatus", ocrStatus);
        if (claims) form.set("claims", JSON.stringify(claims));
        body = form;
      } else {
        headers["content-type"] = "application/json";
        body = JSON.stringify({
          type: "text",
          content: textContent,
          locale: getLocale(),
          stage,
          ...(claims ? { claims } : {}),
        });
      }

      const response = await fetch("/api/verify", { method: "POST", headers, body, signal: controller.signal });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) {
        const code = payload?.error?.code || (response.status === 413 ? "REQUEST_TOO_LARGE" : "REQUEST_FAILED");
        if (response.status === 401 || code === "AUTH_REQUIRED") {
          clearLocalSession();
          redirectToLogin();
          throw Object.assign(new Error("Authentication required"), { code, redirected: true });
        }
        throw Object.assign(new Error(localizedError(
          code,
          payload?.error?.message || `HTTP ${response.status}`,
        )), { code });
      }
      return payload;
    };

    setProgressStage(1);
    const extraction = await runStage("extract");
    applyUsage(extraction.usage);
    let payload = extraction;
    if (extraction.stage === "claims_extracted") {
      setProgressStage(2);
      payload = await runStage("judge", extraction.claims);
      applyUsage(payload.usage);
    }
    setProgressStage(4);
    completeProgress();
    renderReport(elements.reportRoot, payload, translate);
    elements.reportSection.hidden = false;
    elements.reportSection.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    if (error?.redirected) return;
    const message = error?.name === "AbortError" ? translate("requestTimeout") : error.message;
    showError(message, error.code);
  } finally {
    clearTimeout(timeout);
    setLoading(false);
  }
}

async function checkCapabilities() {
  try {
    const response = await fetch("/api/verify", { headers: { accept: "application/json" }, cache: "no-store" });
    const payload = await response.json();
    if (!payload?.capabilities?.search?.available) {
      elements.capabilityNotice.textContent = translate("searchUnavailable");
      elements.capabilityNotice.hidden = false;
    }
  } catch {
    // 能力探测失败不替代真实 POST 错误；避免首屏被非关键请求阻塞。
  }
}

elements.textTab.addEventListener("click", () => selectInputType("text"));
elements.imageTab.addEventListener("click", () => selectInputType("image"));
elements.verifyText.addEventListener("input", () => { elements.charCount.textContent = `${elements.verifyText.value.length.toLocaleString()} / 12,000`; });
elements.dropzone.addEventListener("click", () => elements.imageInput.click());
elements.dropzone.addEventListener("dragover", (event) => { event.preventDefault(); elements.dropzone.classList.add("dragover"); });
elements.dropzone.addEventListener("dragleave", () => elements.dropzone.classList.remove("dragover"));
elements.dropzone.addEventListener("drop", (event) => { event.preventDefault(); elements.dropzone.classList.remove("dragover"); selectImage(event.dataTransfer?.files?.[0]); });
elements.imageInput.addEventListener("change", () => selectImage(elements.imageInput.files?.[0]));
elements.removeImage.addEventListener("click", clearImage);
elements.verifyButton.addEventListener("click", submitVerification);

window.addEventListener("site-language-change", () => {
  applyTranslations();
  renderUsageHint();
  if (!elements.capabilityNotice.hidden) elements.capabilityNotice.textContent = translate("searchUnavailable");
});
window.addEventListener("beforeunload", () => { if (previewUrl) URL.revokeObjectURL(previewUrl); });

applyTranslations();
renderUsageHint();
checkCapabilities();
