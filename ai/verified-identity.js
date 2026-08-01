import { normalizeUserId } from "./user-identity.js";

export const IDENTITY_LOGIN_STATE_MESSAGE =
  "登录状态好像出了点问题，请重新登录后再试一下。";

const DEFAULT_REFRESH_ENDPOINT = "https://api.sunland.dev/refresh";
const DEFAULT_VERIFICATION_MAX_AGE_MS = 15 * 60 * 1000;
const verifiedIdentities = new WeakMap();

function decodeJwtPayload(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 3 || !parts[1]) return null;
    let encoded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (encoded.length % 4) encoded += "=";
    return JSON.parse(atob(encoded));
  } catch {
    return null;
  }
}

function extractIdentityValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return normalizeUserId(
    value.sub ??
    value.id ??
    value.user_id ??
    value.userId ??
    value.uid ??
    value.email ??
    value.user_email ??
    value.mail ??
    null,
  );
}

function selectDisplayValue(...values) {
  return values.find(value => typeof value === "string" && value.trim())?.trim() || "";
}

function buildDisplayUser({ userId, serverUser, tokenPayload, cachedUser }) {
  const cachedIdentity = extractIdentityValue(cachedUser);
  const safeCache = cachedIdentity === userId ? cachedUser : null;
  const server = serverUser && typeof serverUser === "object" && !Array.isArray(serverUser)
    ? serverUser
    : {};
  const payload = tokenPayload && typeof tokenPayload === "object" ? tokenPayload : {};

  return Object.freeze({
    email: selectDisplayValue(
      server.email,
      server.user_email,
      server.mail,
      payload.email,
      payload.user_email,
      payload.mail,
      safeCache?.email,
      safeCache?.user_email,
      safeCache?.mail,
      userId.includes("@") ? userId : "",
    ) || "未知用户",
    nickname: selectDisplayValue(server.nickname, server.name, safeCache?.nickname, safeCache?.name),
    avatar_url: selectDisplayValue(
      server.avatar_url,
      server.picture,
      server.user_metadata?.avatar_url,
      payload.picture,
      safeCache?.avatar_url,
      safeCache?.picture,
    ),
    avatar_path: selectDisplayValue(server.avatar_path, safeCache?.avatar_path),
  });
}

function createVerifiedIdentity({ userId, token, user, expiresAt, verifiedAt }) {
  const identity = Object.freeze({
    userId,
    token,
    user,
    expiresAt,
    verifiedAt,
    source: "server-refresh",
  });
  verifiedIdentities.set(identity, { active: true });
  return identity;
}

export function isVerifiedIdentity(identity) {
  return !!identity &&
    typeof identity === "object" &&
    verifiedIdentities.get(identity)?.active === true;
}

export function getVerifiedUserId(identity) {
  return isVerifiedIdentity(identity) ? identity.userId : null;
}

export function getVerifiedToken(identity) {
  return isVerifiedIdentity(identity) ? identity.token : null;
}

