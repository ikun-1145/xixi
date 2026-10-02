// Sunland AI · Waffo(Pancake) 支付 Worker —— 接入准备版（NOT 生产切流）
//
// 设计约束（与爱发电 afdianpay 完全隔离）：
//  - 结账在服务端用 API Key(RSA-SHA256) 发起，密钥仅经 Secret 注入，绝不下发前端。
//  - Webhook 用原始请求体 + X-Waffo-Signature(t/v1) 做 RSA-SHA256 验签，过去 45 分钟/未来 1 分钟。
//  - Production 独立模块用验签金额 + 官方 GraphQL 校验实际商品及绑定后才可调用权益 RPC。
//    不允许用 UPDATE pro=true 绕过 RPC；legacy 观测分支仍拒绝开通。
//  - Test/Prod 强隔离：验签通过的 test-mode 事件也绝不开通生产 Pro。
//  - 生产开通默认关闭；Test 不受 Production 权益开关影响。
//  - 前端永不决定 user_id / 金额 / 最终状态：绑定靠服务端 intent(uuid) 经 orderMerchantExternalId 回传。
//
// 未采用官方 @waffo/pancake-ts SDK 的原因：本仓库 Worker 采用零依赖 + WebCrypto 风格
// （见 afdianpay/worker.js），引入 npm SDK 会带来打包器与依赖链，违背最小改动与可维护原则。
// 若后续需要，可在不改变对外契约的前提下替换为 SDK。

const WAFFO_CHECKOUT_PATH = "/v1/actions/checkout/create-session";
const WEBHOOK_TOLERANCE_MS = 45 * 60 * 1000; // 官方：重试会重放原始 t，容差 45 分钟
const WEBHOOK_FUTURE_TOLERANCE_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 64 * 1024;
const WAFFO_PRODUCT_ID = "PROD_4ibh2Jka4tSTmyb35okbRs";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 处理的事件类型（一次性产品）：完成 + 退款成功/失败。订阅类事件本轮不处理。
const HANDLED_EVENT_TYPES = new Set(["order.completed", "refund.succeeded", "refund.failed"]);

// 站点语言 → Waffo 收银台语言枚举（IETF BCP 47，取官方支持集合的子集）。
const LANGUAGE_MAP = {
  zh: "zh-Hans",
  "zh-Hant": "zh-Hant-TW",
  en: "en",
  ja: "ja-JP",
  ko: "ko-KR",
  es: "es-MX",
};

const DEFAULT_ALLOWED_ORIGINS = ["https://sunland.dev", "https://www.sunland.dev"];

export default {
  async scheduled(controller, env, ctx) {
    const production = await import('./production.js');
    ctx.waitUntil(production.reconcileProductionOutbox(env).catch(() =>
      console.error(JSON.stringify({event:'waffo_production_outbox_unavailable'}))));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === "POST") request = limitRequestBody(request);
      if (url.pathname === "/test/done") {
        if (request.method !== "GET") return methodNotAllowed(["GET"]);
        return new Response("Waffo Test checkout navigation completed. Payment and ledger status require separate verification. No Pro entitlement is granted.", { headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'", "Cache-Control": "no-store" } });
      }
      if (url.pathname === "/production/done") {
        if (request.method !== "GET") return methodNotAllowed(["GET"]);
        return new Response(null, { status: 302, headers: { Location: "https://sunland.dev/waffo-return.html", "Cache-Control": "no-store" } });
      }
      if (url.pathname === "/checkout/waffo/production/status") {
        const production = await import("./production.js");
        const response = await withCors(request, env, () => production.handleProductionReturnStatus(request, env));
        response.headers.set("Cache-Control", "no-store");
        return response;
      }
      if (url.pathname === "/checkout/waffo/production") {
        const production = await import("./production.js");
        return await withCors(request, env, () => production.handleProductionCheckout(request, env));
      }
      if (url.pathname === "/checkout/waffo") {
        return await withCors(request, env, () => handleCheckout(request, env));
      }
      if (url.pathname === "/webhook/waffo") {
        // Untrusted mode selects a handler only; each handler verifies its own key.
        if (env.WAFFO_ENVIRONMENT === "test" && env.WAFFO_PRODUCTION_ENABLED === "true" && request.method === "POST") {
          const body = await request.clone().json().catch(() => null);
          if (body?.mode === "prod") {
            const production = await import("./production.js");
            return await production.handleProductionWebhook(request, env);
          }
        }
        return await handleWebhook(request, env);
      }
    } catch (error) {
      return requestFailure(error);
    }
    return new Response("Not found", { status: 404 });
  },
};

