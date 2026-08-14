(function installSunlandLoginBanStatus(global) {
  "use strict";

  const SUPABASE_URL = "https://klyrasrqgxijwrxuoevj.supabase.co";
  const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_4ZIHfHr8wI0QFusEf_m7wA_pthBhxsI";

  function normalizeReason(value) {
    return typeof value === "string"
      ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 500)
      : "";
  }

  async function check({ appToken, userId, fetchImpl = global.fetch, tokenClient = global.SunlandDatabaseToken } = {}) {
    const expectedUserId = String(userId || "").trim();
    if (!appToken || !expectedUserId || typeof fetchImpl !== "function" || typeof tokenClient?.exchange !== "function") {
      throw new Error("account-status-unavailable");
    }

    const databaseToken = await tokenClient.exchange(appToken, expectedUserId);
    const url = new URL("/rest/v1/user_profiles", SUPABASE_URL);
    url.searchParams.set("select", "is_banned,ban_reason");
    url.searchParams.set("user_id", `eq.${expectedUserId}`);
    url.searchParams.set("limit", "1");

    const response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: {
        accept: "application/json",
        apikey: SUPABASE_PUBLISHABLE_KEY,
        authorization: `Bearer ${databaseToken}`,
      },
    });
    if (!response.ok) throw new Error("account-status-unavailable");

    const rows = await response.json().catch(() => null);
    if (!Array.isArray(rows)) throw new Error("account-status-unavailable");
    const profile = rows[0];
    return Object.freeze({
      isBanned: profile?.is_banned === true,
      reason: normalizeReason(profile?.ban_reason),
    });
  }

  global.SunlandLoginBanStatus = Object.freeze({ check });
})(globalThis);
