const DEFAULT_AFDIAN_PLAN_ID = "4c2527fc6c7411f1bbe45254001e7c00";
const AFDIAN_QUERY_ENDPOINT = "https://ifdian.net/api/open/query-order";
const RECONCILIATION_CURSOR_KEY = "pro-reconcile:next-page";
const RECONCILIATION_FULL_SCAN_DAY_KEY = "pro-reconcile:last-full-scan-day";
const MAX_RECONCILIATION_PAGES_PER_RUN = 1;
const RETRY_DELAYS_MS = [75, 225];
const REQUEST_TIMEOUT_MS = 8_000;
// 仅兼容旧前端曾写入 remark 的 32 位用户 UUID；买家留言绝不能作为账号绑定。
const LEGACY_USER_ID_PATTERN = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

// 爱发电公开的 Webhook 验签公钥；允许通过非敏感 Worker 变量覆盖以支持官方换钥。
const DEFAULT_AFDIAN_WEBHOOK_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwwdaCg1Bt+UKZKs0R54y
lYnuANma49IpgoOwNmk3a0rhg/PQuhUJ0EOZSowIC44l0K3+fqGns3Ygi4AfmEfS
4EKbdk1ahSxu7Zkp2rHMt+R9GarQFQkwSS/5x1dYiHNVMiR8oIXDgjmvxuNes2Cr
8fw9dEF0xNBKdkKgG2qAawcN1nZrdyaKWtPVT9m2Hl0ddOO9thZmVLFOb9NVzgYf
jEgI+KWX6aY19Ka/ghv/L4t1IXmz9pctablN5S0CRWpJW3Cn0k6zSXgjVdKm4uN7
jRlgSRaf/Ind46vMCm3N2sgwxu/g3bnooW+db0iLo13zzuvyn727Q3UDQ0MmZcEW
MQIDAQAB
-----END PUBLIC KEY-----`;

const DURABLE_PAYMENT_STATUSES = new Set([
  "activated",
  "already_processed",
  "already_pro",
  "unresolved",
  "ineligible",
]);

export default {
  async scheduled(_controller, env) {
    try {
      await reconcileOrders(env);
    } catch (error) {
      logEvent({ event: "reconciliation_failed", reason: errorCode(error) });
      throw error;
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/webhook/afdian") {
      return handleAfdianWebhook(request, env);
    }

    if (url.pathname === "/admin/reconcile") {
      return handleAdminReconcile(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};

async function reconcileOrders(env) {
  const latest = await queryAfdianOrders(env, { page: 1, per_page: 100 });
  const summary = await processOrders(latest.list, env, "query-latest");
  const totalPage = latest.totalPage;
  const today = new Date().toISOString().slice(0, 10);
  const lastFullScanDay = await getReconciliationFullScanDay(env);
  const mustResumeOrStartFullScan = lastFullScanDay !== today;
  let fullScanCompletedToday = lastFullScanDay === today;

  if (totalPage > 1) {
    let nextPage = mustResumeOrStartFullScan ? 2 : await getReconciliationPage(env);
    const shouldScanHistory = mustResumeOrStartFullScan || (nextPage >= 2 && nextPage <= totalPage);

    if (shouldScanHistory) {
      for (let index = 0; index < MAX_RECONCILIATION_PAGES_PER_RUN; index += 1) {
        const pageResult = await queryAfdianOrders(env, { page: nextPage, per_page: 100 });
        const pageSummary = await processOrders(pageResult.list, env, "query-history");
        mergeSummary(summary, pageSummary);

        const effectiveTotal = Math.max(totalPage, pageResult.totalPage);
        nextPage = nextPage >= effectiveTotal ? 1 : nextPage + 1;
        await setReconciliationState(env, RECONCILIATION_CURSOR_KEY, String(nextPage));
        if (nextPage === 1) {
          await setReconciliationState(env, RECONCILIATION_FULL_SCAN_DAY_KEY, today);
          fullScanCompletedToday = true;
          break;
        }
      }
    }
  } else {
    await setReconciliationState(env, RECONCILIATION_CURSOR_KEY, "1");
    await setReconciliationState(env, RECONCILIATION_FULL_SCAN_DAY_KEY, today);
    fullScanCompletedToday = true;
  }

  logEvent({
    event: "reconciliation_complete",
    source: "scheduled",
    totalPage,
    fullScanCompletedToday,
    ...summary,
  });
}

async function handleAfdianWebhook(request, env) {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);

  const payload = await readJsonRequest(request);
  const order = payload?.data?.type === "order" ? payload.data.order : null;
  const sign = typeof payload?.sign === "string"
    ? payload.sign
    : typeof payload?.data?.sign === "string"
      ? payload.data.sign
      : "";

  if (!isOrderObject(order) || !sign) {
    return jsonResponse({ ec: 400, em: "invalid webhook payload" }, 400);
  }

  const verified = await verifyWebhookSignature(
    order,
    sign,
    env.AFDIAN_WEBHOOK_PUBLIC_KEY || DEFAULT_AFDIAN_WEBHOOK_PUBLIC_KEY,
  );
  if (!verified) {
    logEvent({ event: "webhook_signature_rejected" });
    return jsonResponse({ ec: 401, em: "invalid signature" }, 401);
  }

  if (!isPaidOrder(order)) return jsonResponse({ ec: 200, em: "" });

  try {
    const result = await processOrder(order, env, "webhook");
    if (!DURABLE_PAYMENT_STATUSES.has(result.status)) {
      throw new Error("payment outcome was not durable");
    }
    return jsonResponse({ ec: 200, em: "" });
  } catch (error) {
    logEvent({ event: "webhook_processing_failed", reason: errorCode(error) });
    return jsonResponse({ ec: 503, em: "temporary processing failure" }, 503);
  }
}

async function handleAdminReconcile(request, env) {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  if (!await hasValidAdminToken(request, env.ADMIN_TOKEN)) {
    return new Response("Not found", { status: 404 });
  }

  const body = await readJsonRequest(request);
  const orderId = normalizeOrderId(body?.out_trade_no);
  if (!orderId) return jsonResponse({ error: "out_trade_no is required" }, 400);

  try {
    const response = await queryAfdianOrders(env, { out_trade_no: orderId, per_page: 1 });
    const order = response.list.find(item => normalizeOrderId(item?.out_trade_no) === orderId);
    if (!order) return jsonResponse({ error: "order not found" }, 404);
    if (!isPaidOrder(order)) return jsonResponse({ status: "not_paid" }, 409);

    const result = await processOrder(order, env, "admin");
    return jsonResponse({ status: result.status });
  } catch (error) {
    logEvent({ event: "admin_reconciliation_failed", reason: errorCode(error) });
    return jsonResponse({ error: "temporary processing failure" }, 503);
  }
}

async function processOrders(orders, env, source) {
  const summary = {
    scanned: Array.isArray(orders) ? orders.length : 0,
    activated: 0,
    unresolved: 0,
    ineligible: 0,
    skipped: 0,
    failed: 0,
  };

  for (const order of orders) {
    if (!isPaidOrder(order)) {
      summary.skipped += 1;
      continue;
    }

    try {
      const result = await processOrder(order, env, source);
      if (result.status === "unresolved") summary.unresolved += 1;
      else if (result.status === "ineligible") summary.ineligible += 1;
      else summary.activated += 1;
    } catch (error) {
      summary.failed += 1;
      logEvent({ event: "order_processing_failed", source, reason: errorCode(error) });
    }
  }

  return summary;
}

function mergeSummary(target, source) {
  for (const key of Object.keys(target)) target[key] += source[key] || 0;
}

async function processOrder(order, env, source) {
  const orderId = normalizeOrderId(order?.out_trade_no);
  if (!orderId) throw new Error("invalid order id");
  const planId = typeof order.plan_id === "string" ? order.plan_id.trim() : "";
  if (planId !== getAfdianPlanId(env)) {
    logEvent({ event: "payment_plan_not_eligible", source });
  }

  const result = await activatePayment(env, {
    orderId,
    ...resolvePaymentBinding(order),
    planId,
    totalAmount: normalizeAmount(order.total_amount),
    paidAt: normalizePaidAt(order),
  });

  if (!DURABLE_PAYMENT_STATUSES.has(result.status)) {
    throw new Error("invalid payment RPC outcome");
  }

  logEvent({ event: "payment_persisted", source, status: result.status });
  return result;
}

function getAfdianPlanId(env) {
  const configured = typeof env.AFDIAN_PLAN_ID === "string" ? env.AFDIAN_PLAN_ID.trim() : "";
  return /^[A-Za-z0-9]{16,64}$/.test(configured) ? configured : DEFAULT_AFDIAN_PLAN_ID;
}

async function activatePayment(env, payment) {
  const response = await fetchWithRetry(
    `${env.SUPABASE_URL}/rest/v1/rpc/sunland_activate_pro_from_payment`,
    {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_KEY,
        Authorization: `Bearer ${env.SUPABASE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_order_id: payment.orderId,
        p_payment_reference: payment.paymentReference,
        p_binding_source: payment.bindingSource,
        p_plan_id: payment.planId,
        p_total_amount: payment.totalAmount,
        p_paid_at: payment.paidAt,
      }),
    },
  );

  if (!response.ok) throw new Error(`payment RPC returned ${response.status}`);
  const payload = await response.json().catch(() => null);
  const result = Array.isArray(payload) ? payload[0] : payload;
  if (!result || typeof result.status !== "string") {
    throw new Error("payment RPC returned invalid JSON");
  }
  return result;
}