// ------------------------------------------------------------------ Checkout

async function handleCheckout(request, env) {
  if (request.method !== "POST") return methodNotAllowed(["POST", "OPTIONS"]);

  // 1) 仅转发标准 Supabase authenticated 令牌至固定隔离 schema；预检不替代数据库验签。
  //    Worker 从不接收/信任前端传来的 user_id 或金额。
  const token = bearerToken(request);
  if (!token) return jsonResponse({ error: "authentication required" }, 401);

  if (!testBackendUrl(env)) return jsonResponse({ error: "test backend unavailable" }, 503);
  const claims = testRoleClaims(token, "authenticated");
  // ingest bot 也是 authenticated；数据库已拒绝其 checkout，这里提前拦截避免任何后端调用。
  if (!claims || claims.sub.toLowerCase() === String(env.WAFFO_TEST_INGEST_SUB || "").toLowerCase()) {
    return jsonResponse({ error: "test authentication required" }, 401);
  }
  const privateKey = env.WAFFO_PRIVATE_KEY_TEST;
  const successUrl = testSuccessUrl(request, env);
  if (!successUrl || !privateKey || !/^MER_[A-Za-z0-9]+$/.test(env.WAFFO_MERCHANT_ID || "")
    || !/^STO_[A-Za-z0-9]+$/.test(env.WAFFO_STORE_ID || "")
    || env.WAFFO_PRODUCT_ID !== WAFFO_PRODUCT_ID || env.WAFFO_CURRENCY !== "CNY") {
    return jsonResponse({ error: "checkout configuration unavailable" }, 503);
  }

  let body = {};
  try {
    const raw = await request.text();
    body = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid body");
  } catch (error) {
    if (error?.code === "body_too_large") throw error;
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  let intent;
  try {
    intent = await createOrGetIntent(env, token);
  } catch (error) {
    logEvent({ event: "waffo_intent_failed", reason: error.code || "intent_unknown", ...error.intentDiagnostic });
    const response = jsonResponse({ error: "authentication or intent unavailable" }, error?.code === "intent_unauthorized" ? 401 : 503);
    // Test-only, authenticated harness diagnostics; contains only allowlisted metadata.
    response.headers.set("X-Waffo-Intent-Diagnostic", JSON.stringify({ reason: error.code || "intent_unknown", ...error.intentDiagnostic }));
    return response;
  }
  const paymentReference = intent.payment_reference;
  if (!UUID_PATTERN.test(paymentReference || "")) {
    return jsonResponse({ error: "intent unavailable" }, 502);
  }
  if (intent.status !== "pending") return jsonResponse({ error: "intent unavailable" }, 502);

  // 2) 服务端用 API Key 发起 Waffo checkout；绑定引用经 orderMerchantExternalId + metadata 回传。
  const checkoutBody = {
    productId: env.WAFFO_PRODUCT_ID,
    currency: "CNY",
    orderMerchantExternalId: paymentReference,
    metadata: { payment_reference: paymentReference },
    successUrl,
    language: mapLanguage(body.language),
    darkMode: body.darkMode === true,
  };

  try {
    const session = await createWaffoCheckoutSession(env, privateKey, checkoutBody);
    const checkoutUrl = checkoutUrlOrNull(session?.data?.checkoutUrl);
    if (!checkoutUrl || (Array.isArray(session?.errors) && session.errors.length) || (session?.errors && !Array.isArray(session.errors))) {
      throw new Error("waffo returned no checkout url");
    }
    logEvent({ event: "waffo_checkout_created", reference: paymentReference });
    return jsonResponse({ checkoutUrl });
  } catch (error) {
    // Waffo API 失败绝不能表现为已付款成功；返回 502 让前端提示重试。
    logEvent({ event: "waffo_checkout_failed", reason: errorCode(error) });
    return jsonResponse({ error: "checkout temporarily unavailable" }, 502);
  }
}

async function createOrGetIntent(env, userToken) {
  const started = Date.now();
  const diagnostic = { stage: "configuration" };
  try {
    const response = await fetchWithTimeout(
      `${testBackendUrl(env)}/rest/v1/rpc/get_or_create_intent`,
      {
        method: "POST",
        headers: {
          apikey: env.SUPABASE_ANON_KEY,
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/json",
          "Content-Profile": "waffo_test",
        },
        body: "{}",
      },
      diagnostic,
    );
    diagnostic.stage = "json_parse";
    let payload;
    try { payload = await response.json(); } catch {
      if (response.ok) throw intentError("intent_json_parse");
      payload = null;
    }
    diagnostic.json_type = payload === null ? "null" : Array.isArray(payload) ? "array" : typeof payload;
    if (Array.isArray(payload)) diagnostic.array_length = payload.length;
    const intent = Array.isArray(payload) ? payload[0] : payload;
    if (intent && typeof intent === "object" && !Array.isArray(intent)) {
      // Only contract keys: arbitrary server keys can themselves contain sensitive values.
      diagnostic.object_keys = Object.keys(intent).filter(key => ["payment_reference", "status", "code", "message", "details", "hint"].includes(key));
      if (typeof intent.code === "string" && /^(PGRST[0-9]{3}|[0-9A-Z]{5})$/.test(intent.code)) diagnostic.postgrest_code = intent.code;
    }
    if (!response.ok) {
      diagnostic.stage = "http";
      throw intentError(response.status === 401 || response.status === 403 ? "intent_unauthorized" : "intent_http");
    }
    diagnostic.stage = "json_shape";
    if (!intent || typeof intent !== "object" || Array.isArray(intent)) throw intentError("intent_json_shape");
    return intent;
  } catch (error) {
    const failure = intentError(error.intentCode || (error.code === "body_too_large" ? "intent_body_too_large" : `intent_${diagnostic.stage}`));
    failure.intentDiagnostic = { ...diagnostic, elapsed_ms: Date.now() - started };
    throw failure;
  }
}

function intentError(code) {
  const error = new Error(code);
  error.code = code;
  error.intentCode = code;
  return error;
}

export async function createWaffoCheckoutSession(env, privateKey, checkoutBody, idempotencyKey = crypto.randomUUID()) {
  const bodyString = JSON.stringify(checkoutBody);
  const timestamp = String(Math.floor(Date.now() / 1000)); // API 为秒；Webhook t 才为毫秒
  const signature = await signApiRequest(
    privateKey,
    "POST",
    WAFFO_CHECKOUT_PATH,
    timestamp,
    bodyString,
  );

  // 每次操作独立随机 key；不自动重试写请求，超时/409 交由调用者处理，不能假装成功。
  const response = await fetchWithTimeout(`https://api.waffo.ai${WAFFO_CHECKOUT_PATH}`, {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      "X-Merchant-Id": env.WAFFO_MERCHANT_ID,
      "X-Timestamp": timestamp,
      "X-Signature": signature,
      "X-Idempotency-Key": `${env.WAFFO_MERCHANT_ID}-${idempotencyKey}`,
    },
    body: bodyString,
  });

  if (!response.ok) throw new Error(`waffo checkout returned ${response.status}`);
  return response.json().catch(() => null);
}

