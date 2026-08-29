const BLOCKED_COUNTRIES = new Set(['CN', 'HK', 'MO', 'TW']);

const BLOCK_PAGE_COPY = {
  'zh-Hans': {
    lang: 'zh-Hans',
    title: '访问受限',
    heading: '暂时无法访问',
    message: '当前访问 IP 被识别为中国大陆、香港、澳门或台湾地区。护福宝暂不向上述地区提供服务。',
    hint: '如你认为这是误判，请更换网络后重试。',
    home: '返回首页',
  },
  'zh-Hant': {
    lang: 'zh-Hant',
    title: '存取受限',
    heading: '暫時無法存取',
    message: '目前存取 IP 被辨識為中國大陸、香港、澳門或台灣地區。護福寶暫不向上述地區提供服務。',
    hint: '如果你認為這是誤判，請更換網路後重試。',
    home: '返回首頁',
  },
  en: {
    lang: 'en',
    title: 'Access restricted',
    heading: 'This page is temporarily unavailable',
    message: 'The IP address used for this request was identified as being in Mainland China, Hong Kong, Macao, or Taiwan. HuFuBao is currently unavailable in these regions.',
    hint: 'If this looks incorrect, try again from a different network.',
    home: 'Back to home',
  },
  ja: {
    lang: 'ja',
    title: 'アクセス制限',
    heading: '現在このページにはアクセスできません',
    message: 'このアクセスの IP アドレスは、中国本土、香港、マカオ、または台湾にあると判定されました。HuFuBao は現在、これらの地域ではご利用いただけません。',
    hint: '誤判定と思われる場合は、別のネットワークからもう一度お試しください。',
    home: 'ホームに戻る',
  },
  ko: {
    lang: 'ko',
    title: '접근 제한',
    heading: '현재 이 페이지에 접근할 수 없습니다',
    message: '이번 요청의 IP 주소가 중국 본토, 홍콩, 마카오 또는 대만에 있는 것으로 확인되었습니다. HuFuBao는 현재 해당 지역에서 이용할 수 없습니다.',
    hint: '오인으로 보인다면 다른 네트워크에서 다시 시도해 주세요.',
    home: '홈으로 돌아가기',
  },
  es: {
    lang: 'es',
    title: 'Acceso restringido',
    heading: 'Esta página no está disponible temporalmente',
    message: 'La dirección IP utilizada para esta solicitud fue identificada como ubicada en China continental, Hong Kong, Macao o Taiwán. HuFuBao no está disponible actualmente en estas regiones.',
    hint: 'Si crees que se trata de un error, inténtalo de nuevo desde otra red.',
    home: 'Volver al inicio',
  },
};

function getBlockPageCopy(request) {
  const acceptLanguage = String(request.headers?.get?.('accept-language') || '').toLowerCase();
  if (/(zh-(?:tw|hk|mo)|zh-hant)/u.test(acceptLanguage)) return BLOCK_PAGE_COPY['zh-Hant'];
  if (acceptLanguage.startsWith('en')) return BLOCK_PAGE_COPY.en;
  if (acceptLanguage.startsWith('ja')) return BLOCK_PAGE_COPY.ja;
  if (acceptLanguage.startsWith('ko')) return BLOCK_PAGE_COPY.ko;
  if (acceptLanguage.startsWith('es')) return BLOCK_PAGE_COPY.es;
  return BLOCK_PAGE_COPY['zh-Hans'];
}

function isBlockedRequest(request) {
  const country = String(request.cf?.country || '').toUpperCase();
  return BLOCKED_COUNTRIES.has(country);
}

function blockedPage(request, { headOnly = false } = {}) {
  const copy = getBlockPageCopy(request);
  const body = headOnly ? null : `<!doctype html>
<html lang="${copy.lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${copy.title}</title>
  <style>
    :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #10131d; color: #f5f7fb; }
    body { box-sizing: border-box; display: grid; min-height: 100vh; margin: 0; padding: 24px; place-items: center; }
    .card { width: min(100%, 560px); box-sizing: border-box; padding: clamp(28px, 7vw, 56px); border: 1px solid #293042; border-radius: 20px; background: #171b27; text-align: center; }
    h1 { margin: 0; color: #71f8fc; font-size: clamp(1.6rem, 5vw, 2.25rem); line-height: 1.25; }
    p { margin: 18px 0 0; color: #c8cedd; font-size: 1rem; line-height: 1.75; }
    .hint { color: #929bad; font-size: .9rem; }
    a { display: inline-block; margin-top: 28px; color: #71f8fc; font-weight: 600; }
  </style>
</head>
<body>
  <main class="card">
    <h1>${copy.heading}</h1>
    <p>${copy.message}</p>
    <p class="hint">${copy.hint}</p>
    <a href="/">${copy.home}</a>
  </main>
</body>
</html>`;

  return new Response(body, {
    status: 403,
    headers: {
      'Content-Type': 'text/html; charset=UTF-8',
      'Content-Language': copy.lang,
      'Cache-Control': 'no-store',
      'Vary': 'Accept-Language',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    },
  });
}

function serveStaticAsset(context) {
  if (typeof context.env?.ASSETS?.fetch === 'function') {
    return context.env.ASSETS.fetch(context.request);
  }
  if (typeof context.next === 'function') return context.next();
  return new Response('Static asset binding is unavailable.', {
    status: 500,
    headers: {
      'Content-Type': 'text/plain; charset=UTF-8',
      'Cache-Control': 'no-store',
    },
  });
}

function handleCopilotRequest(context, options) {
  if (isBlockedRequest(context.request)) return blockedPage(context.request, options);
  return serveStaticAsset(context);
}

export function onRequestGet(context) {
  return handleCopilotRequest(context);
}

export function onRequestHead(context) {
  return handleCopilotRequest(context, { headOnly: true });
}
