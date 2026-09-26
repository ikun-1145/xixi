const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9@._+-]{0,127}$/;
const IDENTITY_URL = "https://api.sunland.dev/v1/account/identity";

export function appTokenFromRequest(req) {
  const authorization = req.headers.get("authorization") || "";
  const bearer = /^\s*Bearer\s+(\S+)\s*$/i.exec(authorization);
  if (bearer) return bearer[1];
  if (authorization.trim()) return "";
  return (req.headers.get("x-sunland-token") || "").trim();
}

export async function verifiedActiveUserId(req, fetchIdentity = fetch) {
  const token = appTokenFromRequest(req);
  if (!token) return { userId: null, status: 401 };

  let response;
  try {
    response = await fetchIdentity(IDENTITY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return { userId: null, status: 503 };
  }

  if (response.status === 401 || response.status === 403) {
    return { userId: null, status: response.status };
  }
  if (!response.ok) return { userId: null, status: 503 };

  const identity = await response.json().catch(() => null);
  if (identity?.identity_status !== "active" ||
      typeof identity.user_id !== "string" ||
      !USER_ID_PATTERN.test(identity.user_id)) {
    return { userId: null, status: 503 };
  }
  return { userId: identity.user_id, status: 200 };
}