// ------------------------------------------------------------------- Webhook

async function handleWebhook(request, env) {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);

  const configuredMode = configuredEnvironment(env);
  if (!configuredMode || !/^STO_[A-Za-z0-9]+$/.test(env.WAFFO_STORE_ID || "")) {
    return jsonResponse({ ok: false }, 503);
  }

  // 必须用原始请求体做验签，绝不能先 .json() 再重序列化。
  const rawBody = await request.text();
  const signatureHeader = request.headers.get("X-Waffo-Signature") || "";

  const verification = await verifyWaffoWebhook(
    rawBody,
    signatureHeader,
    collectWebhookPublicKeys(env),
    WEBHOOK_TOLERANCE_MS,
    Date.now(),
  );
  if (!verification.valid) {
    logEvent({ event: "waffo_webhook_rejected", reason: verification.reason });
    // 验签/时间戳失败一律 401，不给任何业务处理。
    return jsonResponse({ ok: false }, 401);
  }

  let envelope;
  try {
    envelope = JSON.parse(rawBody);
  } catch {
    logEvent({ event: "waffo_webhook_malformed" });
    return jsonResponse({ ok: false }, 400);
  }

  const normalized = normalizeWaffoEvent(envelope);
  if (!normalized.deliveryId || !normalized.eventId || !normalized.eventType) {
    logEvent({ event: "waffo_webhook_no_delivery_id" });
    return jsonResponse({ ok: false }, 400);
  }

  // 环境权威来源是"验签通过的公钥"，而非报文里的 mode 字段；两者不一致要记录。
  const environment = verification.environment;
  if (normalized.mode !== environment || normalized.mode !== configuredMode || normalized.storeId !== env.WAFFO_STORE_ID) {
    logEvent({
      event: "waffo_webhook_mode_mismatch",
      keyEnv: environment,
      payloadMode: normalized.mode,
      deliveryId: normalized.deliveryId,
    });
    return jsonResponse({ ok: false }, 400);
  }

  // 未知事件类型：确认接收但不做业务，避免无意义重试。
  if (!HANDLED_EVENT_TYPES.has(normalized.eventType)) {
    logEvent({ event: "waffo_webhook_unknown_type", type: normalized.eventType });
    return jsonResponse({ ok: true });
  }

  // 资格契约尚未批准：所有生产开通尝试先拒绝，不能吞掉金额未知/折扣付款并污染去重。
  if (normalized.eventType === "order.completed" && environment === "prod"
    && env.WAFFO_PRODUCTION_ENTITLEMENT_ENABLED === "true") {
    logEvent({ event: "waffo_webhook_processing_failed", reason: "waffo entitlement contract unapproved" });
    return jsonResponse({ ok: false }, 503);
  }

  // 仅交付级观测去重，不是并发锁/权益账本；未来业务去重须在副作用前用 DB 事务保证。
  // 观测事件不能污染未来权益处理的去重空间。
  const disposition = environment === "prod" && env.WAFFO_PRODUCTION_ENTITLEMENT_ENABLED === "true" ? "entitlement" : "observe";
  const deliveryKey = `${environment}:${normalized.storeId}:${disposition}:${normalized.eventType}:${normalized.deliveryId}:${normalized.eventId}`;
  if (environment !== "test" && await alreadyHandledDelivery(env, deliveryKey)) {
    logEvent({ event: "waffo_webhook_duplicate_delivery", deliveryId: normalized.deliveryId });
    return jsonResponse({ ok: true });
  }

  try {
    if (environment === "test") await recordTestEvent(env, normalized, rawBody);
    if (normalized.eventType === "order.completed") {
      await handleOrderCompleted(env, normalized, environment);
    } else {
      // refund.succeeded / refund.failed：识别并记录，本轮不撤销永久 Pro。
      logEvent({
        event: "waffo_refund_recorded",
        refundEvent: normalized.eventType,
        refundId: normalized.eventId,
        reference: normalized.order.reference,
        environment,
      });
    }
    await markDeliveryHandled(env, deliveryKey);
    return jsonResponse({ ok: true });
  } catch (error) {
    // 处理失败返回 5xx，让 Waffo 按指数退避重试；绝不吞掉错误当成成功。
    logEvent({ event: "waffo_webhook_processing_failed", reason: errorCode(error) });
    return jsonResponse({ ok: false }, 503);
  }
}

