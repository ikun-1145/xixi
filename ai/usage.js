export const USAGE_URL = "https://api.sunland.dev/v1/usage";

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
  if (usage.userId !== userId || typeof usage.isPro !== "boolean" ||
      !Number.isInteger(usage.remain) || parseRemaining(String(usage.remain)) === null ||
      usage.isPro !== (usage.remain === -1)) {
    throw new Error("invalid-usage");
  }
  return usage;
}
