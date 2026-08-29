import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequestGet, onRequestHead } from '../functions/copilot.js';
import {
  onRequestGet as onRequestHtmlGet,
  onRequestHead as onRequestHtmlHead,
} from '../functions/copilot.html.js';

function contextFor(country, {
  acceptLanguage = 'zh-CN,zh;q=0.9',
  clientIp = '203.0.113.10',
  vpnFetch,
  token = '',
} = {}) {
  const request = new Request('https://sunland.dev/copilot', {
    headers: {
      'accept-language': acceptLanguage,
      ...(clientIp ? { 'cf-connecting-ip': clientIp } : {}),
    },
  });
  Object.defineProperty(request, 'cf', { value: { country }, configurable: true });
  const context = {
    request,
    env: {
      ASSETS: {
        fetch: async () => new Response('existing copilot page', { status: 200 }),
      },
      ...(token ? {
        COPILOT_TENCENT_SECRET_ID: 'test-secret-id',
        COPILOT_TENCENT_SECRET_KEY: token,
      } : {}),
    },
  };
  if (vpnFetch) context.env.COPILOT_VPN_FETCH = vpnFetch;
  return context;
}

test('copilot blocks restricted countries when VPN verification is not configured', async () => {
  for (const country of ['CN', 'HK', 'MO', 'TW', 'cn']) {
    const response = await onRequestGet(contextFor(country));
    const body = await response.text();

    assert.equal(response.status, 403, country);
    assert.match(body, /暂时无法访问/u, country);
    assert.match(body, /中国大陆、香港、澳门或台湾地区/u, country);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});

test('copilot allows restricted countries only after the server confirms a VPN exit node', async () => {
  const calls = [];
  for (const country of ['CN', 'HK', 'MO', 'TW']) {
    const response = await onRequestGet(contextFor(country, {
      token: 'test-token',
      vpnFetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({
          Response: {
            Data: {
              Code: 0,
              Value: { RiskType: [730014] },
            },
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    }));

    assert.equal(response.status, 200, country || 'unknown');
    assert.equal(await response.text(), 'existing copilot page');
  }
  assert.equal(calls.length, 4);
  assert.ok(calls.every(({ url }) => url === 'https://rce.tencentcloudapi.com'));
  assert.ok(calls.every(({ init }) => init.method === 'POST'));
  assert.ok(calls.every(({ init }) => init.headers.accept === 'application/json'));
  assert.ok(calls.every(({ init }) => init.headers['content-type'] === 'application/json; charset=utf-8'));
  assert.ok(calls.every(({ init }) => init.headers['x-tc-action'] === 'ManageIPPortraitRisk'));
  assert.ok(calls.every(({ init }) => init.headers['x-tc-region'] === 'ap-guangzhou'));
  assert.ok(calls.every(({ init }) => init.headers['x-tc-version'] === '2025-04-25'));
  assert.ok(calls.every(({ init }) => init.headers.authorization.startsWith('TC3-HMAC-SHA256 ')));
  assert.ok(calls.every(({ init }) => JSON.parse(init.body).BusinessSecurityData.UserIp === '203.0.113.10'));
});

test('copilot keeps non-VPN restricted traffic blocked, including provider failures', async () => {
  const responses = [
    { Response: { Data: { Code: 0, Value: { RiskType: [] } } } },
    { Response: { Data: { Code: 0, Value: { RiskType: [730004] } } } },
    new Response('provider failure', { status: 503 }),
    null,
  ];

  for (const vpnResponse of responses) {
    const response = await onRequestGet(contextFor('CN', {
      token: 'test-token',
      vpnFetch: async () => {
        if (vpnResponse instanceof Response) return vpnResponse;
        if (vpnResponse === null) throw new Error('provider unavailable');
        return new Response(JSON.stringify(vpnResponse), { status: 200 });
      },
    }));
    assert.equal(response.status, 403);
  }
});

test('copilot fails closed when the client IP is unavailable or the VPN response is not valid JSON', async () => {
  const missingIp = await onRequestGet(contextFor('CN', {
    token: 'test-token',
    clientIp: '',
    vpnFetch: async () => new Response(JSON.stringify({
      Response: { Data: { Code: 0, Value: { RiskType: [730014] } } },
    }), { status: 200 }),
  }));
  assert.equal(missingIp.status, 403);

  const invalidJson = await onRequestGet(contextFor('CN', {
    token: 'test-token',
    vpnFetch: async () => new Response('not json', { status: 200 }),
  }));
  assert.equal(invalidJson.status, 403);
});

test('copilot does not trust a browser-supplied forwarding header as the client IP', async () => {
  const context = contextFor('CN', {
    token: 'test-token',
    clientIp: '',
    vpnFetch: async () => new Response(JSON.stringify({
      Response: { Data: { Code: 0, Value: { RiskType: [730014] } } },
    }), { status: 200 }),
  });
  context.request.headers.set('x-forwarded-for', '203.0.113.10');

  const response = await onRequestGet(context);

  assert.equal(response.status, 403);
});

test('copilot does not query the VPN provider for non-restricted countries', async () => {
  let calls = 0;
  for (const country of ['US', 'SG']) {
    const response = await onRequestGet(contextFor(country, {
      token: 'test-token',
      vpnFetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({
          Response: { Data: { Code: 0, Value: { RiskType: [] } } },
        }), { status: 200 });
      },
    }));
    assert.equal(response.status, 200, country);
    assert.equal(await response.text(), 'existing copilot page');
  }
  assert.equal(calls, 0);
});

test('copilot.html uses the same server-side access gate', async () => {
  const getResponse = await onRequestHtmlGet(contextFor('CN'));
  const headResponse = await onRequestHtmlHead(contextFor('CN'));

  assert.equal(getResponse.status, 403);
  assert.equal(headResponse.status, 403);
  assert.equal(await headResponse.text(), '');
});

test('copilot blocks unknown countries instead of allowing an unverified request through', async () => {
  const response = await onRequestGet(contextFor(null, {
    token: 'test-token',
    vpnFetch: async () => new Response(JSON.stringify({
      Response: { Data: { Code: 0, Value: { RiskType: [730014] } } },
    }), { status: 200 }),
  }));

  assert.equal(response.status, 403);
  assert.match(await response.text(), /无法被可靠确认/u);
});

test('blocked HEAD requests return the same access decision without a response body', async () => {
  const response = await onRequestHead(contextFor('TW', { acceptLanguage: 'en-US,en;q=0.9' }));

  assert.equal(response.status, 403);
  assert.equal(await response.text(), '');
  assert.equal(response.headers.get('content-language'), 'en');
});

test('blocked page copy follows the browser language for supported locales', async () => {
  const cases = [
    ['zh-TW', '暫時無法存取'],
    ['ja-JP', '現在このページにはアクセスできません'],
    ['ko-KR', '현재 이 페이지에 접근할 수 없습니다'],
    ['es-ES', 'Esta página no está disponible temporalmente'],
  ];

  for (const [language, expectedHeading] of cases) {
    const response = await onRequestGet(contextFor('CN', { acceptLanguage: language }));
    assert.match(await response.text(), new RegExp(expectedHeading, 'u'), language);
  }
});
