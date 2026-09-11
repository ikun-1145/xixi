// 账号删除 Edge Function
// 安全边界：
//   - service_role 与内部 finalize 密钥只存在于本函数环境，不进入浏览器。
//   - 身份只信任 api.sunland.dev 的可信后端结果，不信任 body/localStorage/user_id/email。
//   - OTP verify 得到的 user_id 必须与当前 JWT 验证得到的 user_id 一致。
//   - deletion_job 使用 pending -> in_progress -> completed 的原子 claim，
//     保证同一时间只有一个 execute 请求清理数据。

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  deleteAvatarObjectIfExists,
  deleteAvatarPrefixWithPages,
  encodeAvatarOwnerKey,
  extractStableUserId,
  matchesExternalOwnership,
} from "./account-delete-core.js";

const API_BASE = "https://api.sunland.dev";
const JOB_TTL_MS = 10 * 60 * 1000;
const RECOVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CONFIRMATION_TEXT = "删除我的账号";
const AVATAR_BUCKET = "avatars";
const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-sunland-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function createAdminClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Supabase service credentials are not configured");
  return createClient(url, key, { auth: { persistSession: false } });
}

function getAppToken(req: Request): string {
  const fromHeader = req.headers.get("x-sunland-token") || "";
  if (fromHeader) return fromHeader.trim();
  const auth = req.headers.get("Authorization") || "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
}

function newAttemptId(): string {
  return crypto.randomUUID();
}

async function claimOrRenew(
  admin: any,
  jobId: string,
  tokenHash: string,
  attemptId: string,
): Promise<{
  ok: boolean;
  userId: string | null;
  attemptId: string | null;
  fencingVersion: number | null;
}> {
  if (!ATTEMPT_ID_PATTERN.test(attemptId)) {
    return { ok: false, userId: null, attemptId: null, fencingVersion: null };
  }
  const { data, error } = await admin.rpc("sunland_claim_account_deletion_job", {
    p_job_id: jobId,
    p_token_hash: tokenHash,
    p_attempt_id: attemptId,
  });
  const userId = typeof data?.user_id === "string" ? data.user_id : null;
  const claimedAttemptId = typeof data?.attempt_id === "string" ? data.attempt_id : null;
  const fencingVersion = Number.isSafeInteger(data?.fencing_version)
    ? data.fencing_version
    : null;
  return {
    ok: !error && !!userId && claimedAttemptId === attemptId && fencingVersion !== null,
    userId,
    attemptId: claimedAttemptId,
    fencingVersion,
  };
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function randomDeletionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function verifyAppIdentity(appToken: string): Promise<string | null> {
  if (!appToken) return null;
  try {
    const res = await fetch(`${API_BASE}/v1/account/identity`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${appToken}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return extractStableUserId(data);
  } catch {
    return null;
  }
}

async function verifyOtp(
  email: string,
  code: string,
): Promise<{ ok: boolean; status: number; userId: string | null; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/verify-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, code }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        userId: null,
        error: typeof data?.error === "string" ? data.error : "验证码校验失败",
      };
    }
    return { ok: true, status: res.status, userId: extractStableUserId(data) };
  } catch {
    return { ok: false, status: 502, userId: null, error: "验证服务不可用" };
  }
}

async function beginExternalRevoke(
  userId: string,
  jobId: string,
  attemptId: string,
  fencingVersion: number,
): Promise<{ ok: boolean; status: number; userId: string | null }> {
  const internalToken = Deno.env.get("SUNLAND_ACCOUNT_DELETE_INTERNAL_TOKEN") || "";
  if (!internalToken) return { ok: false, status: 503, userId: null };
  try {
    const res = await fetch(`${API_BASE}/v1/account-delete/begin`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-token": internalToken,
      },
      body: JSON.stringify({
        deletion_job_id: jobId,
        user_id: userId,
        attempt_id: attemptId,
        fencing_version: fencingVersion,
      }),
    });
    const data = await res.json().catch(() => null);
    const responseUserId = extractStableUserId(data);
    const responseJobId = typeof data?.deletion_job_id === "string" ? data.deletion_job_id : "";
    const ownershipMatches = matchesExternalOwnership({
      data,
      jobId,
      userId,
      attemptId,
      fencingVersion,
    });
    const alreadyRevoked = res.status === 409 && data?.code === "already_revoked";
    if ((res.ok || alreadyRevoked) && ownershipMatches) {
      return { ok: true, status: res.status, userId: responseUserId ?? userId };
    }
    return { ok: false, status: res.status, userId: responseUserId };
  } catch {
    return { ok: false, status: 502, userId: null };
  }
}

