import {
  createBetaDiagnosticsAggregator,
  createBetaDiagnosticsSyncChannel,
  createBetaDiagnosticsStorage,
  createEmptyDiagnosticsSnapshot,
  DEVICE_SECRET_STORAGE_KEY,
} from "./beta-diagnostics/index.js";
import {
  getVerifiedUserId,
  IdentityAuthority,
  IDENTITY_LOGIN_STATE_MESSAGE,
  isVerifiedIdentity,
} from "./verified-identity.js";

const ENABLE_CONFIRMATION =
  "开启后，只会在此设备保存匿名聚合数据，不会自动上传。确定参与本地 Beta 诊断吗？";
const EXPORT_CONFIRMATION =
  "导出内容只包含上方显示的匿名聚合数据。";
const CLEAR_CONFIRMATION =
  "确定清除此设备上当前账号的本地 Beta 诊断数据吗？此操作不会删除聊天记录、姓名记忆或教学知识。";
const EXPORT_FILENAME = "sunland-beta-diagnostics.json";

const COUNTER_LABELS = Object.freeze([
  ["requestCompleted", "Sunland 请求总数"],
  ["understood", "正常理解"],
  ["clarification", "澄清"],
  ["noUnderstanding", "未理解"],
  ["missingKnowledge", "缺少知识"],
  ["contextUsed", "Context 使用"],
  ["legacyFallback", "Legacy 回退"],
  ["sideEffectBlocked", "副作用阻止"],
  ["safeFallback", "安全降级"],
]);

const PERFORMANCE_GROUPS = Object.freeze([
  ["total", "总处理耗时"],
  ["semantic", "Semantic 耗时"],
  ["reasoner", "Reasoner 耗时"],
]);

