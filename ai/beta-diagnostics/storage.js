import { getVerifiedUserId, isVerifiedIdentity } from "../verified-identity.js";
import {
  sanitizeDiagnosticsSnapshot,
  validateDiagnosticsSnapshot,
} from "./schema.js";

export const DEVICE_SECRET_STORAGE_KEY =
  "sunland_beta_diag_device_secret_v1";
export const MAX_DIAGNOSTICS_STORAGE_BYTES = 16 * 1024;

const SNAPSHOT_KEY_PREFIX = "sunland_beta_diag_v1::";
const MODE_KEY_PREFIX = "sunland_beta_diag_mode_v1::";
const REVISION_KEY_PREFIX = "sunland_beta_diag_revision_v1::";
const DEVICE_SECRET_BYTES = 32;
const VALID_DEVICE_SECRET = /^[0-9a-f]{64}$/u;
const MODES = new Set(["off", "local"]);
const MAX_REVISION = Number.MAX_SAFE_INTEGER;

export function isBetaDiagnosticsRevisionKey(key) {
  return typeof key === "string" && key.startsWith(REVISION_KEY_PREFIX);
}

function result(ok, details = {}) {
  return Object.freeze({ ok, ...details });
}

function bytesToHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value) {
  if (!VALID_DEVICE_SECRET.test(value)) return null;
  const bytes = new Uint8Array(DEVICE_SECRET_BYTES);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function validIdentityUserId(identity) {
  if (!isVerifiedIdentity(identity)) return null;
  return getVerifiedUserId(identity);
}

export function createBetaDiagnosticsStorage({
  storage,
  cryptoImpl,
  maxBytes = MAX_DIAGNOSTICS_STORAGE_BYTES,
} = {}) {
  let storageBoundary = storage ?? null;
  let cryptoBoundary = cryptoImpl ?? null;
  try {
    storageBoundary ??= globalThis.localStorage ?? null;
  } catch {
    storageBoundary = null;
  }
  try {
    cryptoBoundary ??= globalThis.crypto ?? null;
  } catch {
    cryptoBoundary = null;
  }
  const effectiveMaxBytes =
    Number.isSafeInteger(maxBytes) && maxBytes > 0
      ? Math.min(maxBytes, MAX_DIAGNOSTICS_STORAGE_BYTES)
      : MAX_DIAGNOSTICS_STORAGE_BYTES;

  async function deriveBoundary(identity) {
    const userId = validIdentityUserId(identity);
    if (!userId) return result(false, { reason: "invalid-identity" });
    if (
      !storageBoundary ||
      typeof storageBoundary.getItem !== "function" ||
      typeof storageBoundary.setItem !== "function" ||
      typeof storageBoundary.removeItem !== "function" ||
      !cryptoBoundary?.subtle ||
      typeof cryptoBoundary.getRandomValues !== "function"
    ) {
      return result(false, { reason: "storage-unavailable" });
    }

    try {
      let secretHex = storageBoundary.getItem(DEVICE_SECRET_STORAGE_KEY);
      if (secretHex === null) {
        const generated = new Uint8Array(DEVICE_SECRET_BYTES);
        cryptoBoundary.getRandomValues(generated);
        secretHex = bytesToHex(generated);
        storageBoundary.setItem(DEVICE_SECRET_STORAGE_KEY, secretHex);
      }
      const secret = hexToBytes(secretHex);
      if (secret === null) {
        return result(false, { reason: "invalid-device-secret" });
      }

      const key = await cryptoBoundary.subtle.importKey(
        "raw",
        secret,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const signature = await cryptoBoundary.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(userId),
      );
      const opaqueNamespace = bytesToHex(new Uint8Array(signature));
      return result(true, {
        snapshotKey: `${SNAPSHOT_KEY_PREFIX}${opaqueNamespace}`,
        modeKey: `${MODE_KEY_PREFIX}${opaqueNamespace}`,
        revisionKey: `${REVISION_KEY_PREFIX}${opaqueNamespace}`,
      });
    } catch {
      return result(false, { reason: "storage-failed" });
    }
  }

  async function loadSnapshot(identity) {
    const boundary = await deriveBoundary(identity);
    if (!boundary.ok) return boundary;
    try {
      const serialized = storageBoundary.getItem(boundary.snapshotKey);
      if (serialized === null) {
        return result(true, { snapshot: null });
      }
      if (
        new TextEncoder().encode(serialized).byteLength >
        effectiveMaxBytes
      ) {
        incrementRevision(boundary.revisionKey);
        storageBoundary.removeItem(boundary.snapshotKey);
        return result(true, {
          reason: "snapshot-too-large",
          snapshot: null,
          discarded: true,
        });
      }
      const parsed = JSON.parse(serialized);
      const snapshot = sanitizeDiagnosticsSnapshot(parsed);
      if (snapshot === null) {
        incrementRevision(boundary.revisionKey);
        storageBoundary.removeItem(boundary.snapshotKey);
        return result(true, {
          reason: "invalid-snapshot",
          snapshot: null,
          discarded: true,
        });
      }
      return result(true, { snapshot });
    } catch {
      try {
        incrementRevision(boundary.revisionKey);
        storageBoundary.removeItem(boundary.snapshotKey);
        return result(true, {
          reason: "invalid-snapshot",
          snapshot: null,
          discarded: true,
        });
      } catch {
        return result(false, { reason: "storage-failed" });
      }
    }
  }

  function readRevision(revisionKey) {
    const stored = storageBoundary.getItem(revisionKey);
    if (stored === null) return 0;
    const parsed = Number(stored);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  }

  function incrementRevision(revisionKey) {
    const current = readRevision(revisionKey);
    const next = current >= MAX_REVISION ? 1 : current + 1;
    storageBoundary.setItem(revisionKey, String(next));
    return next;
  }

  async function loadRevision(identity) {
    const boundary = await deriveBoundary(identity);
    if (!boundary.ok) return boundary;
    try {
      return result(true, {
        revision: readRevision(boundary.revisionKey),
      });
    } catch {
      return result(false, { reason: "storage-failed" });
    }
  }

  async function saveSnapshot(identity, snapshot, options = {}) {
    const userId = validIdentityUserId(identity);
    if (!userId) return result(false, { reason: "invalid-identity" });
    const expectedRevision = options?.expectedRevision;
    if (
      expectedRevision !== undefined &&
      (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    ) {
      return result(false, { reason: "invalid-revision" });
    }
    if (!validateDiagnosticsSnapshot(snapshot)) {
      return result(false, { reason: "invalid-snapshot" });
    }
    try {
      const safe = sanitizeDiagnosticsSnapshot(snapshot);
      if (safe === null) {
        return result(false, { reason: "invalid-snapshot" });
      }
      const serialized = JSON.stringify(safe);
      if (
        new TextEncoder().encode(serialized).byteLength >
        effectiveMaxBytes
      ) {
        return result(false, { reason: "snapshot-too-large" });
      }
      const boundary = await deriveBoundary(identity);
      if (!boundary.ok) return boundary;
      if (
        expectedRevision !== undefined &&
        readRevision(boundary.revisionKey) !== expectedRevision
      ) {
        return result(false, { reason: "stale-revision" });
      }
      storageBoundary.setItem(boundary.snapshotKey, serialized);
      return result(true);
    } catch {
      return result(false, { reason: "storage-failed" });
    }
  }

  async function clearSnapshot(identity) {
    const boundary = await deriveBoundary(identity);
    if (!boundary.ok) return boundary;
    try {
      incrementRevision(boundary.revisionKey);
      storageBoundary.removeItem(boundary.snapshotKey);
      return result(true);
    } catch {
      return result(false, { reason: "storage-failed" });
    }
  }

  async function hasSnapshot(identity) {
    const loaded = await loadSnapshot(identity);
    if (!loaded.ok) return loaded;
    return result(true, { hasSnapshot: loaded.snapshot !== null });
  }

  async function loadMode(identity) {
    const boundary = await deriveBoundary(identity);
    if (!boundary.ok) return boundary;
    try {
      const stored = storageBoundary.getItem(boundary.modeKey);
      return result(true, {
        mode: stored === "local" ? "local" : "off",
      });
    } catch {
      return result(false, { reason: "storage-failed" });
    }
  }

  async function saveMode(identity, mode) {
    const userId = validIdentityUserId(identity);
    if (!userId) return result(false, { reason: "invalid-identity" });
    if (!MODES.has(mode)) {
      return result(false, { reason: "invalid-mode" });
    }
    const boundary = await deriveBoundary(identity);
    if (!boundary.ok) return boundary;
    try {
      incrementRevision(boundary.revisionKey);
      if (mode === "local") {
        storageBoundary.setItem(boundary.modeKey, "local");
      } else {
        storageBoundary.removeItem(boundary.modeKey);
      }
      return result(true, { mode });
    } catch {
      return result(false, { reason: "storage-failed" });
    }
  }

  async function clearMode(identity) {
    const boundary = await deriveBoundary(identity);
    if (!boundary.ok) return boundary;
    try {
      incrementRevision(boundary.revisionKey);
      storageBoundary.removeItem(boundary.modeKey);
      return result(true);
    } catch {
      return result(false, { reason: "storage-failed" });
    }
  }

  return Object.freeze({
    loadSnapshot,
    saveSnapshot,
    clearSnapshot,
    hasSnapshot,
    loadRevision,
    loadMode,
    saveMode,
    clearMode,
  });
}
