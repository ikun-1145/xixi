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
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});

// ⭐ 接收跳过等待
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});