const AFDIAN_QUERY_ENDPOINT = "https://ifdian.net/api/open/query-order";
const IDENTITY_ENDPOINT = "https://api.sunland.dev/v1/account/identity";
const LIMITS = Object.freeze({ ordersPerRun: 8, pageSize: 50, providerBackoffSeconds: 60 });
const RETRY_DELAYS_MS = [75, 225];
const REQUEST_TIMEOUT_MS = 8_000;
const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9@._+-]{0,127}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEGACY_USER_ID_PATTERN = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const DURABLE_PAYMENT_STATUSES = new Set(["activated", "already_processed", "already_pro", "unresolved", "ineligible"]);
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


export default {
  async scheduled(_controller, env) {
    if (env.AFDIAN_ROLLOUT_DIAGNOSTICS_ONLY === 'true') {
      // Read-only upstream gate: no hints, leases, payment facts or entitlements.
      const diagnostics = await Promise.allSettled([
        queryProvider(env, { page: 1 }, true),
        queryIdentityResponse('Bearer invalid-rollout-token', env),
      ]);
      if (diagnostics.some(result => result.status === 'rejected')) throw policyError('UPSTREAM_DIAGNOSTIC_FAILED');
      return;
    }
    // 独立通道：某页失败不阻断另一通道；游标只在持久化成功后推进。
    const outcomes = await Promise.allSettled([
      reconcilePage(env, 'recent', 'cron_recent'),
      reconcilePage(env, 'history', 'cron_history'),
      retryKnownOrders(env),
    ]);
    const errors = outcomes.filter(result => result.status === 'rejected');
    if (errors.length) throw new Error('RECONCILIATION_INCOMPLETE');
  },
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (env.AFDIAN_ROLLOUT_DIAGNOSTICS_ONLY === 'true' && path !== '/payment/reconcile') {
      return jsonResponse({ error: 'PAYMENT_MAINTENANCE' }, 503);
    }
    if (path === '/payment/reconcile') return withCors(request, await handleUserReconcile(request, env));
    if (path === '/webhook/afdian') return handleAfdianWebhook(request, env);
    if (path === '/admin/reconcile') return handleAdminReconcile(request, env);
    return new Response('Not found', { status: 404 });
  },
};

function policyError(code) { return Object.assign(new Error(code), { code }); }
function normalizeOrderId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{6,128}$/.test(value) ? value : null;
}
export function normalizeAndValidateProviderOrder(order) {
  if (!order || typeof order !== 'object' || Array.isArray(order) || !normalizeOrderId(order.out_trade_no)) throw policyError('PROVIDER_FACT_CONFLICT');
  // Provider total_amount 为十进制字符串。禁止浮点/科学计数法/隐式Number授权。
  if (typeof order.total_amount !== 'string' || !/^(0|[1-9][0-9]{0,6})(\.[0-9]{1,2})?$/.test(order.total_amount)) throw policyError('AMOUNT_MISMATCH');
  const [whole, fraction = ''] = order.total_amount.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents > 100_000_000) throw policyError('AMOUNT_MISMATCH');
  if (typeof order.plan_id !== 'string' || order.plan_id.length > 128 || !Number.isInteger(order.product_type) || ![0, 1].includes(order.product_type)) throw policyError('INVALID_PRODUCT');
  // 固定人民币商户/方案契约；API未提供currency时使用该契约，显式其它币种拒绝。
  if (order.currency !== undefined && order.currency !== 'CNY') throw policyError('INVALID_PRODUCT');
  let reference = null;
  let source = 'unresolved';
  if (order.custom_order_id !== undefined && order.custom_order_id !== null && order.custom_order_id !== '') {
    if (typeof order.custom_order_id !== 'string' || !UUID_PATTERN.test(order.custom_order_id)) throw policyError('INVALID_BINDING');
    reference = order.custom_order_id.toLowerCase(); source = 'intent';
  } else if (typeof order.remark === 'string' && LEGACY_USER_ID_PATTERN.test(order.remark)) {
    reference = order.remark; source = 'legacy';
  }
  const status = order.status === 2 || order.status === '2' ? 'paid'
    : order.status === 'refunded' ? 'refunded' : order.status === 'cancelled' ? 'cancelled' : 'unknown';
  // 数字退款状态未获官方契约确认，一律unknown，不猜数字枚举。
  const timestamp = order.pay_time;
  const date = typeof timestamp === 'number' && Number.isSafeInteger(timestamp) && timestamp > 0 && timestamp < 253402300800
    ? new Date(timestamp * 1000).toISOString() : null;
  let skuDetail = [];
  if (order.product_type === 1) {
    if (!Array.isArray(order.sku_detail) || order.sku_detail.length !== 1) throw policyError('INVALID_PRODUCT');
    const sku = order.sku_detail[0];
    if (!sku || typeof sku.sku_id !== 'string' || !/^[a-f0-9]{32}$/.test(sku.sku_id)
      || !Number.isSafeInteger(sku.count) || sku.count < 1) throw policyError('INVALID_PRODUCT');
    // Preserve only official SKU facts. Eligibility is checked by the database.
    skuDetail = [{ sku_id: sku.sku_id, count: sku.count }];
  }
  return { provider: 'afdian', sku_detail: skuDetail, order_id: order.out_trade_no, payment_status: status, plan_id: order.plan_id,
    product_type: order.product_type, amount_cents: cents,
    total_amount: `${whole}.${fraction.padEnd(2, '0')}`, currency: 'CNY',
    binding_reference: reference, binding_source: source, paid_at: date };
}

