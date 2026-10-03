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

function pathWithinNamespace(path, namespace) {
  if (typeof path !== "string" || typeof namespace !== "string" || !namespace) return false;
  let decoded = path;
  // Check every encoding layer without treating literal '%' or Unicode as invalid filenames.
  for (let depth = 0; depth < 8; depth++) {
    if (!decoded.startsWith(`${namespace}/`) || /[\\\u0000-\u001f\u007f]/u.test(decoded)
        || decoded.split("/").some(part => !part || part === "." || part === "..")) return false;
    const next = decoded.replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    if (next === decoded) return true;
    decoded = next;
  }
  return false;
}

export function avatarStorageNamespaces(userId) {
  if (typeof userId !== "string" || normalizeUserId(userId) !== userId) return [];
  const legacyUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
  return [encodeAvatarOwnerKey(userId), ...(legacyUuid.test(userId) ? [userId] : [])];
}

export function avatarPathBelongsToUser(path, userId) {
  const namespaces = avatarStorageNamespaces(userId);
  if (!namespaces.length || typeof path !== "string") return false;
  // This historical root object is allocated to one exact identity, not a filename prefix.
  if (path === `${userId}.png`) return true;
  return namespaces.some(namespace => pathWithinNamespace(path, namespace));
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

function isMissingAvatarObject(error) {
  return (error?.statusCode ?? error?.status) === 404 && error?.code === "NoSuchKey";
}

export async function deleteAvatarPrefixWithPages({
  list,
  remove,
  prefix,
  limit = 1000,
  maxPages = 250,
  renewLease = async () => true,
}) {
  const pending = [prefix];
  const visited = new Set(pending);
  let pages = 0;
  while (pending.length) {
    const directory = pending.pop();
    let offset = 0;
    const seenPages = new Set();
    while (true) {
      // Cleanup is bounded best effort: an unbounded/changing Storage listing cannot pin retirement.
      if (pages++ >= maxPages) return null;
      if (!(await renewLease())) return new Error("lease lost");

      const { data, error } = await list(directory, {
        limit,
        offset,
        sortBy: { column: "name", order: "asc" },
      });
      if (error) return error;

      if (!Array.isArray(data)) return new Error("invalid storage listing");
      if (!data.length) break;
      const signature = JSON.stringify(data.map(item => item?.name ?? null));
      // A stale page must not keep a deletion job alive forever.
      if (seenPages.has(signature)) break;
      seenPages.add(signature);
      const paths = new Set();
      let retained = 0;
      for (const item of data) {
        const path = typeof item?.name === "string" ? `${directory}/${item.name}` : null;
        if (!pathWithinNamespace(path, prefix)) {
          retained++;
          continue;
        }
        if (item.id === null && item.metadata === null) {
          if (!visited.has(path)) { visited.add(path); pending.push(path); }
          retained++;
        } else paths.add(path);
      }

      if (paths.size) {
        const { error: removeError } = await remove([...paths]);
        if (removeError && !isMissingAvatarObject(removeError)) return removeError;
      }

      // Removed files shrink the listing; skipped entries/folders stay in place.
      offset += retained;
    }
  }
  return null;
}

export async function deleteAvatarObjectIfExists({
  remove,
  path,
  userId,
  renewLease = async () => true,
}) {
  // A profile or job owns its row, not the object named in this editable field.
  // Skip unowned legacy references so account deletion can still finish safely.
  if (!avatarPathBelongsToUser(path, userId)) return null;
  if (!(await renewLease())) return new Error("lease lost");

  const { error } = await remove([path]);
  if (!error) return null;
  return isMissingAvatarObject(error) ? null : error;
}
