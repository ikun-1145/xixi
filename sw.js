const CACHE_NAME = "ai-app-v1";
// 这是一个由Agent测试添加的注释

// 安装时缓存核心文件
self.addEventListener("install", (e) => {
  self.skipWaiting();
});

// 激活
self.addEventListener("activate", (e) => {
  self.clients.claim();
});

// 拦截请求（简单网络优先）
self.addEventListener("fetch", (e) => {
  const req = e.request;
  // 只接管「同源 GET」做离线兜底；POST/其它方法、以及跨域请求
  //（如 Supabase Edge Function 调用）一律不拦截，直接走浏览器原生网络。
  // 否则一旦 fetch 在网络层被拒绝，catch 里的 caches.match 对未缓存/POST 会返回 undefined，
  // respondWith(undefined) 会抛 "Failed to convert value to 'Response'"，导致请求 net::ERR_FAILED，
  // 把后端真实响应（含错误信息）整个吞掉、放大成“网络异常”。
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    // 兜底必须返回合法 Response：无缓存命中时用 Response.error()，绝不返回 undefined。
    fetch(req).catch(async () => (await caches.match(req)) || Response.error())
  );
});

// ⭐ 接收跳过等待
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});