export class IdentityAuthority {
  constructor({
    fetchImpl = (...args) => fetch(...args),
    refreshEndpoint = DEFAULT_REFRESH_ENDPOINT,
    now = () => Date.now(),
    verificationMaxAgeMs = DEFAULT_VERIFICATION_MAX_AGE_MS,
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.refreshEndpoint = refreshEndpoint;
    this.now = now;
    this.verificationMaxAgeMs = verificationMaxAgeMs;
    this._current = null;
    this._pending = null;
    this._pendingToken = null;
    this._generation = 0;
  }

  current() {
    const identity = this._current;
    if (!isVerifiedIdentity(identity)) return null;
    const now = this.now();
    if (
      (identity.expiresAt != null && identity.expiresAt <= now + 5000) ||
      now - identity.verifiedAt > this.verificationMaxAgeMs
    ) {
      this.clear();
      return null;
    }
    return identity;
  }

  clear() {
    this._generation += 1;
    this._deactivateCurrent();
  }

  _deactivateCurrent() {
    const state = verifiedIdentities.get(this._current);
    if (state) state.active = false;
    this._current = null;
  }

  async resolve({ token, cachedUser = null, expectedUserId = null, force = false, signal } = {}) {
    const candidateToken = typeof token === "string" ? token.trim() : "";
    const expected = expectedUserId == null ? null : normalizeUserId(expectedUserId);
    if (!candidateToken || (expectedUserId != null && !expected)) {
      this.clear();
      return { ok: false, reason: "invalid-input" };
    }

    const current = this.current();
    if (!force && current?.token === candidateToken && (!expected || current.userId === expected)) {
      return { ok: true, identity: current, reused: true };
    }
    if (current && current.token !== candidateToken) this._deactivateCurrent();

    if (this._pending && this._pendingToken === candidateToken) {
      const pendingResult = await this._pending;
      if (
        pendingResult.ok &&
        expected &&
        getVerifiedUserId(pendingResult.identity) !== expected
      ) {
        this.clear();
        return { ok: false, reason: "identity-mismatch" };
      }
      return pendingResult;
    }

    const generation = ++this._generation;
    this._pendingToken = candidateToken;
    this._pending = this._resolveFromServer({
      token: candidateToken,
      cachedUser,
      expectedUserId: expected,
      signal,
      generation,
    }).finally(() => {
      if (this._pendingToken === candidateToken) {
        this._pending = null;
        this._pendingToken = null;
      }
    });
    return this._pending;
  }

  async _resolveFromServer({ token, cachedUser, expectedUserId, signal, generation }) {
    let response;
    try {
      response = await this.fetchImpl(this.refreshEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({}),
        signal,
      });
    } catch {
      if (generation !== this._generation) return { ok: false, reason: "stale-resolution" };
      return { ok: false, reason: "verification-unavailable" };
    }

    if (!response?.ok) {
      if (generation !== this._generation) return { ok: false, reason: "stale-resolution" };
      if (
        generation === this._generation &&
        (response?.status === 401 || response?.status === 403)
      ) {
        this._deactivateCurrent();
      }
      return {
        ok: false,
        reason: response?.status === 401 || response?.status === 403
          ? "invalid-token"
          : "verification-unavailable",
        status: response?.status ?? null,
      };
    }

    const data = await response.json().catch(() => null);
    if (generation !== this._generation) {
      return { ok: false, reason: "stale-resolution" };
    }
    if (!data || typeof data !== "object") {
      return { ok: false, reason: "invalid-verification-response" };
    }

    const verifiedToken = typeof data.token === "string" && data.token.trim()
      ? data.token.trim()
      : token;
    const tokenParts = verifiedToken.split(".");
    const tokenPayload = tokenParts.length === 3 ? decodeJwtPayload(verifiedToken) : null;
    if (tokenParts.length === 3 && !tokenPayload) {
      return { ok: false, reason: "invalid-verified-token" };
    }

    const claimUserId = extractIdentityValue(tokenPayload);
    const responseUser = data.user && typeof data.user === "object" ? data.user : data;
    const responseUserId = extractIdentityValue(responseUser);
    if (claimUserId && responseUserId && claimUserId !== responseUserId) {
      this._deactivateCurrent();
      return { ok: false, reason: "identity-mismatch" };
    }

    const userId = claimUserId || responseUserId;
    if (!userId || (expectedUserId && userId !== expectedUserId)) {
      this._deactivateCurrent();
      return { ok: false, reason: expectedUserId ? "identity-mismatch" : "missing-identity" };
    }

    const expiresAt = typeof tokenPayload?.exp === "number"
      ? tokenPayload.exp * 1000
      : null;
    const verifiedAt = this.now();
    if (expiresAt != null && expiresAt <= verifiedAt + 5000) {
      this._deactivateCurrent();
      return { ok: false, reason: "expired-verified-token" };
    }

    const user = buildDisplayUser({
      userId,
      serverUser: responseUser,
      tokenPayload,
      cachedUser,
    });
    this._deactivateCurrent();
    const identity = createVerifiedIdentity({
      userId,
      token: verifiedToken,
      user,
      expiresAt,
      verifiedAt,
    });
    this._current = identity;
    return { ok: true, identity, reused: false };
  }
}