async function rpc(env, name, args = {}) {
  const response = await fetchWithRetry(`${env.SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: dbHeaders(env), body: JSON.stringify(args),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload === null) throw policyError('DATABASE_UNAVAILABLE');
  return payload;
}
function dbHeaders(env) {
  return { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${env.SUPABASE_KEY}`, 'Content-Type': 'application/json' };
}
async function dbRows(env, table, query) {
  const response = await fetchWithRetry(`${env.SUPABASE_URL}/rest/v1/${table}?${query}`, { headers: dbHeaders(env) });
  const rows = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(rows)) throw policyError('DATABASE_UNAVAILABLE');
  return rows;
}
async function queryProvider(env, paramsObject, diagnosticOnly = false) {
  if (!diagnosticOnly) {
    const backoff = await rpc(env, 'sunland_get_pro_payment_backoff');
    if (backoff.retry_after_seconds > 0) throw policyError('PROVIDER_BACKOFF');
  }
  if (!env.USER_ID || !env.TOKEN) throw policyError('PROVIDER_CREDENTIALS_UNAVAILABLE');
  const ts = Math.floor(Date.now() / 1000);
  const params = JSON.stringify(paramsObject);
  const sign = await md5(`${env.TOKEN}params${params}ts${ts}user_id${env.USER_ID}`);
  // Provider 429 不做立即重试；跨Worker共享退避。禁止URL覆盖/redirect到其它host。
  let response;
  try { response = await fetchWithTimeout(AFDIAN_QUERY_ENDPOINT, {
    method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: env.USER_ID, params, ts, sign }),
  }); } catch (error) {
    logEvent({ event: 'provider_query_diagnostic', stage: 'fetch', reason_code: safeFetchFailure(error) });
    throw policyError('PROVIDER_QUERY_FAILED');
  }
  if (response.status === 429) {
    const header = response.headers.get('Retry-After');
    const seconds = /^\d+$/.test(header || '') ? Math.min(3600, Math.max(1, Number(header))) : LIMITS.providerBackoffSeconds;
    await rpc(env, 'sunland_set_pro_payment_backoff', { p_retry_after_seconds: seconds });
    throw policyError('PROVIDER_BACKOFF');
  }
  if (!response.ok) {
    logEvent({ event: 'provider_query_diagnostic', stage: 'http', http_status: response.status });
    throw policyError('PROVIDER_QUERY_FAILED');
  }
  let payload;
  try { payload = await response.json(); } catch {
    logEvent({ event: 'provider_query_diagnostic', stage: 'json_parse', http_status: response.status, content_type: safeContentType(response) });
    throw policyError('PROVIDER_QUERY_FAILED');
  }
  const diagnostic = { event: 'provider_query_diagnostic', http_status: response.status,
    content_type: safeContentType(response), ec: Number.isSafeInteger(payload?.ec) ? payload.ec : null,
    list_type: Array.isArray(payload?.data?.list) ? 'array' : typeof payload?.data?.list,
    list_length: Array.isArray(payload?.data?.list) ? payload.data.list.length : null,
    total_page_type: typeof payload?.data?.total_page };
  if (payload?.ec !== 200 || !Array.isArray(payload?.data?.list) || payload.data.list.length > LIMITS.pageSize || !Number.isInteger(payload.data.total_page) || payload.data.total_page < 0) {
    logEvent({ ...diagnostic, stage: 'json_shape' });
    throw policyError('PROVIDER_QUERY_FAILED');
  }
  logEvent({ ...diagnostic, stage: 'verified' });
  return { list: payload.data.list, totalPage: Math.max(1, payload.data.total_page) };
}

