const REPO = 'ikun-1145/sunland-ai-dart';
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

export async function onRequestGet() {
  try {
    // 1. Get latest release metadata from GitHub API
    const apiResp = await fetch(API_URL, {
      headers: {
        'User-Agent': 'SunlandAI-Pages/1.0',
        'Accept': 'application/vnd.github+json',
      },
    });

    if (!apiResp.ok) {
      return errorPage(`GitHub API 返回 ${apiResp.status}，请稍后重试`);
    }

    const release = await apiResp.json();
    const asset = release.assets && release.assets.find(a => a.name.endsWith('.apk'));

    if (!asset) {
      return errorPage('最新版本中未找到 APK 文件');
    }

    // 2. Proxy the APK binary through Cloudflare so Chinese users don't hit GitHub directly
    const apkResp = await fetch(asset.browser_download_url);

    if (!apkResp.ok) {
      return errorPage(`APK 下载失败 (${apkResp.status})，请稍后重试`);
    }

    // Use Content-Length from the actual response (after redirects) rather than
    // asset.size, because GitHub redirects to S3 and the final URL has the real length
    const headers = new Headers({
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Disposition': `attachment; filename="${asset.name}"`,
    });
    const cl = apkResp.headers.get('Content-Length');
    if (cl) headers.set('Content-Length', cl);

    return new Response(apkResp.body, { status: 200, headers });
  } catch (err) {
    return errorPage(`服务器内部错误: ${err.message}`);
  }
}

function errorPage(msg) {
  const body = `<!DOCTYPE html><html lang="zh-Hans"><head><meta charset="UTF-8">
<title>下载失败</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0c16;color:#fff;}
.box{text-align:center;padding:2rem;}h1{color:#71f8fc;}p{opacity:.7;margin:.5rem 0;}
a{color:#71f8fc;}</style></head>
<body><div class="box"><h1>下载暂时不可用</h1><p>${msg}</p>
<p>请<a href="https://github.com/${REPO}/releases/latest" target="_blank">前往 GitHub</a>手动下载</p>
<p><a href="/download.html">返回下载页</a></p></div></body></html>`;
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/html;charset=UTF-8' },
  });
}