async function queryAfdianOrders(env, paramsObject) {
  const ts = Math.floor(Date.now() / 1000);
  const params = JSON.stringify(paramsObject);
  const raw = `params${params}ts${ts}user_id${env.USER_ID}`;
  const sign = await md5(`${env.TOKEN}${raw}`);
  const response = await fetchWithRetry(AFDIAN_QUERY_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: env.USER_ID, params, ts, sign }),
  });

  if (!response.ok) throw new Error(`Afdian query returned ${response.status}`);
  const payload = await response.json().catch(() => null);
  const list = payload?.data?.list;
  if (payload?.ec !== 200 || !Array.isArray(list)) {
    throw new Error("Afdian query returned invalid data");
  }

  const totalPage = Number.parseInt(payload.data.total_page, 10);
  return { list, totalPage: Number.isSafeInteger(totalPage) && totalPage > 0 ? totalPage : 1 };
}

async function getReconciliationPage(env) {
  try {
    const value = await env.ORDERS.get(RECONCILIATION_CURSOR_KEY);
    const page = Number.parseInt(value, 10);
    return Number.isSafeInteger(page) && page > 0 ? page : 2;
  } catch (error) {
    logEvent({ event: "reconciliation_cursor_unavailable", reason: errorCode(error) });
    return 2;
  }
}

