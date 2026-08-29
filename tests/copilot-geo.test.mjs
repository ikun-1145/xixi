import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequestGet, onRequestHead } from '../functions/copilot.js';

function contextFor(country, acceptLanguage = 'zh-CN,zh;q=0.9') {
  const request = new Request('https://sunland.dev/copilot', {
    headers: { 'accept-language': acceptLanguage },
  });
  Object.defineProperty(request, 'cf', { value: { country }, configurable: true });
  return {
    request,
    env: {
      ASSETS: {
        fetch: async () => new Response('existing copilot page', { status: 200 }),
      },
    },
  };
}

test('copilot blocks China mainland, Hong Kong, Macao, and Taiwan IP countries', async () => {
  for (const country of ['CN', 'HK', 'MO', 'TW', 'cn']) {
    const response = await onRequestGet(contextFor(country));
    const body = await response.text();

    assert.equal(response.status, 403, country);
    assert.match(body, /暂时无法访问/u, country);
    assert.match(body, /中国大陆、香港、澳门或台湾地区/u, country);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});

test('copilot serves the unchanged static page for non-blocked or unknown countries', async () => {
  for (const country of ['US', 'SG', null]) {
    const response = await onRequestGet(contextFor(country));
    assert.equal(response.status, 200, country || 'unknown');
    assert.equal(await response.text(), 'existing copilot page');
  }
});

test('blocked HEAD requests return the same access decision without a response body', async () => {
  const response = await onRequestHead(contextFor('TW', 'en-US,en;q=0.9'));

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
    const response = await onRequestGet(contextFor('CN', language));
    assert.match(await response.text(), new RegExp(expectedHeading, 'u'), language);
  }
});