async function finalizeExternalDeletion(
  userId: string,
  jobId: string,
  attemptId: string,
  fencingVersion: number,
): Promise<{ ok: boolean; status: number; userId: string | null }> {
  const internalToken = Deno.env.get("SUNLAND_ACCOUNT_DELETE_INTERNAL_TOKEN") || "";
  if (!internalToken) return { ok: false, status: 503, userId: null };
  try {
    const res = await fetch(`${API_BASE}/v1/account-delete/finalize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-token": internalToken,
      },
      body: JSON.stringify({
        deletion_job_id: jobId,
        user_id: userId,
        attempt_id: attemptId,
        fencing_version: fencingVersion,
      }),
    });
    const data = await res.json().catch(() => null);
    const responseUserId = extractStableUserId(data);
    const responseJobId = typeof data?.deletion_job_id === "string" ? data.deletion_job_id : "";
    const ownershipMatches = matchesExternalOwnership({
      data,
      jobId,
      userId,
      attemptId,
      fencingVersion,
    });
    return {
      ok: res.ok && ownershipMatches,
      status: res.status,
      userId: responseUserId ?? userId,
    };
  } catch {
    return { ok: false, status: 502, userId: null };
  }
}

async function deleteAvatars(
  admin: any,
  userId: string,
  legacyAvatarPath: string | null,
  renewLease: () => Promise<boolean>,
): Promise<Error | null> {
  const ownerKey = encodeAvatarOwnerKey(userId);
  try {
    const prefixError = await deleteAvatarPrefixWithPages({
      list: (prefix: string, options: Record<string, unknown>) =>
        admin.storage.from(AVATAR_BUCKET).list(prefix, options),
      remove: (paths: string[]) => admin.storage.from(AVATAR_BUCKET).remove(paths),
      prefix: ownerKey,
      renewLease,
    });
    if (prefixError) return prefixError;
    if (!legacyAvatarPath) return null;
    return await deleteAvatarObjectIfExists({
      remove: (paths: string[]) => admin.storage.from(AVATAR_BUCKET).remove(paths),
      path: legacyAvatarPath,
      renewLease,
    });
  } catch (error) {
    return error instanceof Error ? error : new Error("avatar cleanup failed");
  }
}

async function handleAuthorize(req: Request): Promise<Response> {
  const appToken = getAppToken(req);
  if (!appToken) return json({ error: "请先登录后再操作", code: "unauthorized" }, 401);

  let payload: Record<string, any> = {};
  try {
    payload = await req.json();
  } catch {
    payload = {};
  }

  const email = String(payload.email || "").trim();
  const code = String(payload.code || "").trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) return json({ error: "邮箱格式错误" }, 400);
  if (!/^\d{6}$/.test(code)) return json({ error: "验证码格式错误" }, 400);

  const currentUserId = await verifyAppIdentity(appToken);
  if (!currentUserId) {
    return json({ error: "当前身份校验失败，请重新登录", code: "identity_unavailable" }, 401);
  }

  const verify = await verifyOtp(email, code);
  if (!verify.ok) {
    const status = verify.status === 429 ? 429 : verify.status >= 500 ? 502 : 401;
    return json({ error: verify.error || "验证码错误或已过期", code: "otp_invalid" }, status);
  }
  if (!verify.userId || verify.userId !== currentUserId) {
    return json({ error: "验证身份与当前账号不一致", code: "identity_mismatch" }, 403);
  }

  const deletionToken = randomDeletionToken();
  const tokenHash = await sha256Hex(deletionToken);
  const expiresAt = new Date(Date.now() + JOB_TTL_MS).toISOString();

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("account_deletion_jobs")
    .insert({
      user_id: currentUserId,
      token_hash: tokenHash,
      expires_at: expiresAt,
    })
    .select("id")
    .single();

  if (error || !data?.id) {
    return json({ error: "删除授权创建失败", code: "job_creation_failed" }, 500);
  }

  return json({
    ok: true,
    deletion_job_id: data.id,
    deletion_token: deletionToken,
    expires_in: Math.floor(JOB_TTL_MS / 1000),
  });
}

async function handleExecute(req: Request): Promise<Response> {
  let payload: Record<string, any> = {};
  try {
    payload = await req.json();
  } catch {
    payload = {};
  }

  const jobId = String(payload.deletion_job_id || "").trim();
  const deletionToken = String(payload.deletion_token || "").trim();
  const confirmation = String(payload.confirmation || "");

  if (!jobId || !deletionToken) return json({ error: "删除授权缺失", code: "invalid_request" }, 400);
  if (confirmation !== CONFIRMATION_TEXT) return json({ error: "请先完成最终确认", code: "confirmation_required" }, 400);

  const tokenHash = await sha256Hex(deletionToken);
  const admin = createAdminClient();
  const { data: job } = await admin
    .from("account_deletion_jobs")
    .select("id, user_id, status, token_hash")
    .eq("id", jobId)
    .maybeSingle();

  if (!job) return json({ error: "删除授权不存在或已过期", code: "job_not_found" }, 404);
  if (job.token_hash !== tokenHash) {
    return json({ error: "删除授权已失效或已被使用", code: "claim_conflict" }, 409);
  }
  if (job.status === "completed") {
    return json({ ok: true, already_completed: true, user_id: job.user_id });
  }

  if (job.status === "pending") {
    const appToken = getAppToken(req);
    const verifiedUserId = await verifyAppIdentity(appToken);
    if (!verifiedUserId) {
      return json({ error: "当前身份校验失败，请重新登录", code: "identity_unavailable" }, 401);
    }
    if (verifiedUserId !== job.user_id) {
      return json({ error: "验证身份与删除授权不一致", code: "identity_mismatch" }, 403);
    }
  }

  const attemptId = newAttemptId();
  const claim = await claimOrRenew(admin, jobId, tokenHash, attemptId);
  if (
    !claim.ok ||
    !claim.userId ||
    claim.userId !== job.user_id ||
    claim.attemptId !== attemptId ||
    claim.fencingVersion === null
  ) {
    return json({ error: "删除授权已失效、已被使用或正在处理中", code: "claim_conflict" }, 409);
  }
  const userId = claim.userId;
  const fencingVersion = claim.fencingVersion as number;

  const renewLease = async (): Promise<boolean> => {
    const renewed = await claimOrRenew(admin, jobId, tokenHash, attemptId);
    return (
      renewed.ok &&
      renewed.userId === userId &&
      renewed.attemptId === attemptId &&
      renewed.fencingVersion === fencingVersion
    );
  };

  const { data: currentJob } = await admin
    .from("account_deletion_jobs")
    .select("external_revoked_at, data_deleted_at, identity_retired_at, profile_sanitized_at, legacy_avatar_path")
    .eq("id", jobId)
    .eq("attempt_id", attemptId)
    .eq("fencing_version", fencingVersion)
    .maybeSingle();

  if (!currentJob) return json({ error: "执行租约已失效", code: "lease_lost" }, 409);

  if (!currentJob.external_revoked_at) {
    if (!(await renewLease())) return json({ error: "执行租约已失效", code: "lease_lost" }, 409);
    const begin = await beginExternalRevoke(userId, jobId, attemptId, fencingVersion);
    if (!begin.ok) {
      return json({ error: "身份吊销失败", code: "begin_failed", status: begin.status }, 502);
    }
    if (begin.userId && begin.userId !== userId) {
      return json({ error: "吊销身份与删除授权不一致", code: "identity_mismatch" }, 403);
    }

    const { error: revokedError } = await admin
      .from("account_deletion_jobs")
      .update({
        external_revoked_at: new Date().toISOString(),
        recovery_expires_at: new Date(Date.now() + RECOVERY_TTL_MS).toISOString(),
      })
      .eq("id", jobId)
      .eq("attempt_id", attemptId)
      .eq("fencing_version", fencingVersion)
      .is("external_revoked_at", null);
    if (revokedError) return json({ error: "删除进度保存失败", code: "milestone_update_failed" }, 500);
  }

  if (!currentJob.data_deleted_at) {
    let legacyAvatarPath =
      typeof currentJob.legacy_avatar_path === "string" && currentJob.legacy_avatar_path
        ? currentJob.legacy_avatar_path
        : null;

    if (!legacyAvatarPath) {
      if (!(await renewLease())) return json({ error: "执行租约已失效", code: "lease_lost" }, 409);
      const { data: profile } = await admin
        .from("user_profiles")
        .select("avatar_path")
        .eq("user_id", userId)
        .maybeSingle();
      legacyAvatarPath =
        typeof profile?.avatar_path === "string" && profile.avatar_path
          ? profile.avatar_path
          : null;

      const { error: legacySaveError } = await admin
        .from("account_deletion_jobs")
        .update({ legacy_avatar_path: legacyAvatarPath })
        .eq("id", jobId)
        .eq("attempt_id", attemptId)
        .eq("fencing_version", fencingVersion)
        .is("legacy_avatar_path", null);
      if (legacySaveError) return json({ error: "删除进度保存失败", code: "milestone_update_failed" }, 500);
    }

    if (!(await renewLease())) return json({ error: "执行租约已失效", code: "lease_lost" }, 409);
    const { error: deleteError } = await admin.rpc("sunland_delete_account_business_data", {
      p_user_id: userId,
    });
    if (deleteError) return json({ error: "账号数据清理失败", code: "data_deletion_failed" }, 500);

    const avatarError = await deleteAvatars(admin, userId, legacyAvatarPath, renewLease);
    if (avatarError) return json({ error: "头像资源清理失败", code: "storage_cleanup_failed" }, 500);

    const { error: dataDeletedError } = await admin
      .from("account_deletion_jobs")
      .update({ data_deleted_at: new Date().toISOString() })
      .eq("id", jobId)
      .eq("attempt_id", attemptId)
      .eq("fencing_version", fencingVersion)
      .is("data_deleted_at", null);
    if (dataDeletedError) return json({ error: "删除进度保存失败", code: "milestone_update_failed" }, 500);
  }

  if (!currentJob.identity_retired_at) {
    if (!(await renewLease())) return json({ error: "执行租约已失效", code: "lease_lost" }, 409);
    const finalize = await finalizeExternalDeletion(userId, jobId, attemptId, fencingVersion);
    if (!finalize.ok) {
      return json({ error: "账号注销完成失败", code: "finalize_failed", status: finalize.status }, 502);
    }
    if (finalize.userId && finalize.userId !== userId) {
      return json({ error: "注销身份与删除授权不一致", code: "identity_mismatch" }, 403);
    }

    const { error: retiredError } = await admin
      .from("account_deletion_jobs")
      .update({ identity_retired_at: new Date().toISOString() })
      .eq("id", jobId)
      .eq("attempt_id", attemptId)
      .eq("fencing_version", fencingVersion)
      .is("identity_retired_at", null);
    if (retiredError) return json({ error: "删除进度保存失败", code: "milestone_update_failed" }, 500);
  }

  if (!currentJob.profile_sanitized_at) {
    if (!(await renewLease())) return json({ error: "执行租约已失效", code: "lease_lost" }, 409);
    const { data: sanitizeData, error: sanitizeError } = await admin.rpc(
      "sunland_account_delete_sanitize_profile",
      {
        p_user_id: userId,
        p_deletion_job_id: jobId,
        p_attempt_id: attemptId,
        p_fencing_version: fencingVersion,
      },
    );
    const sanitizeCode = sanitizeData?.code;
    if (sanitizeError || (sanitizeCode !== "sanitized" && sanitizeCode !== "already_sanitized")) {
      return json({ error: "退役账号匿名化失败", code: "profile_sanitize_failed" }, 500);
    }

    const { error: sanitizedError } = await admin
      .from("account_deletion_jobs")
      .update({ profile_sanitized_at: new Date().toISOString() })
      .eq("id", jobId)
      .eq("attempt_id", attemptId)
      .eq("fencing_version", fencingVersion)
      .is("profile_sanitized_at", null);
    if (sanitizedError) return json({ error: "删除进度保存失败", code: "milestone_update_failed" }, 500);
  }

  const { error: completeError } = await admin
    .from("account_deletion_jobs")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("attempt_id", attemptId)
    .eq("fencing_version", fencingVersion);
  if (completeError) return json({ error: "删除完成状态保存失败", code: "completion_update_failed" }, 500);

  return json({ ok: true, user_id: userId });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let action = "";
  try {
    const body = await req.clone().json();
    action = String(body?.action || "");
  } catch {
    action = "";
  }

  if (action === "authorize") return handleAuthorize(req);
  if (action === "execute") return handleExecute(req);
  return json({ error: "未知操作", code: "unknown_action" }, 400);
});
