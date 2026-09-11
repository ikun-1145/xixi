const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9@._+-]{0,127}$/;

export function encodeAvatarOwnerKey(userId) {
  const bytes = new TextEncoder().encode(String(userId));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function normalizeUserId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return USER_ID_PATTERN.test(trimmed) ? trimmed : null;
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

export function extractStableUserId(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = data;
  const user = value.user && typeof value.user === "object" ? value.user : {};
  const token = typeof value.token === "string" ? value.token : "";
  const payload = token ? decodeJwtPayload(token) : null;

  return (
    normalizeUserId(user.id) ??
    normalizeUserId(user.user_id) ??
    normalizeUserId(user.userId) ??
    normalizeUserId(user.uid) ??
    normalizeUserId(user.sub) ??
    normalizeUserId(value.id) ??
    normalizeUserId(value.user_id) ??
    normalizeUserId(value.userId) ??
    normalizeUserId(value.uid) ??
    normalizeUserId(value.sub) ??
    normalizeUserId(payload?.id) ??
    normalizeUserId(payload?.sub) ??
    normalizeUserId(payload?.user_id) ??
    normalizeUserId(payload?.userId) ??
    normalizeUserId(payload?.uid)
  );
}

export function isAlreadyRevokedResponse({ status, data, jobId, userId }) {
  if (status !== 409 || !data || typeof data !== "object") return false;
  if (data.code !== "already_revoked") return false;
  if (typeof data.deletion_job_id !== "string" || data.deletion_job_id !== jobId) return false;
  return extractStableUserId(data) === userId;
}

export function matchesExternalOwnership({
  data,
  jobId,
  userId,
  attemptId,
  fencingVersion,
}) {
  if (!data || typeof data !== "object") return false;
  return (
    data.deletion_job_id === jobId &&
    extractStableUserId(data) === userId &&
    data.attempt_id === attemptId &&
    Number(data.fencing_version) === fencingVersion
  );
}

export async function deleteAvatarPrefixWithPages({
  list,
  remove,
  prefix,
  limit = 1000,
  renewLease = async () => true,
}) {
  let offset = 0;
  while (true) {
    if (!(await renewLease())) return new Error("lease lost");

    const { data, error } = await list(prefix, {
      limit,
      offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) {
      const code = error?.statusCode ?? error?.status ?? 0;
      return code === 400 || code === 404 ? null : error;
    }

    const entries = Array.isArray(data) ? data : [];
    const names = entries
      .filter((item) => item && typeof item.name === "string" && item.name.length > 0)
      .map((item) => `${prefix}/${item.name}`);

    if (names.length) {
      const { error: removeError } = await remove(names);
      if (removeError) return removeError;
    }

    if (entries.length < limit) return null;
    offset += entries.length;
  }
}

export async function deleteAvatarObjectIfExists({
  remove,
  path,
  renewLease = async () => true,
}) {
  if (!path) return null;
  if (!(await renewLease())) return new Error("lease lost");

  const { error } = await remove([path]);
  if (!error) return null;
  const code = error?.statusCode ?? error?.status ?? 0;
  return code === 400 || code === 404 ? null : error;
}
