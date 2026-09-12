export const USAGE_URL = "https://api.sunland.dev/v1/usage";

export function usageDate(now = Date.now()) {
  return new Date(now + 8 * 3600000).toISOString().slice(0, 10);
}

// Refresh quota independently of the slower login/history restoration path.
export function watchUsage(refresh, target = window) {
  let midnightTimer;
  const run = () => {
    if (target.document.visibilityState === "visible") void refresh();
  };
  const scheduleMidnight = () => {
    clearTimeout(midnightTimer);
    const now = Date.now();
    const delay = 86400000 - ((now + 8 * 3600000) % 86400000);
    midnightTimer = setTimeout(() => { run(); scheduleMidnight(); }, delay + 50);
  };
  target.addEventListener("focus", run);
  target.addEventListener("pageshow", run);
  target.document.addEventListener("visibilitychange", run);
  const interval = setInterval(run, 30000);
  scheduleMidnight();
  return () => {
    clearTimeout(midnightTimer);
    clearInterval(interval);
    target.removeEventListener("focus", run);
    target.removeEventListener("pageshow", run);
    target.document.removeEventListener("visibilitychange", run);
  };
}

export function parseRemaining(value) {
  if (typeof value !== "string" || !/^(?:-1|\d+)$/.test(value)) return null;
  const remain = Number(value);
  return Number.isSafeInteger(remain) && remain >= -1 && remain <= 20 ? remain : null;
}

export async function readUsage(sendRequest, userId) {
  const response = await sendRequest(USAGE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  if (!response?.ok) throw new Error("usage-unavailable");
  const usage = await response.json();
  if (usage.userId !== userId || usage.date !== usageDate() || typeof usage.isPro !== "boolean" ||
      !Number.isInteger(usage.remain) || parseRemaining(String(usage.remain)) === null ||
      usage.isPro !== (usage.remain === -1)) {
    throw new Error("invalid-usage");
  }
  return usage;
}