function readCachedDisplayUser(storage) {
  try {
    const value = JSON.parse(storage?.getItem("user") || "null");
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

function defaultConfirm(message, windowRef) {
  return typeof windowRef?.confirm === "function"
    ? windowRef.confirm(message)
    : false;
}

function defaultDownloadJson({ documentRef, windowRef, filename, json }) {
  const BlobConstructor = windowRef?.Blob ?? globalThis.Blob;
  const urlApi = windowRef?.URL ?? globalThis.URL;
  if (
    !documentRef ||
    typeof BlobConstructor !== "function" ||
    typeof urlApi?.createObjectURL !== "function"
  ) {
    return false;
  }

  const blob = new BlobConstructor([json], { type: "application/json" });
  const url = urlApi.createObjectURL(blob);
  const link = documentRef.createElement("a");
  link.href = url;
  link.download = filename;
  link.hidden = true;
  documentRef.body.appendChild(link);
  link.click();
  link.remove();
  urlApi.revokeObjectURL(url);
  return true;
}

function formatExportJson(exportData) {
  return JSON.stringify(exportData, null, 2);
}

export function createSunlandBetaDiagnosticsController({
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  storageRef = globalThis.localStorage,
  cryptoImpl = globalThis.crypto,
  identityAuthority = new IdentityAuthority(),
  diagnosticsStorage = createBetaDiagnosticsStorage({
    storage: storageRef,
    cryptoImpl,
  }),
  createAggregator = createBetaDiagnosticsAggregator,
  syncChannel = createBetaDiagnosticsSyncChannel({
    BroadcastChannelImpl: windowRef?.BroadcastChannel,
  }),
  confirmImpl = message => defaultConfirm(message, windowRef),
  clipboard = globalThis.navigator?.clipboard,
  downloadJson = defaultDownloadJson,
} = {}) {
  const elements = {
    section: documentRef?.getElementById("betaDiagnosticsSection"),
    summary: documentRef?.getElementById("betaDiagnosticsSummary"),
    toggle: documentRef?.getElementById("betaDiagnosticsToggle"),
    state: documentRef?.getElementById("betaDiagnosticsState"),
    status: documentRef?.getElementById("betaDiagnosticsStatus"),
    empty: documentRef?.getElementById("betaDiagnosticsEmpty"),
    counters: documentRef?.getElementById("betaDiagnosticsCounters"),
    performance: documentRef?.getElementById("betaDiagnosticsPerformance"),
    viewButton: documentRef?.getElementById("viewDiagnosticsExportBtn"),
    copyButton: documentRef?.getElementById("copyDiagnosticsExportBtn"),
    exportButton: documentRef?.getElementById("downloadDiagnosticsExportBtn"),
    clearButton: documentRef?.getElementById("clearDiagnosticsBtn"),
    dialog: documentRef?.getElementById("diagnosticsPreviewDialog"),
    dialogContent: documentRef?.getElementById("diagnosticsPreviewContent"),
    dialogClose: documentRef?.getElementById("closeDiagnosticsPreviewBtn"),
  };

  let identity = null;
  let aggregator = null;
  let mode = "off";
  let snapshotLoaded = false;
  let storedSnapshotExists = false;
  let busy = false;
  let disposed = false;
  let lifecycleVersion = 0;
  let previousDialogFocus = null;

  function getElement(id) {
    return documentRef?.getElementById(id) ?? null;
  }

  function hasValidIdentity() {
    return isVerifiedIdentity(identity);
  }

  function currentSnapshot() {
    const result = aggregator?.getSnapshot();
    return result?.ok ? result.snapshot : createEmptyDiagnosticsSnapshot();
  }

  function snapshotHasData(snapshot = currentSnapshot()) {
    return snapshot.counters.requestCompleted > 0;
  }

  function setStatus(message, type = "") {
    if (!elements.status) return;
    elements.status.textContent = message;
    elements.status.className =
      `beta-diagnostics-status${type ? ` ${type}` : ""}`;
  }

  function updateCountViews(snapshot) {
    for (const [key] of COUNTER_LABELS) {
      const element = getElement(`betaDiagnosticsCounter-${key}`);
      if (element) element.textContent = String(snapshot.counters[key]);
    }

    for (const [group] of PERFORMANCE_GROUPS) {
      for (const [bucket, value] of Object.entries(snapshot.durations[group])) {
        const element = getElement(
          `betaDiagnosticsDuration-${group}-${bucket}`,
        );
        if (element) element.textContent = String(value);
      }
    }
    for (const [bucket, value] of Object.entries(snapshot.knowledgeSizeBuckets)) {
      const element = getElement(`betaDiagnosticsKnowledge-${bucket}`);
      if (element) element.textContent = String(value);
    }
    for (const [bucket, value] of Object.entries(snapshot.reasonerPathBuckets)) {
      const element = getElement(`betaDiagnosticsPath-${bucket}`);
      if (element) element.textContent = String(value);
    }
  }

  function render() {
    const identityValid = hasValidIdentity();
    const hasData = snapshotHasData();
    const disabled = busy || !identityValid;

    if (elements.toggle) {
      elements.toggle.checked = mode === "local";
      elements.toggle.disabled = disabled;
      elements.toggle.setAttribute("aria-disabled", String(disabled));
    }
    if (elements.state) {
      elements.state.textContent = !identityValid
        ? "需要重新登录"
        : mode === "local"
          ? "已开启 · 仅本地"
          : "默认关闭";
    }
    if (elements.empty) elements.empty.hidden = hasData;
    if (elements.counters) elements.counters.hidden = !hasData;
    if (elements.performance) elements.performance.hidden = !hasData;

    for (const button of [
      elements.viewButton,
      elements.copyButton,
      elements.exportButton,
    ]) {
      if (button) button.disabled = disabled || !hasData;
    }
    if (elements.clearButton) {
      elements.clearButton.disabled =
        disabled || (!storedSnapshotExists && !hasData);
    }

    updateCountViews(currentSnapshot());
  }

  function replaceAggregator(nextMode, snapshot = null) {
    aggregator?.dispose();
    aggregator = createAggregator({
      mode: nextMode,
      snapshot,
    });
    mode = nextMode;
  }

  function clearInMemoryState({ clearIdentity = false } = {}) {
    aggregator?.dispose();
    aggregator = null;
    mode = "off";
    snapshotLoaded = false;
    storedSnapshotExists = false;
    if (clearIdentity) {
      identityAuthority.clear();
      identity = null;
    }
  }

  function deviceBoundaryExists() {
    try {
      return storageRef?.getItem(DEVICE_SECRET_STORAGE_KEY) !== null;
    } catch {
      return null;
    }
  }

  async function resolveIdentity({ force = false } = {}) {
    let token;
    try {
      token = storageRef?.getItem("token");
    } catch {
      token = null;
    }
    const result = await identityAuthority.resolve({
      token,
      cachedUser: readCachedDisplayUser(storageRef),
      force,
    });
    if (!result.ok || !isVerifiedIdentity(result.identity)) return null;
    return result.identity;
  }

  async function loadSnapshotForIdentity({
    resetMessage = true,
  } = {}) {
    if (!hasValidIdentity()) return false;
    const boundary = deviceBoundaryExists();
    if (boundary === null) {
      setStatus("当前浏览器无法访问本地诊断数据。", "error");
      return false;
    }
    if (!boundary) {
      replaceAggregator(mode, null);
      snapshotLoaded = true;
      storedSnapshotExists = false;
      render();
      return true;
    }

    const loaded = await diagnosticsStorage.loadSnapshot(identity);
    if (!loaded.ok) {
      setStatus("暂时无法读取本地诊断数据，请稍后再试。", "error");
      return false;
    }
    replaceAggregator(mode, loaded.snapshot);
    snapshotLoaded = true;
    storedSnapshotExists = loaded.snapshot !== null;
    render();
    if (loaded.discarded && resetMessage) {
      setStatus("本地诊断数据已重置。", "success");
    }
    return true;
  }

  async function loadIdentityState(nextIdentity) {
    identity = nextIdentity;
    const boundary = deviceBoundaryExists();
    if (boundary === null) {
      replaceAggregator("off", null);
      setStatus("当前浏览器无法访问本地诊断设置。", "error");
      render();
      return false;
    }
    if (!boundary) {
      replaceAggregator("off", null);
      snapshotLoaded = false;
      storedSnapshotExists = false;
      render();
      return true;
    }

    const loadedMode = await diagnosticsStorage.loadMode(identity);
    if (!loadedMode.ok) {
      replaceAggregator("off", null);
      setStatus("暂时无法读取本地诊断设置，请稍后再试。", "error");
      render();
      return false;
    }

    mode = loadedMode.mode;
    if (mode === "local") {
      return loadSnapshotForIdentity();
    }
    replaceAggregator("off", null);
    snapshotLoaded = false;
    storedSnapshotExists = false;
    render();
    return true;
  }

  async function refreshIdentityForAction() {
    const previousUserId = getVerifiedUserId(identity);
    const nextIdentity = await resolveIdentity({ force: true });
    if (!nextIdentity) {
      clearInMemoryState({ clearIdentity: true });
      setStatus(IDENTITY_LOGIN_STATE_MESSAGE, "error");
      render();
      return false;
    }

    const nextUserId = getVerifiedUserId(nextIdentity);
    identity = nextIdentity;
    if (previousUserId && previousUserId !== nextUserId) {
      clearInMemoryState();
      identity = nextIdentity;
      await loadIdentityState(nextIdentity);
      setStatus("账号已切换，请确认当前账号后再操作。", "error");
      return false;
    }
    return true;
  }

  async function ensureSnapshotLoaded() {
    if (snapshotLoaded) return true;
    return loadSnapshotForIdentity();
  }

  async function initialize() {
    if (disposed) return { ok: false, reason: "disposed" };
    const version = ++lifecycleVersion;
    busy = true;
    setStatus("正在确认登录状态。");
    render();

    try {
      const nextIdentity = await resolveIdentity({ force: true });
      if (disposed || version !== lifecycleVersion) {
        return { ok: false, reason: "stale-initialization" };
      }
      if (!nextIdentity) {
        clearInMemoryState({ clearIdentity: true });
        busy = false;
        setStatus(IDENTITY_LOGIN_STATE_MESSAGE, "error");
        render();
        return { ok: false, reason: "invalid-identity" };
      }

      identity = nextIdentity;
      await loadIdentityState(nextIdentity);
      if (disposed || version !== lifecycleVersion) {
        return { ok: false, reason: "stale-initialization" };
      }
      busy = false;
      if (
        !elements.status?.classList.contains("error") &&
        !elements.status?.classList.contains("success")
      ) {
        setStatus("");
      }
      render();
      return { ok: true, mode };
    } catch {
      if (!disposed && version === lifecycleVersion) {
        clearInMemoryState({ clearIdentity: true });
        replaceAggregator("off", null);
        busy = false;
        setStatus(
          "本地诊断设置暂时不可用，其他设置不受影响。",
          "error",
        );
        render();
      }
      return { ok: false, reason: "initialization-failed" };
    }
  }

  async function setParticipation(enabled) {
    if (disposed || busy) return { ok: false, reason: "unavailable" };
    if (enabled && !confirmImpl(ENABLE_CONFIRMATION)) {
      render();
      return { ok: false, reason: "cancelled" };
    }

    busy = true;
    render();
    try {
      if (!await refreshIdentityForAction()) {
        return { ok: false, reason: "invalid-or-changed-identity" };
      }

      const nextMode = enabled ? "local" : "off";
      const saved = await diagnosticsStorage.saveMode(identity, nextMode);
      if (!saved.ok) {
        setStatus("暂时无法保存本地诊断设置，请稍后再试。", "error");
        return { ok: false, reason: saved.reason };
      }

      mode = nextMode;
      syncChannel?.notify?.("mode-changed");
      if (nextMode === "local") {
        await loadSnapshotForIdentity();
        setStatus(
          "已开启本地 Beta 诊断。当前不会自动上传任何数据。",
          "success",
        );
      } else {
        aggregator?.setMode("off");
        setStatus(
          "已停止本地诊断。之前保存的诊断数据仍保留，可使用“清除诊断数据”删除。",
          "success",
        );
      }
      return { ok: true, mode };
    } catch {
      setStatus("诊断设置暂时无法更新，请稍后再试。", "error");
      return { ok: false, reason: "settings-failed" };
    } finally {
      busy = false;
      render();
    }
  }

  function getSafeExport() {
    const preview = aggregator?.getExportPreview();
    if (!preview?.ok) return null;
    return {
      exportData: preview.exportData,
      json: formatExportJson(preview.exportData),
    };
  }

  function openPreview(json) {
    if (!elements.dialog || !elements.dialogContent) return false;
    previousDialogFocus = documentRef.activeElement;
    elements.dialogContent.textContent = json;
    if (typeof elements.dialog.showModal === "function") {
      elements.dialog.showModal();
    } else {
      elements.dialog.setAttribute("open", "");
    }
    elements.dialogClose?.focus();
    return true;
  }

  function closePreview() {
    if (!elements.dialog) return;
    if (typeof elements.dialog.close === "function") {
      elements.dialog.close();
    } else {
      elements.dialog.removeAttribute("open");
    }
    if (previousDialogFocus?.isConnected) previousDialogFocus.focus();
    previousDialogFocus = null;
  }

  async function prepareExport({ show = false } = {}) {
    if (disposed || busy) return null;
    busy = true;
    render();
    try {
      if (!await refreshIdentityForAction()) return null;
      if (!await loadSnapshotForIdentity({ resetMessage: false })) return null;
      if (!snapshotHasData()) {
        setStatus("暂无本地诊断数据。");
        return null;
      }
      const safeExport = getSafeExport();
      if (!safeExport) {
        setStatus("暂时无法生成匿名摘要，请稍后再试。", "error");
        return null;
      }
      if (show) openPreview(safeExport.json);
      return safeExport;
    } catch {
      setStatus("暂时无法读取匿名摘要，请稍后再试。", "error");
      return null;
    } finally {
      busy = false;
      render();
    }
  }

  async function viewExport() {
    const safeExport = await prepareExport({ show: true });
    return safeExport
      ? { ok: true, json: safeExport.json }
      : { ok: false, reason: "preview-unavailable" };
  }

  async function copyExport() {
    const safeExport = await prepareExport();
    if (!safeExport) return { ok: false, reason: "preview-unavailable" };
    try {
      if (typeof clipboard?.writeText !== "function") {
        throw new Error("clipboard unavailable");
      }
      await clipboard.writeText(safeExport.json);
      setStatus("匿名诊断摘要已复制。", "success");
      return { ok: true, json: safeExport.json };
    } catch {
      setStatus("复制失败，请检查浏览器权限后再试。", "error");
      return { ok: false, reason: "clipboard-failed" };
    }
  }

  async function exportJson() {
    const safeExport = await prepareExport();
    if (!safeExport) return { ok: false, reason: "preview-unavailable" };
    if (!confirmImpl(EXPORT_CONFIRMATION)) {
      return { ok: false, reason: "cancelled" };
    }
    try {
      const downloaded = downloadJson({
        documentRef,
        windowRef,
        filename: EXPORT_FILENAME,
        json: safeExport.json,
      });
      if (!downloaded) throw new Error("download unavailable");
      setStatus("匿名诊断 JSON 已导出。", "success");
      return {
        ok: true,
        filename: EXPORT_FILENAME,
        json: safeExport.json,
      };
    } catch {
      setStatus("导出失败，请稍后再试。", "error");
      return { ok: false, reason: "download-failed" };
    }
  }

  async function clearDiagnostics() {
    if (disposed || busy) return { ok: false, reason: "unavailable" };
    if (!confirmImpl(CLEAR_CONFIRMATION)) {
      return { ok: false, reason: "cancelled" };
    }

    busy = true;
    render();
    try {
      if (!await refreshIdentityForAction()) {
        return { ok: false, reason: "invalid-or-changed-identity" };
      }

      const boundary = deviceBoundaryExists();
      if (boundary === null) {
        setStatus("当前浏览器无法访问本地诊断数据。", "error");
        return { ok: false, reason: "storage-unavailable" };
      }
      if (boundary) {
        const cleared = await diagnosticsStorage.clearSnapshot(identity);
        if (!cleared.ok) {
          setStatus("暂时无法清除本地诊断数据，请稍后再试。", "error");
          return { ok: false, reason: cleared.reason };
        }
      }

      if (!aggregator) replaceAggregator(mode, null);
      aggregator.clear();
      snapshotLoaded = true;
      storedSnapshotExists = false;
      syncChannel?.notify?.("snapshot-cleared");
      setStatus(
        "当前账号的本地诊断数据已清除，其他数据没有受到影响。",
        "success",
      );
      return { ok: true };
    } catch {
      setStatus("暂时无法清除本地诊断数据，请稍后再试。", "error");
      return { ok: false, reason: "clear-failed" };
    } finally {
      busy = false;
      render();
    }
  }

  async function handleSectionToggle() {
    if (elements.summary) {
      elements.summary.setAttribute(
        "aria-expanded",
        String(Boolean(elements.section?.open)),
      );
    }
    if (
      elements.section?.open &&
      hasValidIdentity() &&
      mode === "off" &&
      !snapshotLoaded
    ) {
      busy = true;
      render();
      try {
        await loadSnapshotForIdentity();
      } catch {
        setStatus("暂时无法读取本地诊断数据，请稍后再试。", "error");
      } finally {
        busy = false;
        render();
      }
    }
  }

  async function handleIdentityStorageChange(event) {
    if (event.key !== "token") return;
    ++lifecycleVersion;
    clearInMemoryState({ clearIdentity: true });
    busy = false;
    setStatus("");
    render();
    await initialize().catch(() => {});
  }

  async function handleDiagnosticsSync(type) {
    if (disposed || busy || !hasValidIdentity()) {
      snapshotLoaded = false;
      return;
    }
    try {
      if (type === "snapshot-updated") {
        await loadSnapshotForIdentity({ resetMessage: false });
      } else {
        await loadIdentityState(identity);
      }
    } catch {
      snapshotLoaded = false;
    }
  }

  function bindEvents() {
    elements.section?.addEventListener("toggle", handleSectionToggle);
    elements.toggle?.addEventListener("change", event => {
      setParticipation(Boolean(event.currentTarget.checked));
    });
    elements.viewButton?.addEventListener("click", viewExport);
    elements.copyButton?.addEventListener("click", copyExport);
    elements.exportButton?.addEventListener("click", exportJson);
    elements.clearButton?.addEventListener("click", clearDiagnostics);
    elements.dialogClose?.addEventListener("click", closePreview);
    elements.dialog?.addEventListener("close", () => {
      if (previousDialogFocus?.isConnected) previousDialogFocus.focus();
      previousDialogFocus = null;
    });
    windowRef?.addEventListener("storage", handleIdentityStorageChange);
    windowRef?.addEventListener("pagehide", dispose, { once: true });
  }

  function dispose() {
    if (disposed) return { ok: false, reason: "disposed" };
    disposed = true;
    ++lifecycleVersion;
    clearInMemoryState({ clearIdentity: true });
    windowRef?.removeEventListener("storage", handleIdentityStorageChange);
    unsubscribeSync?.();
    syncChannel?.dispose?.();
    render();
    return { ok: true };
  }

  bindEvents();
  const unsubscribeSync = syncChannel?.subscribe?.(handleDiagnosticsSync);
  replaceAggregator("off", null);
  render();

  return Object.freeze({
    initialize,
    setParticipation,
    viewExport,
    copyExport,
    exportJson,
    clearDiagnostics,
    closePreview,
    dispose,
    getState() {
      return Object.freeze({
        mode,
        identityValid: hasValidIdentity(),
        snapshotLoaded,
        hasData: snapshotHasData(),
        storedSnapshotExists,
        disposed,
      });
    },
  });
}

export function initializeSunlandBetaDiagnostics(options = {}) {
  try {
    const controller = createSunlandBetaDiagnosticsController(options);
    controller.initialize().catch(() => {});
    return controller;
  } catch {
    const status = globalThis.document?.getElementById(
      "betaDiagnosticsStatus",
    );
    if (status) {
      status.textContent = "本地诊断设置暂时不可用，其他设置不受影响。";
      status.className = "beta-diagnostics-status error";
    }
    return null;
  }
}

if (typeof document !== "undefined") {
  const start = () => {
    if (document.getElementById("betaDiagnosticsSection")) {
      initializeSunlandBetaDiagnostics();
    }
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
}