async function handleOrderCompleted(env, normalized, environment) {
  const order = normalized.order;

  // 结账态校验：只处理真正成功的订单。
  const statusOk = order.paymentStatus === "succeeded" && order.orderStatus === "completed";
  if (!statusOk) {
    logEvent({ event: "waffo_order_not_succeeded", deliveryId: normalized.deliveryId });
    return;
  }

  // 缺失币种不能放行；此产品只接受 CNY。
  const expectedCurrency = "CNY";
  if (env.WAFFO_CURRENCY !== expectedCurrency || order.currency !== expectedCurrency) {
    logEvent({
      event: "waffo_currency_mismatch",
      got: order.currency,
      expected: expectedCurrency,
    });
    return; // 币种不符不开通，但已验签，记录后正常 200
  }

  if (!/^PAY_[A-Za-z0-9]+$/.test(order.paymentId || "")
    || !/^ORD_[A-Za-z0-9]+$/.test(order.orderId || "") || normalized.eventId !== order.paymentId) {
    logEvent({ event: "waffo_missing_payment_id", deliveryId: normalized.deliveryId });
    return;
  }
  if (!UUID_PATTERN.test(order.reference || "")) {
    // 缺少可信绑定引用：记录为待人工核对，不猜测 user_id。
    logEvent({ event: "waffo_missing_reference", paymentId: order.paymentId });
    return;
  }

  const amountValidation = validateWaffoAmounts(order);
  if (!amountValidation.valid) {
    logEvent({ event: "waffo_amount_rejected", reason: amountValidation.reason, paymentId: order.paymentId });
    return;
  }

  // 官方 payload 没有可靠 productId；listPrice 也不足以证明商品身份/原价含税规则。
  // 等完成服务端 order→product/checkout 账本证据与税费/折扣契约后才能接统一 RPC。
  // 不能把未知商品补成配置商品，也不能使用 chargedAmount >= 15 开通。
  logEvent({
    event: "waffo_entitlement_suppressed",
    environment,
    productionEnabled: env.WAFFO_PRODUCTION_ENTITLEMENT_ENABLED === "true",
    paymentId: order.paymentId,
    reference: order.reference,
  });
}

