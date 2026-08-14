const REPO = 'ikun-1145/sunland-ai-dart';
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const APK_CONTENT_TYPE = 'application/vnd.android.package-archive';

export async function onRequestGet({ request }) {
  return handleApkRequest(request);
}

export async function onRequestHead({ request }) {
  return handleApkRequest(request, { headOnly: true });
}

async function handleApkRequest(request, { headOnly = false } = {}) {
  try {
    const requestedVersion = new URL(request.url).searchParams.get('v');
    if (requestedVersion && !/^\d+\.\d+\.\d+\+\d+$/u.test(requestedVersion)) {
      return errorPage('下载版本参数无效', 400);
    }
    const releaseApiUrl = requestedVersion
      ? `https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(`v${requestedVersion}`)}`
      : API_URL;

    // 1. Get latest release metadata from GitHub API
    const apiResp = await fetch(releaseApiUrl, {
      headers: {
        'User-Agent': 'SunlandAI-Pages/1.0',
        'Accept': 'application/vnd.github+json',
      },
    });

    if (!apiResp.ok) {
      return errorPage(`GitHub API 返回 ${apiResp.status}，请稍后重试`, 502);
    }

    const release = await apiResp.json();
    const expectedAssetName = requestedVersion
      ? `sunland-ai-${requestedVersion}.apk`
      : null;
    const asset = release.assets && release.assets.find(a => (
      expectedAssetName ? a.name === expectedAssetName : a.name.endsWith('.apk')
    ));

    if (!asset) {
      return errorPage('最新版本中未找到 APK 文件', 502);
    }

    const responseHeaders = new Headers({
      'Content-Type': APK_CONTENT_TYPE,
      'Content-Disposition': `attachment; filename="${asset.name}"`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });

    if (headOnly) {
      responseHeaders.set('Content-Length', String(asset.size));
      return new Response(null, { status: 200, headers: responseHeaders });
    }

    // Proxy the APK through Cloudflare and preserve range semantics used by
    // Android browsers and download managers for resumable downloads.
    const upstreamHeaders = new Headers({
      'User-Agent': 'SunlandAI-Pages/1.0',
      'Accept': 'application/octet-stream',
      'Accept-Encoding': 'identity',
    });
    const requestedRange = request.headers.get('Range');
    if (requestedRange) upstreamHeaders.set('Range', requestedRange);
    const requestedIfRange = request.headers.get('If-Range');
    if (requestedIfRange) upstreamHeaders.set('If-Range', requestedIfRange);

    const apkResp = await fetch(asset.browser_download_url, {
      headers: upstreamHeaders,
      redirect: 'follow',
    });

    if (apkResp.status === 416) {
      responseHeaders.set(
        'Content-Range',
        apkResp.headers.get('Content-Range') || `bytes */${asset.size}`,
      );
      return new Response(null, { status: 416, headers: responseHeaders });
    }

    if (!apkResp.ok) {
      return errorPage(`APK 下载失败 (${apkResp.status})，请稍后重试`, 502);
    }

    for (const header of [
      'Content-Length',
      'Content-Range',
      'ETag',
      'Last-Modified',
    ]) {
      const value = apkResp.headers.get(header);
      if (value) responseHeaders.set(header, value);
    }

    return new Response(apkResp.body, {
      status: apkResp.status,
      headers: responseHeaders,
    });
  } catch (err) {
    console.error('APK proxy failed', err);
    return errorPage('服务器内部错误，请稍后重试', 502);
  }
}

function errorPage(msg, status) {
  const body = `<!DOCTYPE html><html lang="zh-Hans"><head><meta charset="UTF-8">
<title>下载失败</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0c16;color:#fff;}
.box{text-align:center;padding:2rem;}h1{color:#71f8fc;}p{opacity:.7;margin:.5rem 0;}
a{color:#71f8fc;}</style></head>
<body><div class="box"><h1>下载暂时不可用</h1><p>${msg}</p>
<p>请<a href="https://github.com/${REPO}/releases/latest" target="_blank">前往 GitHub</a>手动下载</p>
<p><a href="/download.html">返回下载页</a></p></div></body></html>`;
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
