const BLOCKED_COUNTRIES = new Set(['CN', 'HK', 'MO', 'TW']);
const TENCENT_RCE_URL = 'https://rce.tencentcloudapi.com';
const TENCENT_RCE_HOST = 'rce.tencentcloudapi.com';
const TENCENT_RCE_SERVICE = 'rce';
const TENCENT_RCE_ACTION = 'ManageIPPortraitRisk';
const TENCENT_RCE_VERSION = '2025-04-25';
const TENCENT_RCE_REGION = 'ap-guangzhou';
const TENCENT_VPN_RISK_TYPE = 730014;
const VPN_LOOKUP_TIMEOUT_MS = 1_500;

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

const UNKNOWN_COUNTRY_COPY = {
  'zh-Hans': {
    lang: 'zh-Hans',
    title: '访问受限',
    heading: '暂时无法访问',
    message: '当前网络所在地区无法被可靠确认。为保障访问政策，本页面暂不开放。',
    hint: '请更换网络后重试。',
    home: '返回首页',
  },
  'zh-Hant': {
    lang: 'zh-Hant',
    title: '存取受限',
    heading: '暫時無法存取',
    message: '目前網路所在的地區無法被可靠確認。為保障存取政策，本頁面暫不開放。',
    hint: '請更換網路後重試。',
    home: '返回首頁',
  },
  en: {
    lang: 'en',
    title: 'Access restricted',
    heading: 'This page is temporarily unavailable',
    message: 'The region of the current network could not be reliably verified. This page is unavailable under the access policy.',
    hint: 'Please try again from a different network.',
    home: 'Back to home',
  },
  ja: {
    lang: 'ja',
    title: 'アクセス制限',
    heading: '現在このページにはアクセスできません',
    message: '現在のネットワークの地域を確実に確認できませんでした。アクセス方針により、このページはご利用いただけません。',
    hint: '別のネットワークからもう一度お試しください。',
    home: 'ホームに戻る',
  },
  ko: {
    lang: 'ko',
    title: '접근 제한',
    heading: '현재 이 페이지에 접근할 수 없습니다',
    message: '현재 네트워크의 지역을 신뢰할 수 있게 확인할 수 없습니다. 접근 정책에 따라 이 페이지는 이용할 수 없습니다.',
    hint: '다른 네트워크에서 다시 시도해 주세요.',
    home: '홈으로 돌아가기',
  },
  es: {
    lang: 'es',
    title: 'Acceso restringido',
    heading: 'Esta página no está disponible temporalmente',
    message: 'No se pudo verificar de forma fiable la región de la red actual. Esta página no está disponible según la política de acceso.',
    hint: 'Inténtalo de nuevo desde otra red.',
    home: 'Volver al inicio',
  },
};

function getBlockPageCopy(request, reason = 'restricted') {
  const acceptLanguage = String(request.headers?.get?.('accept-language') || '').toLowerCase();
  const locale = /(zh-(?:tw|hk|mo)|zh-hant)/u.test(acceptLanguage)
    ? 'zh-Hant'
    : acceptLanguage.startsWith('en')
      ? 'en'
      : acceptLanguage.startsWith('ja')
        ? 'ja'
        : acceptLanguage.startsWith('ko')
          ? 'ko'
          : acceptLanguage.startsWith('es')
            ? 'es'
            : 'zh-Hans';
  return reason === 'unknown' ? UNKNOWN_COUNTRY_COPY[locale] : BLOCK_PAGE_COPY[locale];
}

function getRequestCountry(request) {
  const country = String(request.cf?.country || '').toUpperCase();
  return country || null;
}

function getClientIp(request) {
  const clientIp = String(request.headers?.get?.('cf-connecting-ip') || '').trim();
  const octets = clientIp.split('.');
  if (octets.length !== 4 || octets.some((octet) => (
    !/^\d{1,3}$/u.test(octet) || Number(octet) > 255
  ))) return null;
  return clientIp;
}

function isConfirmedVpn(payload) {
  const data = payload?.Response?.Data;
  return data?.Code === 0
    && Array.isArray(data?.Value?.RiskType)
    && data.Value.RiskType.some((riskType) => Number(riskType) === TENCENT_VPN_RISK_TYPE);
}

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return bytesToHex(digest);
}

async function hmacSha256(key, value) {
  const keyBytes = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(value));
}

async function hmacSha256Hex(key, value) {
  return bytesToHex(await hmacSha256(key, value));
}

async function createTencentAuthorization(body, timestamp, secretId, secretKey) {
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${TENCENT_RCE_HOST}\n`;
  const signedHeaders = 'content-type;host';
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    await sha256Hex(body),
  ].join('\n');
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const credentialScope = `${date}/${TENCENT_RCE_SERVICE}/tc3_request`;
  const stringToSign = [
    'TC3-HMAC-SHA256',
    String(timestamp),
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');
  const secretDate = await hmacSha256(`TC3${secretKey}`, date);
  const secretService = await hmacSha256(secretDate, TENCENT_RCE_SERVICE);
  const secretSigning = await hmacSha256(secretService, 'tc3_request');
  const signature = await hmacSha256Hex(secretSigning, stringToSign);

  return `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

async function isVpnExitNode(context) {
  const secretId = String(context.env?.COPILOT_TENCENT_SECRET_ID || '').trim();
  const secretKey = String(context.env?.COPILOT_TENCENT_SECRET_KEY || '').trim();
  const clientIp = getClientIp(context.request);
  if (!secretId || !secretKey || !clientIp) return false;

  const timestamp = Math.floor(Date.now() / 1000);
  const channel = Number(context.env?.COPILOT_TENCENT_CHANNEL || 2);
  const payload = JSON.stringify({
    PostTime: timestamp,
    BusinessSecurityData: {
      UserIp: clientIp,
      Channel: Number.isInteger(channel) && channel >= 1 && channel <= 4 ? channel : 2,
    },
  });
  const fetchImpl = typeof context.env?.COPILOT_VPN_FETCH === 'function'
    ? context.env.COPILOT_VPN_FETCH
    : fetch;

  let response;
  try {
    response = await fetchImpl(TENCENT_RCE_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json; charset=utf-8',
        'x-tc-action': TENCENT_RCE_ACTION,
        'x-tc-region': TENCENT_RCE_REGION,
        'x-tc-version': TENCENT_RCE_VERSION,
        'x-tc-timestamp': String(timestamp),
        authorization: await createTencentAuthorization(payload, timestamp, secretId, secretKey),
      },
      body: payload,
      signal: AbortSignal.timeout(VPN_LOOKUP_TIMEOUT_MS),
    });
  } catch {
    return false;
  }
  if (!response?.ok) return false;

  try {
    return isConfirmedVpn(await response.json());
  } catch {
    return false;
  }
}

function blockedPage(request, { headOnly = false, reason = 'restricted' } = {}) {
  const copy = getBlockPageCopy(request, reason);
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

async function handleCopilotRequest(context, options) {
  const country = getRequestCountry(context.request);
  if (!country) return blockedPage(context.request, { ...options, reason: 'unknown' });
  if (BLOCKED_COUNTRIES.has(country) && !(await isVpnExitNode(context))) {
    return blockedPage(context.request, options);
  }
  return serveStaticAsset(context);
}

export function onRequestGet(context) {
  return handleCopilotRequest(context);
}

export function onRequestHead(context) {
  return handleCopilotRequest(context, { headOnly: true });
}
