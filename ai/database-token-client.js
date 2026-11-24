(function installSunlandDatabaseToken(global) {
  "use strict";

  let cached = null;
  let pending = null;
  let generation = 0;
  const TOKEN_TIMEOUT_MS = 10_000;

  function payload(token) {
    try {
      const encoded = String(token).split(".")[1];
      if (!encoded) return null;
      const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
      const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
      return JSON.parse(atob(padded));
    } catch {
      return null;
    }
  }

  function clear() {
    generation += 1;
    cached = null;
    pending = null;
  }

  async function refreshAppToken(token) {
    const response = await fetch("https://api.sunland.dev/refresh", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: "{}",
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    const next = typeof data?.token === "string" ? data.token : token;
    if (localStorage.getItem("token") !== token) return null;
    localStorage.setItem("token", next);
    return next;
  }

  async function exchangeRequest(appToken) {
    const response = await fetch("https://api.sunland.dev/v1/database-token", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${appToken}` },
      body: "{}",
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
    const data = await response.json().catch(() => null);
    return { response, data };
  }

  function validateDatabaseToken(data, userId) {
    const claims = payload(data?.token);
    if (
      typeof data?.token !== "string" || claims?.role !== "authenticated" ||
      claims?.aud !== "authenticated" || claims?.id !== userId ||
      typeof claims?.exp !== "number" || claims.exp * 1000 <= Date.now()
    ) {
      throw new Error("invalid-database-token");
    }
    return { token: data.token, userId, expiresAt: claims.exp * 1000 };
  }

  async function requestToken(appToken, retried, requestGeneration) {
    const { response, data } = await exchangeRequest(appToken);
    if (response.status === 401 && !retried) {
      if (localStorage.getItem("token") !== appToken) {
        throw new Error("database-token-identity-changed");
      }
      const refreshed = await refreshAppToken(appToken);
      if (refreshed) return requestToken(refreshed, true, requestGeneration);
    }
    if (!response.ok) throw Object.assign(new Error("database-token-unavailable"), { status: response.status });
    if (generation !== requestGeneration || localStorage.getItem("token") !== appToken) {
      throw new Error("database-token-identity-changed");
    }
    const appClaims = payload(localStorage.getItem("token"));
    const userId = appClaims?.id || appClaims?.sub;
    cached = { ...validateDatabaseToken(data, userId), appToken };
    return cached.token;
  }

  async function exchange(appToken, expectedUserId) {
    const userId = String(expectedUserId || "").trim();
    const appClaims = payload(appToken);
    const appUserId = appClaims?.id || appClaims?.sub;
    if (!appToken || !userId || (appUserId && appUserId !== userId)) {
      throw new Error("invalid-database-token");
    }
    const { response, data } = await exchangeRequest(appToken);
    if (!response.ok) throw new Error("database-token-unavailable");
    return validateDatabaseToken(data, userId).token;
  }

  async function get(expectedUserId = null) {
    const appToken = localStorage.getItem("token");
    const appClaims = payload(appToken);
    const userId = appClaims?.id || appClaims?.sub;
    if (expectedUserId && expectedUserId !== userId) throw new Error("database-token-identity-changed");
    if (!appToken || !userId) return null;
    if (cached?.userId === userId && cached.appToken === appToken &&
        cached.expiresAt > Date.now() + 60_000) return cached.token;
    if (pending?.appToken !== appToken || pending?.expectedUserId !== expectedUserId) {
      const request = requestToken(appToken, Boolean(expectedUserId), generation).finally(() => {
        if (pending?.request === request) pending = null;
      });
      pending = { appToken, expectedUserId, request };
    }
    const token = await pending.request;
    if (expectedUserId && (localStorage.getItem("token") !== appToken || payload(token)?.id !== expectedUserId)) {
      throw new Error("database-token-identity-changed");
    }
    return token;
  }

  global.addEventListener?.("storage", (event) => {
    if (event.key === "token") clear();
  });
  global.SunlandDatabaseToken = Object.freeze({ get, clear, exchange });
})(globalThis);