async function getReconciliationFullScanDay(env) {
  try {
    const value = await env.ORDERS.get(RECONCILIATION_FULL_SCAN_DAY_KEY);
    return /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value : null;
  } catch (error) {
    logEvent({ event: "reconciliation_state_unavailable", reason: errorCode(error) });
    return null;
  }
}

async function setReconciliationState(env, key, value) {
  try {
    await env.ORDERS.put(key, value);
  } catch (error) {
    // KV 只保存扫描进度，不能影响已持久化的付款账本；下轮会从安全的重叠页重试。
    logEvent({ event: "reconciliation_state_write_failed", reason: errorCode(error) });
  }
}

function isPaidOrder(order) {
  return isOrderObject(order) && Number(order.status) === 2;
}

function isOrderObject(order) {
  return !!order && typeof order === "object" && !Array.isArray(order);
}

function normalizeOrderId(value) {
  const orderId = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9_-]{6,128}$/.test(orderId) ? orderId : null;
}

function resolvePaymentBinding(order) {
  const customOrderId = normalizeBinding(order?.custom_order_id);
  if (customOrderId) {
    return {
      paymentReference: customOrderId,
      bindingSource: LEGACY_USER_ID_PATTERN.test(customOrderId) ? "legacy" : "intent",
    };
  }

  const legacyRemark = normalizeBinding(order?.remark);
  if (legacyRemark && LEGACY_USER_ID_PATTERN.test(legacyRemark)) {
    return { paymentReference: legacyRemark, bindingSource: "legacy" };
  }
  return { paymentReference: null, bindingSource: "unresolved" };
}

function normalizeBinding(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 128 ? normalized : null;
}

function normalizeAmount(value) {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000) return null;
  return amount;
}

