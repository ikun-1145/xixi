import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequestGet, onRequestHead } from '../functions/apk.js';

const asset = {
  name: 'sunland-ai-1.4.1+30.apk',
  size: 102201931,
  browser_download_url: 'https://github.example/sunland.apk',
};

const releaseResponse = () => new Response(
  JSON.stringify({ assets: [asset] }),
  { status: 200, headers: { 'Content-Type': 'application/json' } },
);

test('APK HEAD returns installable metadata instead of an HTML fallback', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(args);
    return releaseResponse();
  };

  try {
    const response = await onRequestHead({
      request: new Request('https://sunland.dev/apk', { method: 'HEAD' }),
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), 'application/vnd.android.package-archive');
    assert.equal(response.headers.get('Content-Length'), String(asset.size));
    assert.equal(response.headers.get('Accept-Ranges'), 'bytes');
    assert.match(response.headers.get('Content-Disposition'), /sunland-ai-1\.4\.1\+30\.apk/u);
    assert.equal(await response.text(), '');
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('APK range download forwards Range and preserves partial response headers', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(args);
    if (calls.length === 1) return releaseResponse();
    return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
      status: 206,
      headers: {
        'Content-Length': '4',
        'Content-Range': `bytes 0-3/${asset.size}`,
        'Accept-Ranges': 'bytes',
      },
    });
  };

  try {
    const response = await onRequestGet({
      request: new Request('https://sunland.dev/apk?v=1.4.1%2B30', {
        headers: { Range: 'bytes=0-3', 'If-Range': 'release-etag' },
      }),
    });

    const upstreamOptions = calls[1][1];
    assert.match(String(calls[0][0]), /releases\/tags\/v1\.4\.1%2B30$/u);
    assert.equal(upstreamOptions.headers.get('Range'), 'bytes=0-3');
    assert.equal(upstreamOptions.headers.get('If-Range'), 'release-etag');
    assert.equal(upstreamOptions.headers.get('Accept-Encoding'), 'identity');
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('Content-Range'), `bytes 0-3/${asset.size}`);
    assert.equal(response.headers.get('Content-Length'), '4');
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0x50, 0x4b, 0x03, 0x04]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('APK version URL selects the matching release asset only', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(args);
    if (calls.length === 1) {
      return new Response(JSON.stringify({
        assets: [
          { ...asset, name: 'sunland-ai-1.4.0+29.apk' },
          asset,
        ],
      }), { status: 200 });
    }
    return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
      status: 200,
      headers: { 'Content-Length': '4' },
    });
  };

  try {
    const response = await onRequestGet({
      request: new Request('https://sunland.dev/apk?v=1.4.1%2B30'),
    });

    assert.equal(response.status, 200);
    assert.equal(calls[1][0], asset.browser_download_url);
    assert.match(response.headers.get('Content-Disposition'), /sunland-ai-1\.4\.1\+30\.apk/u);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('APK proxy failures are not returned as successful install packages', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('unavailable', { status: 503 });

  try {
    const response = await onRequestGet({
      request: new Request('https://sunland.dev/apk'),
    });

    assert.equal(response.status, 502);
    assert.match(response.headers.get('Content-Type'), /^text\/html/u);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