// 金额均为已换算的主单位字符串。这里只验证格式/算术一致性，不证明权益资格。
export function validateWaffoAmounts(order) {
  const charged = cnyMinorUnits(order.chargedAmount);
  const total = cnyMinorUnits(order.listPrice?.total);
  const subtotal = cnyMinorUnits(order.listPrice?.subtotal);
  const tax = cnyMinorUnits(order.listPrice?.taxAmount);
  if (charged === null || total === null || subtotal === null || tax === null) {
    return { valid: false, reason: "missing_or_invalid_amount" };
  }
  if (charged <= 0n || total !== subtotal + tax || charged !== total) {
    return { valid: false, reason: "charge_price_mismatch" };
  }
  return { valid: true };
}

function cnyMinorUnits(value) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,9})(\.[0-9]{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}

// -------------------------------------------------------------- Waffo crypto

// API Key 请求签名：canonical = METHOD\nPATH\nTIMESTAMP\nSHA256_BASE64(BODY)，RSA-SHA256。
export async function signApiRequest(privateKeyPem, method, path, timestamp, bodyString) {
  const bodyDigest = await sha256Base64(new TextEncoder().encode(bodyString));
  const canonical = [method, path, timestamp, bodyDigest].join("\n");
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(canonical),
  );
  return arrayBufferToBase64(signature);
}

// 解析 X-Waffo-Signature: "t=<ms>,v1=<base64>"（对未知附加键健壮）。
export function parseWaffoSignatureHeader(header) {
  if (typeof header !== "string" || !header) return null;
  let t = null;
  let v1 = null;
  for (const part of header.split(",")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const k = part.slice(0, index).trim();
    const v = part.slice(index + 1).trim();
    if (k === "t") { if (t !== null) return null; t = v; }
    else if (k === "v1") { if (v1 !== null) return null; v1 = v; }
  }
  if (!/^[1-9][0-9]{12}$/.test(t || "") || !v1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(v1) || v1.length % 4 !== 0) return null;
  return { t, v1 };
}

