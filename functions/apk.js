const REPO = 'ikun-1145/sunland-ai-dart';
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

export async function onRequestGet({ request }) {
  const cache = caches.default;
  const cacheKey = new Request(new URL('/apk-meta', request.url).toString());

  // Try serving resolved APK URL from cache
  const cached = await cache.match(cacheKey);
  if (cached) {
    const { url, name, size } = await cached.json();
    return proxyApk(url, name, size);
  }

  // Fetch latest release info from GitHub
  const apiResp = await fetch(API_URL, {
    headers: {
      'User-Agent': 'SunlandAI-Pages/1.0',
      'Accept': 'application/vnd.github+json',
    },
  });

  if (!apiResp.ok) {
    return new Response('获取版本信息失败，请稍后重试', { status: 502 });
  }

  const release = await apiResp.json();
  const asset = release.assets && release.assets.find(a => a.name.endsWith('.apk'));

  if (!asset) {
    return new Response('暂无可下载的安装包', { status: 404 });
  }

  // Cache the resolved metadata for 1 hour so we don't hammer the GitHub API
  const meta = { url: asset.browser_download_url, name: asset.name, size: asset.size };
  const cacheResp = new Response(JSON.stringify(meta), {
    headers: { 'Cache-Control': 'public, max-age=3600', 'Content-Type': 'application/json' },
  });
  await cache.put(cacheKey, cacheResp);

  return proxyApk(asset.browser_download_url, asset.name, asset.size);
}

async function proxyApk(url, name, size) {
  const apkResp = await fetch(url);
  if (!apkResp.ok) {
    return new Response('下载失败，请稍后重试', { status: 502 });
  }

  return new Response(apkResp.body, {
    headers: {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Content-Length': String(size),
      'Cache-Control': 'no-store',
    },
  });
}