function safeContentType(response) {
  const mime = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  return ['application/json', 'text/html', 'text/plain'].includes(mime) ? mime : 'other';
}

function safeFetchFailure(error) {
  if (error?.name === 'AbortError') return 'TIMEOUT';
  const message = typeof error?.message === 'string' ? error.message : '';
  if (/redirect/i.test(message)) return 'REDIRECT_REJECTED';
  if (/same.zone|cross.worker|service.binding/i.test(message)) return 'WORKER_ROUTING';
  if (/unsupported|invalid.*(mode|option)|not implemented/i.test(message)) return 'UNSUPPORTED_REQUEST_OPTION';
  if (/dns|resolve|lookup/i.test(message)) return 'DNS_FAILURE';
  if (/ssl|tls|certificate/i.test(message)) return 'TLS_FAILURE';
  return 'NETWORK_ERROR';
}

async function queryIdentityResponse(authorization, env) {
  let response;
  try {
    response = await fetchWithTimeout(IDENTITY_ENDPOINT, { method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: '{}', redirect: 'manual' }, env?.AFDIAN_IDENTITY_SERVICE);
  } catch (error) {
    logEvent({ event: 'identity_query_diagnostic', stage: 'fetch', reason_code: safeFetchFailure(error) });
    throw policyError('IDENTITY_UNAVAILABLE');
  }
  logEvent({ event: 'identity_query_diagnostic', stage: 'response', http_status: response.status, content_type: safeContentType(response) });
  return response;
}
export async function queryProviderOrder(env, orderId) {
  if (!normalizeOrderId(orderId)) throw policyError('INVALID_BINDING');
  const page = await queryProvider(env, { out_trade_no: orderId });
  const matches = page.list.filter(order => order?.out_trade_no === orderId);
  if (matches.length !== 1) throw policyError('PROVIDER_QUERY_FAILED');
  return normalizeAndValidateProviderOrder(matches[0]);
}
async function persistVerified(env, observation, source, traceId, cached = false) {
  const result = await rpc(env, 'sunland_process_verified_pro_order', {
    p_order: observation, p_processing_source: source, p_trace_id: traceId, p_use_cached: cached,
  });
  if (!DURABLE_PAYMENT_STATUSES.has(result?.status)) throw policyError('DATABASE_UNAVAILABLE');
  logEvent({ event: 'payment_persisted', trace_id: traceId, order_id: observation.order_id, source,
    state_before: result.state_before ?? null, state_after: result.state_after ?? result.status,
    attempt: result.attempt_count ?? null, reason_code: result.reason_code || null,
    cached, commit_outcome: 'confirmed_by_rpc' });
  return result;
}
async function recordHints(env, ids, source, traceId) {
  if (!ids.length) return;
  await rpc(env, 'sunland_record_pro_payment_hints', { p_order_ids: ids, p_processing_source: source, p_trace_id: traceId });
}
async function noteRetry(env, id, reason, source, traceId) {
  const allowed = new Set(['PROVIDER_QUERY_FAILED','AMOUNT_MISMATCH','INVALID_PRODUCT','INVALID_BINDING']);
  await rpc(env, 'sunland_note_pro_payment_retry', { p_order_id: id,
    p_reason_code: allowed.has(reason) ? reason : 'PROVIDER_QUERY_FAILED', p_processing_source: source, p_trace_id: traceId });
}
async function processKnownOrder(env, row, source, traceId) {
  const claim = await rpc(env, 'sunland_claim_pro_payment_order_query', { p_order_id: row.order_id });
  if (claim?.acquired !== true) {
    if (!DURABLE_PAYMENT_STATUSES.has(claim?.status)) throw policyError('DATABASE_UNAVAILABLE');
    return claim;
  }
  try {
    return await persistVerified(env, await queryProviderOrder(env, row.order_id), source, traceId);
  } catch (error) {
    logEvent({ event: 'payment_attempt_failed', trace_id: traceId, order_id: row.order_id, source,
      reason_code: error.code || 'PROVIDER_QUERY_FAILED', commit_outcome: 'unknown' });
    await noteRetry(env, row.order_id, error.code, source, traceId);
    throw error;
  }
}
async function retryKnownOrders(env, userId = null) {
  const traceId = crypto.randomUUID();
  const owner = userId ? `&bound_user_id=eq.${encodeURIComponent(userId)}` : '';
  const rows = await dbRows(env, 'pro_payment_orders', `select=order_id&status=eq.unresolved&next_retry_at=lte.${encodeURIComponent(new Date().toISOString())}&order=next_retry_at.asc&limit=${LIMITS.ordersPerRun}${owner}`);
  // 真幂等RPC处理commit unknown，下次读取authoritative ledger再决定，不猜上次是否提交。
  const results = [];
  for (const row of rows) {
    try { results.push(await processKnownOrder(env, row, userId ? 'user_reconcile' : 'cron_recent', traceId)); }
    catch { results.push({ status: 'unresolved', reason_code: 'PROVIDER_QUERY_FAILED' }); }
  }
  return results;
}
export async function reconcilePage(env, key, source, userId = null) {
  const lease = await rpc(env, 'sunland_claim_pro_payment_scan', { p_state_key: key });
  if (!lease?.acquired) return { acquired: false, retry_after_seconds: lease?.retry_after_seconds || 0 };
  const traceId = crypto.randomUUID();
  try {
    const page = key === 'history' ? lease.next_page : 1;
    const response = await queryProvider(env, { page });
    const ids = response.list.map(order => normalizeOrderId(order?.out_trade_no));
    if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw policyError('PROVIDER_FACT_CONFLICT');
    await recordHints(env, ids, source, traceId);
    const completion = await rpc(env, 'sunland_complete_pro_payment_scan', {
      p_state_key: key, p_lease_token: lease.lease_token, p_generation: lease.generation,
      p_next_page: key !== 'history' || page >= response.totalPage ? 1 : page + 1,
      p_total_pages: response.totalPage, p_order_ids: ids,
    });
    if (completion?.advanced !== true) throw policyError('SCAN_LEASE_LOST');
    if (userId) await retryKnownOrders(env, userId);
    // 页面只处理有限个；其余ID已持久为due hints，后续逐ID可信查询。
    for (const raw of response.list.slice(0, LIMITS.ordersPerRun)) {
      try { await persistVerified(env, normalizeAndValidateProviderOrder(raw), source, traceId); }
      catch (error) { await noteRetry(env, raw.out_trade_no, error.code, source, traceId); }
    }
    return { acquired: true };
  } catch (error) {
    await rpc(env, 'sunland_release_pro_payment_scan', { p_state_key: key, p_lease_token: lease.lease_token, p_generation: lease.generation }).catch(() => {});
    logEvent({ event: 'scan_failed', source, trace_id: traceId, reason_code: error.code || 'PROVIDER_QUERY_FAILED' });
    throw error;
  }
}
async function handleAfdianWebhook(request, env) {
  if (request.method !== 'POST') return methodNotAllowed(['POST']);
  const payload = await readJsonRequest(request);
  const order = payload?.data?.type === 'order' ? payload.data.order : null;
  const sign = payload?.sign || payload?.data?.sign;
  if (!normalizeOrderId(order?.out_trade_no) || typeof sign !== 'string') return jsonResponse({ ec: 400, em: 'invalid webhook' }, 400);
  if (!await verifyWebhookSignature(order, sign, env.AFDIAN_WEBHOOK_PUBLIC_KEY || DEFAULT_AFDIAN_WEBHOOK_PUBLIC_KEY)) return jsonResponse({ ec: 401, em: 'invalid signature' }, 401);
  const traceId = crypto.randomUUID();
  let hintDurable = false;
  try {
    await recordHints(env, [order.out_trade_no], 'webhook', traceId);
    hintDurable = true;
    await processKnownOrder(env, { order_id: order.out_trade_no }, 'webhook', traceId);
    return jsonResponse({ ec: 200, em: '' });
  } catch {
    // hint已durable可ACK，未durable则返回503以请求平台重投。
    if (!hintDurable) return jsonResponse({ ec: 503, em: 'temporary processing failure' }, 503);
    try { await noteRetry(env, order.out_trade_no, 'PROVIDER_QUERY_FAILED', 'webhook', traceId); return jsonResponse({ ec: 200, em: '' }); }
    catch { return jsonResponse({ ec: 503, em: 'temporary processing failure' }, 503); }
  }
}
async function handleAdminReconcile(request, env) {
  if (request.method !== 'POST') return methodNotAllowed(['POST']);
  if (!await hasValidAdminToken(request, env.ADMIN_TOKEN)) return new Response('Not found', { status: 404 });
  const body = await readJsonRequest(request);
  if (!body || Object.keys(body).some(key => key !== 'out_trade_no') || !normalizeOrderId(body.out_trade_no)) return jsonResponse({ error: 'INVALID_REQUEST' }, 400);
  const traceId = crypto.randomUUID();
  try {
    await recordHints(env, [body.out_trade_no], 'manual_query', traceId);
    const result = await processKnownOrder(env, { order_id: body.out_trade_no }, 'manual_query', traceId);
    return jsonResponse(result);
  } catch { return jsonResponse({ error: 'RETRYABLE' }, 503); }
}
async function readMembership(env, userId) {
  try {
    const rows = await dbRows(env, 'user_profiles', `select=user_id,pro,identity_status&user_id=eq.${encodeURIComponent(userId)}&limit=1`);
    if (rows.length !== 1 || rows[0].identity_status !== 'active' || typeof rows[0].pro !== 'boolean') throw policyError('DATABASE_UNAVAILABLE');
    return { state: 'confirmed', pro: rows[0].pro, checked_at: new Date().toISOString() };
  } catch { return { state: 'unknown', pro: null, checked_at: null }; }
}
async function handleUserReconcile(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (request.method !== 'POST') return methodNotAllowed(['POST']);
  const body = await readJsonRequest(request);
  if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).length) return jsonResponse({ error: 'INVALID_REQUEST' }, 400);
  const auth = request.headers.get('Authorization') || '';
  if (!/^Bearer \S+$/.test(auth)) return jsonResponse({ error: 'UNAUTHORIZED' }, 401);
  try {
    const identityResponse = await queryIdentityResponse(auth, env);
    const identity = await identityResponse.json().catch(() => null);
    if (!identityResponse.ok) {
      const error = identityResponse.status === 403 && identity?.error === 'ACCOUNT_NOT_ACTIVE'
        ? 'ACCOUNT_NOT_ACTIVE' : 'IDENTITY_UNAVAILABLE';
      return jsonResponse({ error }, [401,403].includes(identityResponse.status) ? identityResponse.status : 503);
    }
    if (!USER_ID_PATTERN.test(identity?.user_id || '') || identity?.identity_status !== 'active') throw policyError('IDENTITY_UNAVAILABLE');
    const userId = identity.user_id;
    let membership = await readMembership(env, userId);
    let status = 'idle'; let retryAfter = 0;
    if (membership.state === 'unknown') status = 'retryable';
    else if (!membership.pro) {
      try {
        const scan = await reconcilePage(env, 'recent', 'user_reconcile', userId);
        retryAfter = scan.retry_after_seconds || 0;
        membership = await readMembership(env, userId);
      } catch { status = 'retryable'; retryAfter = LIMITS.providerBackoffSeconds; }
    }
    let pending = null;
    try {
      const rows = await dbRows(env, 'pro_payment_orders', `select=payment_status,reason_code:last_error_code,next_retry_at&bound_user_id=eq.${encodeURIComponent(userId)}&status=eq.unresolved&limit=8`);
      pending = rows.some(row => row.payment_status === 'paid');
      if (rows.some(row => row.next_retry_at === null)) status = 'review_required';
      else if (rows.length && status === 'idle') status = 'processing';
    } catch { status = 'retryable'; }
    return jsonResponse({ user_id: userId, membership,
      payment_sync: { status, paid_order_pending: pending }, retry_after_seconds: retryAfter });
  } catch { return jsonResponse({ error: 'RETRYABLE' }, 503); }
}
function withCors(request, response) {
  const origin = request.headers.get('Origin');
  const allowed = ['https://sunland.dev', 'https://www.sunland.dev'];
  const headers = new Headers(response.headers);
  if (allowed.includes(origin)) {
    headers.set('Access-Control-Allow-Origin', origin); headers.set('Vary', 'Origin');
    headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  }
  headers.set('Cache-Control', 'no-store');
  return new Response(response.body, { status: response.status, headers });
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

async function fetchWithTimeout(url, init, service) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const options = { ...init, signal: controller.signal };
    return await (service ? service.fetch(new Request(url, options)) : fetch(url, options));
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
  // MD5 padding words must be zero, not sparse undefined values (NaN in add32).
  const words = new Array(Math.ceil((bytes.length + 9) / 64) * 16).fill(0);
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