// Webhook 验签：签名输入 = `${t}.${rawBody}`，RSA-SHA256，任一已配置公钥验过即可。
// publicKeys: [{ environment, pem }]，逐个尝试；验过的那把决定环境（权威，不信 payload.mode）。
export async function verifyWaffoWebhook(rawBody, signatureHeader, publicKeys, toleranceMs, now) {
  const parsed = parseWaffoSignatureHeader(signatureHeader);
  if (!parsed) return { valid: false, reason: "bad_signature_header" };

  const t = Number(parsed.t);
  if (!Number.isSafeInteger(t) || now - t > toleranceMs || t - now > WEBHOOK_FUTURE_TOLERANCE_MS) {
    return { valid: false, reason: "timestamp_out_of_tolerance" };
  }

  const signedInput = new TextEncoder().encode(`${parsed.t}.${rawBody}`);
  let signatureBytes;
  try {
    signatureBytes = base64ToArrayBuffer(parsed.v1);
  } catch {
    return { valid: false, reason: "bad_signature_encoding" };
  }

  for (const entry of publicKeys) {
    if (!entry?.pem) continue;
    try {
      const key = await crypto.subtle.importKey(
        "spki",
        pemToArrayBuffer(entry.pem),
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      const ok = await crypto.subtle.verify(
        { name: "RSASSA-PKCS1-v1_5" },
        key,
        signatureBytes,
        signedInput,
      );
      if (ok) return { valid: true, environment: entry.environment };
    } catch {
      // 单把公钥导入/验证异常不影响尝试其它公钥。
    }
  }
  return { valid: false, reason: "signature_mismatch" };
}

function collectWebhookPublicKeys(env) {
  const environment = configuredEnvironment(env);
  const pem = environment === "test" ? env.WAFFO_WEBHOOK_PUBLIC_KEY_TEST : env.WAFFO_WEBHOOK_PUBLIC_KEY_PROD;
  // Test 公钥不能被误配为 Prod；只验证当前部署环境，不跨环境尝试。
  if (!environment || !pem || (environment === "prod" && pem.replace(/\s/g, "") === String(env.WAFFO_WEBHOOK_PUBLIC_KEY_TEST || "").replace(/\s/g, ""))) return [];
  return [{ environment, pem }];
}

function configuredEnvironment(env) {
  return env.WAFFO_ENVIRONMENT === "test" || env.WAFFO_ENVIRONMENT === "prod" ? env.WAFFO_ENVIRONMENT : null;
}

// ---------------------------------------------------------- Event normalize

// 按事件类型归一化，不假设 payload.amount 一定存在（优先 chargedAmount）。
export function normalizeWaffoEvent(envelope) {
  const data = (envelope && typeof envelope === "object" && envelope.data) || {};
  const eventType = typeof envelope?.eventType === "string" ? envelope.eventType : "";
  return {
    eventType,
    deliveryId: typeof envelope?.id === "string" ? envelope.id : "",
    eventId: typeof envelope?.eventId === "string" ? envelope.eventId : "",
    storeId: typeof envelope?.storeId === "string" ? envelope.storeId : "",
    mode: envelope?.mode === "prod" ? "prod" : envelope?.mode === "test" ? "test" : "",
    order: {
      reference: pickString(data.orderMerchantExternalId),
      paymentId: pickString(data.paymentId),
      orderId: pickString(data.orderId),
      productId: pickString(data.productId),
      productName: pickString(data.productName),
      currency: typeof data.currency === "string" ? data.currency : "",
      // amount 在渠道未报实收时会回落原价，禁止用它补齐 chargedAmount。
      chargedAmount: typeof data.chargedAmount === "string" ? data.chargedAmount : null,
      listPrice: data.listPrice,
      orderStatus: pickString(data.orderStatus),
      paymentStatus: pickString(data.paymentStatus),
      paidAt: normalizePaidAt(data.paymentDate || data.paidAt || envelope?.timestamp),
      refundId: pickString(data.refundId),
    },
  };
}

function pickString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function normalizePaidAt(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    // Waffo 时间戳为毫秒；秒级值（10 位）做兜底换算。
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

// ------------------------------------------------------- Idempotency (KV)

async function alreadyHandledDelivery(env, deliveryId) {
  try {
    if (!env.WAFFO_EVENTS) return false;
    return (await env.WAFFO_EVENTS.get(`delivery:${deliveryId}`)) !== null;
  } catch (error) {
    // 本版只有观测日志，无权益副作用；KV 不可用允许重复日志，不能据此声称业务幂等。
    logEvent({ event: "waffo_kv_unavailable", reason: errorCode(error) });
    return false;
  }
}

async function markDeliveryHandled(env, deliveryId) {
  try {
    // 保留 60 天，覆盖 45 分钟重试窗口 + 充足冗余。
    await env.WAFFO_EVENTS?.put(`delivery:${deliveryId}`, "1", { expirationTtl: 60 * 24 * 3600 });
  } catch (error) {
    logEvent({ event: "waffo_kv_write_failed", reason: errorCode(error) });
  }
}

// --------------------------------------------------------------------- CORS

async function withCors(request, env, handler) {
  const origin = request.headers.get("Origin") || "";
  const allowed = allowedOrigins(env);
  const allowOrigin = allowed.includes(origin) ? origin : "";

  if (origin && !allowOrigin) return jsonResponse({ error: "origin not allowed" }, 403);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(allowOrigin) });
  }
  let response;
  try { response = await handler(); } catch (error) { response = requestFailure(error); }
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(allowOrigin))) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}

function allowedOrigins(env) {
  const configured = typeof env.WAFFO_ALLOWED_ORIGINS === "string" ? env.WAFFO_ALLOWED_ORIGINS : "";
  const list = configured.split(",").map(s => s.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_ALLOWED_ORIGINS;
}

function corsHeaders(allowOrigin) {
  const headers = {
    Vary: "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key",
    "Access-Control-Max-Age": "600",
  };
  if (allowOrigin) headers["Access-Control-Allow-Origin"] = allowOrigin;
  return headers;
}

// ------------------------------------------------------------------- utils

function bearerToken(request) {
  const authorization = request.headers.get("Authorization") || "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
}

function mapLanguage(value) {
  return typeof value === "string" && Object.hasOwn(LANGUAGE_MAP, value) ? LANGUAGE_MAP[value] : "en";
}

function httpsUrlOrNull(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

// checkout 固定调用 waffo_test RPC，入选测试用户由 RLS 限制；绝不回落生产 RPC 或 service_role。
function testBackendUrl(env) {
  if (env.WAFFO_ENVIRONMENT !== "test"
    || env.WAFFO_TEST_BACKEND !== "schema" || env.WAFFO_TEST_SCHEMA !== "waffo_test"
    || !/^[a-z0-9]{20}$/.test(env.WAFFO_TEST_PROJECT_REF || "") || !env.SUPABASE_ANON_KEY) return null;
  const expected = `https://${env.WAFFO_TEST_PROJECT_REF}.supabase.co`;
  return env.WAFFO_TEST_SUPABASE_URL === expected ? expected : null;
}

function testSuccessUrl(request, env) {
  const configured = httpsUrlOrNull(env.WAFFO_TEST_SUCCESS_ORIGIN);
  if (!configured) return null;
  const origin = new URL(configured).origin;
  return configured === `${origin}/` && env.WAFFO_TEST_SUCCESS_ORIGIN === origin
    && new URL(request.url).origin === origin ? `${origin}/test/done` : null;
}

// JWT 解析只作 fail-closed 预检；PostgREST 验签和数据库 role/RLS 才是权限边界。
function testRoleClaims(token, role) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
    const claims = JSON.parse(new TextDecoder().decode(base64ToArrayBuffer(parts[1])));
    const now = Math.floor(Date.now() / 1000);
    if (claims.role !== role || typeof claims.sub !== "string" || !UUID_PATTERN.test(claims.sub)
      || (role === "authenticated" && claims.aud !== "authenticated")
      || !Number.isSafeInteger(claims.exp) || claims.exp <= now
      || (role !== "authenticated" && claims.exp > now + 3600)
      || (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > now))) return null;
    return claims;
  } catch { return null; }
}