function normalizePaidAt(order) {
  const timestamp = order?.pay_time ?? order?.create_time ?? order?.created_at ?? null;
  if (typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0) {
    return new Date(timestamp * 1000).toISOString();
  }
  if (typeof timestamp === "string" && timestamp.trim()) {
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

async function verifyWebhookSignature(order, sign, publicKeyPem) {
  try {
    const data = new TextEncoder().encode([
      order.out_trade_no,
      order.user_id,
      order.plan_id,
      order.total_amount,
    ].map(value => String(value ?? "")).join(""));
    const key = await crypto.subtle.importKey(
      "spki",
      pemToArrayBuffer(publicKeyPem),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      key,
      base64ToArrayBuffer(sign),
      data,
    );
  } catch {
    return false;
  }
}

function pemToArrayBuffer(value) {
  const base64 = String(value || "")
    .replace(/-----BEGIN PUBLIC KEY-----/g, "")
    .replace(/-----END PUBLIC KEY-----/g, "")
    .replace(/\s/g, "");
  return base64ToArrayBuffer(base64);
}

function base64ToArrayBuffer(value) {
  const binary = atob(String(value || "").replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

async function hasValidAdminToken(request, expectedToken) {
  const expected = typeof expectedToken === "string" ? expectedToken : "";
  const authorization = request.headers.get("Authorization") || "";
  const actual = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!expected || !actual) return false;

  const left = new TextEncoder().encode(expected);
  const right = new TextEncoder().encode(actual);
  if (left.length === right.length && typeof crypto.subtle.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(left, right);
  }

  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] || 0) ^ (right[index] || 0);
  }
  return difference === 0;
}

