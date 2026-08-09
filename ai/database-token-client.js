(function installSunlandDatabaseToken(global) {
  "use strict";

  let cached = null;
  let pending = null;
  let generation = 0;

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
    });
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    const next = typeof data?.token === "string" ? data.token : token;
    if (localStorage.getItem("token") !== token) return null;
    localStorage.setItem("token", next);
    return next;
  }

  async function requestToken(appToken, retried, requestGeneration) {
    const response = await fetch("https://api.sunland.dev/v1/database-token", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${appToken}` },
      body: "{}",
    });
    if (response.status === 401 && !retried) {
      if (localStorage.getItem("token") !== appToken) {
        throw new Error("database-token-identity-changed");
      }
      const refreshed = await refreshAppToken(appToken);
      if (refreshed) return requestToken(refreshed, true, requestGeneration);
    }
    if (!response.ok) throw new Error("database-token-unavailable");
    if (generation !== requestGeneration) {
      throw new Error("database-token-identity-changed");
    }
    const data = await response.json();
    const claims = payload(data?.token);
    const appClaims = payload(localStorage.getItem("token"));
    const userId = appClaims?.id || appClaims?.sub;
    if (
      typeof data?.token !== "string" || claims?.role !== "authenticated" ||
      claims?.aud !== "authenticated" || claims?.id !== userId ||
      typeof claims?.exp !== "number" || claims.exp * 1000 <= Date.now()
    ) {
      throw new Error("invalid-database-token");
    }
    cached = { token: data.token, userId, expiresAt: claims.exp * 1000 };
    return cached.token;
  }

  async function get() {
    const appToken = localStorage.getItem("token");
    const appClaims = payload(appToken);
    const userId = appClaims?.id || appClaims?.sub;
    if (!appToken || !userId) return null;
    if (cached?.userId === userId && cached.expiresAt > Date.now() + 60_000) return cached.token;
    if (!pending) {
      const request = requestToken(appToken, false, generation).finally(() => {
        if (pending === request) pending = null;
      });
      pending = request;
    }
    return pending;
  }

  global.addEventListener?.("storage", (event) => {
    if (event.key === "token") clear();
  });
  global.SunlandDatabaseToken = Object.freeze({ get, clear });
})(globalThis);
