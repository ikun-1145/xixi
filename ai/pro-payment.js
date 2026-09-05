(function (global) {
  "use strict";

  const PLAN_ID = "4c2527fc6c7411f1bbe45254001e7c00";
  const CHECKOUT_URL = "https://afdian.com/order/create";
  const SUPPORT_URL = "pro_activation_support.html";
  const PENDING_PREFIX = "sunland:pro-payment-pending:";
  const SHORT_POLL_WINDOW_MS = 3 * 60 * 1000;
  const SUPPORT_WINDOW_MS = 10 * 60 * 1000;
  const SHORT_POLL_INTERVAL_MS = 3 * 1000;
  const LONG_POLL_INTERVAL_MS = 15 * 1000;
  const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9@._+-]{0,127}$/;
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  let activeMonitoring = null;

  const COPY = {
    zh: {
      confirmation: "即将前往爱发电支付。请选择 ¥10 月付；付款成功后将自动开通永久 Pro，多选月份不会增加权益。确认前往支付？",
      identityError: "身份验证失败，请重新登录后再试。",
      popupError: "无法打开支付窗口，请允许此网站打开新窗口后重试。",
      intentError: "暂时无法创建安全付款引用，未进入支付页，请稍后重试。",
      processing: "已打开支付页。付款成功后会自动检查到账状态。",
      alreadyActivated: "你的 Pro 已开通，无需重复付款。",
      activated: "支付成功，Pro 已开通。",
      pending: "正在等待付款到账。",
      supportHint: "已等待 10 分钟仍未到账？请准备订单信息后联系支持。",
      supportLink: "Pro 到账申诉",
      loginRequired: "请先登录后再开通 Pro。",
    },
    "zh-Hant": {
      confirmation: "即將前往愛發電付款。請選擇 ¥10 月付；付款成功後會自動開通永久 Pro，多選月份不會增加權益。確認前往付款？",
      identityError: "身分驗證失敗，請重新登入後再試。",
      popupError: "無法開啟付款視窗，請允許此網站開啟新視窗後重試。",
      intentError: "暫時無法建立安全付款參考，尚未進入付款頁，請稍後重試。",
      processing: "已開啟付款頁。付款成功後會自動檢查到帳狀態。",
      alreadyActivated: "你的 Pro 已開通，無須重複付款。",
      activated: "付款成功，Pro 已開通。",
      pending: "正在等待付款到帳。",
      supportHint: "等待 10 分鐘仍未到帳？請準備訂單資料後聯絡支援。",
      supportLink: "Pro 到帳申訴",
      loginRequired: "請先登入後再開通 Pro。",
    },
    en: {
      confirmation: "You will be taken to Afdian. Choose the ¥10 monthly option; successful payment unlocks permanent Pro, and extra months add no benefits. Continue?",
      identityError: "Identity verification failed. Please sign in again and retry.",
      popupError: "The payment window could not be opened. Allow pop-ups for this site and try again.",
      intentError: "A secure payment reference could not be created. You have not entered checkout; please try again later.",
      processing: "Checkout is open. Your entitlement will be checked automatically after payment.",
      alreadyActivated: "Pro is already active. No further payment is needed.",
      activated: "Payment received. Pro is active.",
      pending: "Waiting for payment confirmation.",
      supportHint: "Still not active after 10 minutes? Prepare your order details and contact support.",
      supportLink: "Pro activation support",
      loginRequired: "Please sign in before upgrading to Pro.",
    },
    ja: {
      confirmation: "愛発電の決済ページを開きます。¥10 の月額プランを選んでください。決済後は永久 Pro が有効になり、月数を増やしても特典は増えません。続けますか？",
      identityError: "本人確認に失敗しました。再ログインしてからやり直してください。",
      popupError: "決済ウィンドウを開けませんでした。このサイトのポップアップを許可して再試行してください。",
      intentError: "安全な決済参照を作成できませんでした。決済ページには進んでいません。後でもう一度お試しください。",
      processing: "決済ページを開きました。決済後に自動で有効化状態を確認します。",
      alreadyActivated: "Pro はすでに有効です。追加の支払いは不要です。",
      activated: "支払いを確認しました。Pro が有効になりました。",
      pending: "支払い確認を待っています。",
      supportHint: "10 分待っても有効にならない場合は、注文情報を用意してサポートへご連絡ください。",
      supportLink: "Pro 有効化サポート",
      loginRequired: "Pro にアップグレードする前にログインしてください。",
    },
    ko: {
      confirmation: "Afdian 결제 페이지로 이동합니다. ¥10 월간 옵션을 선택하세요. 결제에 성공하면 영구 Pro가 활성화되며, 여러 달을 선택해도 혜택은 늘어나지 않습니다. 계속할까요?",
      identityError: "신원 확인에 실패했습니다. 다시 로그인한 후 시도하세요.",
      popupError: "결제 창을 열 수 없습니다. 이 사이트의 팝업을 허용한 후 다시 시도하세요.",
      intentError: "안전한 결제 참조를 만들 수 없습니다. 결제 페이지로 이동하지 않았습니다. 나중에 다시 시도하세요.",
      processing: "결제 페이지를 열었습니다. 결제 후 자동으로 활성화 상태를 확인합니다.",
      alreadyActivated: "Pro가 이미 활성화되어 있습니다. 추가 결제가 필요하지 않습니다.",
      activated: "결제가 확인되었습니다. Pro가 활성화되었습니다.",
      pending: "결제 확인을 기다리고 있습니다.",
      supportHint: "10분 후에도 활성화되지 않으면 주문 정보를 준비해 지원팀에 문의하세요.",
      supportLink: "Pro 활성화 지원",
      loginRequired: "Pro로 업그레이드하기 전에 로그인하세요.",
    },
    es: {
      confirmation: "Irás a Afdian. Elige la opción mensual de ¥10; tras el pago se activa Pro permanente y añadir meses no aumenta los beneficios. ¿Continuar?",
      identityError: "La verificación de identidad falló. Vuelve a iniciar sesión e inténtalo de nuevo.",
      popupError: "No se pudo abrir la ventana de pago. Permite las ventanas emergentes para este sitio e inténtalo de nuevo.",
      intentError: "No se pudo crear una referencia de pago segura. No has entrado al pago; inténtalo más tarde.",
      processing: "La página de pago está abierta. Comprobaremos tu acceso automáticamente después del pago.",
      alreadyActivated: "Pro ya está activo. No necesitas pagar otra vez.",
      activated: "Pago recibido. Pro está activo.",
      pending: "Esperando la confirmación del pago.",
      supportHint: "¿Sigue sin activarse tras 10 minutos? Prepara los datos del pedido y contacta con soporte.",
      supportLink: "Soporte de activación Pro",
      loginRequired: "Inicia sesión antes de actualizar a Pro.",
    },
  };

  function language() {
    const selected = global.SiteI18n?.getLanguage?.();
    return COPY[selected] ? selected : "zh";
  }

  function text(key) {
    return COPY[language()]?.[key] || COPY.zh[key] || key;
  }

  function decodeJwt(token) {
    if (typeof token !== "string") return null;
    const part = token.split(".")[1];
    if (!part) return null;
    try {
      const padded = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
      return JSON.parse(decodeURIComponent(Array.from(atob(padded), char => `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`).join("")));
    } catch {
      return null;
    }
  }

  async function getVerifiedDatabaseIdentity(expectedUserId = null) {
    const token = await global.SunlandDatabaseToken?.get?.();
    const payload = decodeJwt(token);
    const audience = Array.isArray(payload?.aud) ? payload.aud : [payload?.aud];
    const userId = typeof payload?.id === "string" ? payload.id : "";
    const valid = payload?.role === "authenticated"
      && audience.includes("authenticated")
      && USER_ID_PATTERN.test(userId)
      && Number(payload?.exp) > Math.floor(Date.now() / 1000);
    if (!valid || (expectedUserId && userId !== expectedUserId)) {
      throw new Error(text("identityError"));
    }
    return { userId };
  }

  function pendingKey(userId) {
    return `${PENDING_PREFIX}${userId}`;
  }

  function savePending(userId, paymentReference) {
    const pending = { paymentReference, startedAt: Date.now() };
    global.localStorage?.setItem(pendingKey(userId), JSON.stringify(pending));
    return pending;
  }

  function getPending(userId) {
    if (!USER_ID_PATTERN.test(userId || "")) return null;
    try {
      const parsed = JSON.parse(global.localStorage?.getItem(pendingKey(userId)) || "null");
      if (!UUID_PATTERN.test(parsed?.paymentReference || "") || !Number.isFinite(parsed?.startedAt)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function clearPending(userId) {
    if (USER_ID_PATTERN.test(userId || "")) global.localStorage?.removeItem(pendingKey(userId));
  }

  function closePopup(popup) {
    try { popup?.close?.(); } catch { /* no-op */ }
  }

  function openPlaceholder() {
    try {
      const popup = global.open?.("", "_blank");
      if (popup) {
        try { popup.opener = null; } catch { /* no-op */ }
      }
      return popup || null;
    } catch {
      return null;
    }
  }

  function unpackIntent(data) {
    const intent = Array.isArray(data) ? data[0] : data;
    if (!intent || typeof intent !== "object" || !UUID_PATTERN.test(intent.payment_reference || "")) {
      throw new Error(text("intentError"));
    }
    return intent;
  }

  function buildCheckoutUrl(paymentReference) {
    const url = new URL(CHECKOUT_URL);
    url.searchParams.set("product_type", "0");
    url.searchParams.set("plan_id", PLAN_ID);
    url.searchParams.set("custom_order_id", paymentReference);
    return url.toString();
  }

  async function beginCheckout({ supabase, expectedUserId = null, isExpectedUser = null } = {}) {
    const popup = openPlaceholder();
    if (!popup) throw new Error(text("popupError"));

    try {
      const identity = await getVerifiedDatabaseIdentity(expectedUserId);
      if (typeof isExpectedUser === "function" && !isExpectedUser(identity.userId)) {
        throw new Error(text("identityError"));
      }
      if (!supabase?.rpc) throw new Error(text("intentError"));

      const { data, error } = await supabase.rpc("sunland_get_or_create_pro_payment_intent");
      if (error) throw new Error(text("intentError"));
      const intent = unpackIntent(data);

      if (typeof isExpectedUser === "function" && !isExpectedUser(identity.userId)) {
        throw new Error(text("identityError"));
      }
      if (intent.status === "activated") {
        clearPending(identity.userId);
        closePopup(popup);
        return { alreadyActivated: true, userId: identity.userId };
      }

      savePending(identity.userId, intent.payment_reference);
      popup.location.replace(buildCheckoutUrl(intent.payment_reference));
      return { paymentReference: intent.payment_reference, userId: identity.userId };
    } catch (error) {
      closePopup(popup);
      throw error instanceof Error ? error : new Error(text("intentError"));
    }
  }

  function stopActivationMonitoring() {
    if (!activeMonitoring) return;
    global.clearTimeout?.(activeMonitoring.timer);
    global.removeEventListener?.("visibilitychange", activeMonitoring.onVisibilityChange);
    activeMonitoring = null;
  }

  function startActivationMonitoring({ supabase, getExpectedUserId, onActivated, onTimeout } = {}) {
    stopActivationMonitoring();
    const userId = typeof getExpectedUserId === "function" ? getExpectedUserId() : null;
    const pending = getPending(userId);
    if (!supabase?.from || !pending || !userId) return stopActivationMonitoring;

    const state = { timer: null, running: false, onVisibilityChange: null };
    activeMonitoring = state;

    const stopIfCurrent = () => {
      if (activeMonitoring === state) stopActivationMonitoring();
    };
    const tick = async () => {
      if (activeMonitoring !== state || state.running) return;
      if (typeof getExpectedUserId !== "function" || getExpectedUserId() !== userId) {
        stopIfCurrent();
        return;
      }
      state.running = true;
      try {
        const { data } = await supabase
          .from("user_profiles")
          .select("pro")
          .eq("user_id", userId)
          .maybeSingle();
        if (activeMonitoring !== state || getExpectedUserId() !== userId) return;
        if (data?.pro) {
          clearPending(userId);
          stopIfCurrent();
          onActivated?.({ userId });
          return;
        }
      } catch {
        // Temporary read failures never mean the payment failed; the next poll and server reconciliation remain active.
      } finally {
        state.running = false;
      }

      if (activeMonitoring !== state) return;
      const elapsed = Date.now() - pending.startedAt;
      if (elapsed >= SUPPORT_WINDOW_MS) {
        stopIfCurrent();
        onTimeout?.({ userId, supportUrl: SUPPORT_URL });
        return;
      }
      const delay = elapsed < SHORT_POLL_WINDOW_MS ? SHORT_POLL_INTERVAL_MS : LONG_POLL_INTERVAL_MS;
      state.timer = global.setTimeout?.(tick, delay);
    };

    state.onVisibilityChange = () => {
      if (global.document?.visibilityState === "visible") void tick();
    };
    global.addEventListener?.("visibilitychange", state.onVisibilityChange);
    void tick();
    return stopIfCurrent;
  }

  global.SunlandProPayment = {
    PLAN_ID,
    SUPPORT_URL,
    text,
    getVerifiedDatabaseIdentity,
    beginCheckout,
    getPending,
    clearPending,
    startActivationMonitoring,
    stopActivationMonitoring,
  };
})(window);