async function fetchWithRetry(url, init) {
  let lastError = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, init);
      if (!shouldRetryStatus(response.status) || attempt === RETRY_DELAYS_MS.length) return response;
      await delay(RETRY_DELAYS_MS[attempt]);
    } catch (error) {
      lastError = error;
      if (attempt === RETRY_DELAYS_MS.length) throw error;
      await delay(RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError || new Error("request failed");
}

async function fetchWithTimeout(url, init) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function shouldRetryStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function readJsonRequest(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function methodNotAllowed(methods) {
  return new Response("Method not allowed", {
    status: 405,
    headers: { Allow: methods.join(", ") },
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function errorCode(error) {
  return error instanceof Error && error.message ? error.message.slice(0, 120) : "unknown";
}

function logEvent(event) {
  console.log(JSON.stringify(event));
}

// MD5 函数：爱发电 Open API 的既有签名协议要求 MD5；不用于密码或新安全设计。
async function md5(str) {
  return md5Hex(str);
}

function md5Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const words = bytesToWords(bytes);
  const bitLength = bytes.length * 8;

  words[bitLength >> 5] |= 0x80 << (bitLength % 32);
  words[(((bitLength + 64) >>> 9) << 4) + 14] = bitLength;

  let a = 1732584193;
  let b = -271733879;
  let c = -1732584194;
  let d = 271733878;

  for (let i = 0; i < words.length; i += 16) {
    const oldA = a;
    const oldB = b;
    const oldC = c;
    const oldD = d;

    a = ff(a, b, c, d, words[i], 7, -680876936);
    d = ff(d, a, b, c, words[i + 1], 12, -389564586);
    c = ff(c, d, a, b, words[i + 2], 17, 606105819);
    b = ff(b, c, d, a, words[i + 3], 22, -1044525330);
    a = ff(a, b, c, d, words[i + 4], 7, -176418897);
    d = ff(d, a, b, c, words[i + 5], 12, 1200080426);
    c = ff(c, d, a, b, words[i + 6], 17, -1473231341);
    b = ff(b, c, d, a, words[i + 7], 22, -45705983);
    a = ff(a, b, c, d, words[i + 8], 7, 1770035416);
    d = ff(d, a, b, c, words[i + 9], 12, -1958414417);
    c = ff(c, d, a, b, words[i + 10], 17, -42063);
    b = ff(b, c, d, a, words[i + 11], 22, -1990404162);
    a = ff(a, b, c, d, words[i + 12], 7, 1804603682);
    d = ff(d, a, b, c, words[i + 13], 12, -40341101);
    c = ff(c, d, a, b, words[i + 14], 17, -1502002290);
    b = ff(b, c, d, a, words[i + 15], 22, 1236535329);

    a = gg(a, b, c, d, words[i + 1], 5, -165796510);
    d = gg(d, a, b, c, words[i + 6], 9, -1069501632);
    c = gg(c, d, a, b, words[i + 11], 14, 643717713);
    b = gg(b, c, d, a, words[i], 20, -373897302);
    a = gg(a, b, c, d, words[i + 5], 5, -701558691);
    d = gg(d, a, b, c, words[i + 10], 9, 38016083);
    c = gg(c, d, a, b, words[i + 15], 14, -660478335);
    b = gg(b, c, d, a, words[i + 4], 20, -405537848);
    a = gg(a, b, c, d, words[i + 9], 5, 568446438);
    d = gg(d, a, b, c, words[i + 14], 9, -1019803690);
    c = gg(c, d, a, b, words[i + 3], 14, -187363961);
    b = gg(b, c, d, a, words[i + 8], 20, 1163531501);
    a = gg(a, b, c, d, words[i + 13], 5, -1444681467);
    d = gg(d, a, b, c, words[i + 2], 9, -51403784);
    c = gg(c, d, a, b, words[i + 7], 14, 1735328473);
    b = gg(b, c, d, a, words[i + 12], 20, -1926607734);

    a = hh(a, b, c, d, words[i + 5], 4, -378558);
    d = hh(d, a, b, c, words[i + 8], 11, -2022574463);
    c = hh(c, d, a, b, words[i + 11], 16, 1839030562);
    b = hh(b, c, d, a, words[i + 14], 23, -35309556);
    a = hh(a, b, c, d, words[i + 1], 4, -1530992060);
    d = hh(d, a, b, c, words[i + 4], 11, 1272893353);
    c = hh(c, d, a, b, words[i + 7], 16, -155497632);
    b = hh(b, c, d, a, words[i + 10], 23, -1094730640);
    a = hh(a, b, c, d, words[i + 13], 4, 681279174);
    d = hh(d, a, b, c, words[i], 11, -358537222);
    c = hh(c, d, a, b, words[i + 3], 16, -722521979);
    b = hh(b, c, d, a, words[i + 6], 23, 76029189);
    a = hh(a, b, c, d, words[i + 9], 4, -640364487);
    d = hh(d, a, b, c, words[i + 12], 11, -421815835);
    c = hh(c, d, a, b, words[i + 15], 16, 530742520);
    b = hh(b, c, d, a, words[i + 2], 23, -995338651);

    a = ii(a, b, c, d, words[i], 6, -198630844);
    d = ii(d, a, b, c, words[i + 7], 10, 1126891415);
    c = ii(c, d, a, b, words[i + 14], 15, -1416354905);
    b = ii(b, c, d, a, words[i + 5], 21, -57434055);
    a = ii(a, b, c, d, words[i + 12], 6, 1700485571);
    d = ii(d, a, b, c, words[i + 3], 10, -1894986606);
    c = ii(c, d, a, b, words[i + 10], 15, -1051523);
    b = ii(b, c, d, a, words[i + 1], 21, -2054922799);
    a = ii(a, b, c, d, words[i + 8], 6, 1873313359);
    d = ii(d, a, b, c, words[i + 15], 10, -30611744);
    c = ii(c, d, a, b, words[i + 6], 15, -1560198380);
    b = ii(b, c, d, a, words[i + 13], 21, 1309151649);
    a = ii(a, b, c, d, words[i + 4], 6, -145523070);
    d = ii(d, a, b, c, words[i + 11], 10, -1120210379);
    c = ii(c, d, a, b, words[i + 2], 15, 718787259);
    b = ii(b, c, d, a, words[i + 9], 21, -343485551);

    a = add32(a, oldA);
    b = add32(b, oldB);
    c = add32(c, oldC);
    d = add32(d, oldD);
  }

  return [a, b, c, d].map(toHexLE).join("");
}

function bytesToWords(bytes) {
  const words = [];
  for (let i = 0; i < bytes.length; i += 1) {
    words[i >> 2] = (words[i >> 2] || 0) | (bytes[i] << ((i % 4) * 8));
  }
  return words;
}

function cmn(q, a, b, x, s, t) {
  return add32(rotl(add32(add32(a, q), add32(x, t)), s), b);
}

function ff(a, b, c, d, x, s, t) {
  return cmn((b & c) | (~b & d), a, b, x, s, t);
}

function gg(a, b, c, d, x, s, t) {
  return cmn((b & d) | (c & ~d), a, b, x, s, t);
}

function hh(a, b, c, d, x, s, t) {
  return cmn(b ^ c ^ d, a, b, x, s, t);
}

function ii(a, b, c, d, x, s, t) {
  return cmn(c ^ (b | ~d), a, b, x, s, t);
}

function rotl(value, shift) {
  return (value << shift) | (value >>> (32 - shift));
}

function add32(a, b) {
  return (a + b) | 0;
}

function toHexLE(value) {
  const normalized = value >>> 0;
  return [
    normalized & 0xff,
    (normalized >>> 8) & 0xff,
    (normalized >>> 16) & 0xff,
    (normalized >>> 24) & 0xff
  ].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