// ingest 身份 = 专用 GoTrue bot 的标准 authenticated access token；数据库按 ingest_principals 白名单授权。
// 每个 isolate 用 password grant 换 token 并缓存到过期前 60 秒；refresh token 直接丢弃，不存不记。
// ponytail: 每个 isolate 约每小时一次 grant（各留一条 auth.sessions）；需要更少会话时改 Durable Object 单写者轮换 refresh token。
const ingestTokens = new Map();

async function ingestAccessToken(env, url) {
  const email = env.WAFFO_TEST_INGEST_EMAIL;
  const password = env.WAFFO_TEST_INGEST_PASSWORD;
  const sub = String(env.WAFFO_TEST_INGEST_SUB || "").toLowerCase();
  if (!email || !password || !UUID_PATTERN.test(sub)) throw new Error("test ledger configuration unavailable");
  const key = `${url}|${email}|${sub}`;
  let entry = ingestTokens.get(key);
  const drop = () => { if (ingestTokens.get(key) === entry) ingestTokens.delete(key); };
  // 并发交付共享同一次 grant（single-flight）；失败立即清除，下次交付重试。
  if (!entry || entry.exp - 60 <= Math.floor(Date.now() / 1000)) {
    entry = { exp: Infinity, promise: null };
    entry.promise = (async () => {
      const response = await fetchWithTimeout(`${url}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { apikey: env.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const token = response.ok ? (await response.json().catch(() => null))?.access_token : null;
      const claims = typeof token === "string" ? testRoleClaims(token, "authenticated") : null;
      if (!claims || claims.sub.toLowerCase() !== sub) throw new Error("test ingest authentication failed");
      entry.exp = claims.exp;
      return token;
    })();
    ingestTokens.set(key, entry);
    entry.promise.catch(drop);
  }
  return { token: await entry.promise, drop };
}

async function recordTestEvent(env, normalized, rawBody) {
  const url = testBackendUrl(env);
  if (!url) throw new Error("test ledger configuration unavailable");
  const ingest = await ingestAccessToken(env, url);
  const order = normalized.order;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawBody));
  const completedValid = order.paymentStatus === "succeeded" && order.orderStatus === "completed"
    && env.WAFFO_CURRENCY === "CNY" && order.currency === "CNY"
    && /^PAY_[A-Za-z0-9]+$/.test(order.paymentId) && /^ORD_[A-Za-z0-9]+$/.test(order.orderId)
    && normalized.eventId === order.paymentId && UUID_PATTERN.test(order.reference)
    && validateWaffoAmounts(order).valid;
  const response = await fetchWithTimeout(`${url}/rest/v1/rpc/record_event`, {
    method: "POST",
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${ingest.token}`,
      "Content-Type": "application/json", "Content-Profile": "waffo_test" },
    body: JSON.stringify({
      p_mode: "test", p_store_id: normalized.storeId, p_event_type: normalized.eventType,
      p_event_id: normalized.eventId, p_delivery_id: normalized.deliveryId,
      p_order_id: /^ORD_[A-Za-z0-9]+$/.test(order.orderId) ? order.orderId : null,
      p_payment_id: /^PAY_[A-Za-z0-9]+$/.test(order.paymentId) ? order.paymentId : null,
      p_reference: UUID_PATTERN.test(order.reference) ? order.reference : null,
      p_body_sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join(""),
      // 观测代码限定 valid/invalid；引用缺失时由 RPC 归一为 unbound（见 schema.DRAFT.sql 约束）。
      p_observation_code: normalized.eventType === "order.completed" && !completedValid ? "invalid_observation" : "valid_observation",
    }),
  });
  // 401 = token 被 PostgREST 拒（过期/轮换）：丢弃缓存，Waffo 重试时重新换。
  // 403（bot 未登记/已禁用，42501）重换无用，不清缓存以免每次重试都新建会话。
  if (response.status === 401) ingest.drop();
  const payload = response.ok ? await response.json().catch(() => null) : null;
  const result = Array.isArray(payload) ? payload[0] : payload;
  if (result?.result !== "recorded" && result?.result !== "duplicate") throw new Error("test ledger persistence failed");
}

export function checkoutUrlOrNull(value) {
  const url = httpsUrlOrNull(value);
  return url && ["https://checkout.waffo.ai", "https://pancake.waffo.ai"].includes(new URL(url).origin) ? url : null;
}

async function sha256Base64(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return arrayBufferToBase64(digest);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function pemToArrayBuffer(value) {
  const base64 = String(value || "")
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s/g, "");
  return base64ToArrayBuffer(base64);
}

function base64ToArrayBuffer(value) {
  const binary = atob(String(value || "").replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export async function fetchWithTimeout(url, init, diagnostic, fetchImpl = (url, options) => fetch(url, options)) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    if (diagnostic) diagnostic.stage = "network";
    const response = await fetchImpl(url, { ...init, redirect: "manual", signal: controller.signal });
    if (diagnostic) {
      diagnostic.http_status = response.status;
      const mime = (response.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
      diagnostic.content_type = ["application/json", "text/plain", "text/html", "application/octet-stream"].includes(mime) ? mime : "other";
      diagnostic.stage = "body_read";
    }
    // workerd does not support redirect:"error". Never follow redirects with credentials.
    if (response.status >= 300 && response.status < 400) {
      if (diagnostic) diagnostic.stage = "http";
      await response.body?.cancel();
      throw intentError("intent_redirect");
    }
    // 超时覆盖响应体读取，不能收到 headers 就取消定时器。
    const body = await new Response(limitedBodyStream(response.body, diagnostic)).text();
    if (diagnostic) {
      diagnostic.stage = "response_reconstruction";
    }
    return new Response(body, { status: response.status, headers: response.headers });
  } catch (error) {
    if (diagnostic && controller.signal.aborted) diagnostic.stage = "timeout";
    if (diagnostic?.stage === "network") {
      // Match known runtime failures to constants, never emit exception text.
      const message = typeof error?.message === "string" ? error.message : "";
      const patterns = [
        ["Invalid redirect value", "intent_runtime_redirect"],
        ["Illegal invocation", "intent_runtime_invocation"],
        ["Invalid URL", "intent_runtime_url"],
        ["header", "intent_runtime_header"],
        ["Header", "intent_runtime_header"],
        ["signal", "intent_runtime_signal"],
        ["not defined", "intent_runtime_binding"],
      ];
      const match = patterns.find(([text]) => message.includes(text));
      if (match) error.intentCode = match[1];
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function limitedBodyStream(body, diagnostic) {
  if (diagnostic) diagnostic.body_bytes = 0;
  if (!body) return null;
  let bytes = 0;
  return body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (diagnostic) diagnostic.body_bytes = bytes;
      if (bytes > MAX_BODY_BYTES) {
        const error = new Error("body too large");
        error.code = "body_too_large";
        throw error;
      }
      controller.enqueue(chunk);
    },
  }));
}

function limitRequestBody(request) {
  return new Request(request, { body: limitedBodyStream(request.body), duplex: "half" });
}

function methodNotAllowed(methods) {
  return new Response("Method not allowed", {
    status: 405,
    headers: { Allow: methods.join(", ") },
  });
}

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function requestFailure(error) {
  logEvent({ event: "waffo_request_failed", reason: error?.code === "body_too_large" ? "body_too_large" : "request_failed" });
  return jsonResponse({ ok: false }, error?.code === "body_too_large" ? 413 : 503);
}

function errorCode(error) {
  return error instanceof Error && error.message ? error.message.slice(0, 120) : "unknown";
}

function logEvent(event) {
  console.log(JSON.stringify({ scope: "waffopay", ...event }));
}
