# 霜蓝 · 个人主页模板

## 👋 项目概览（展示版）

这是一个简洁、现代、持续进化中的个人主页网站模板，强调**国内可稳定访问**、完整的日夜视觉体系，以及真实可用的互动功能，适合直接部署到 GitHub Pages、Cloudflare Pages 或任意静态托管平台。

本项目已完全开源，遵循 **MIT License**，你可以自由使用、修改和二次发布。

---

## ✨ 特点

- 🚫 页面样式不依赖 Google Fonts / 外网 CDN（登录模块除外）
- 🇨🇳 中国大陆网络环境稳定访问
- 🎨 现代化卡片式 UI + 流畅微交互
- 🌗 完整的日 / 夜双模式（非简单反色）
- 🌐 全站简体中文 / 繁體中文 / English / 日本語 / 한국어 / Español 联动切换
- 🌫 日间阅读模式（低亮度、高对比，长时间不累眼）
- 🧊 Glass / 雾面风格卡片设计
- ❤️ 真实可用的互动组件（点赞、鸣谢榜、留言）
- 🔐 支持登录状态识别（可对接 Supabase 等后端）
- 📱 全设备自适应（移动端 / 桌面端 / 横屏）
- 🧩 包含 donate、留言、小游戏、粉丝展示等页面
- 🆓 MIT License，可用于个人或商业项目

---

## 🚀 使用方式

1. Fork 或 Download 本仓库  
2. 修改页面中的文字、图片、配色与交互逻辑为你自己的内容  
3. 部署到 GitHub Pages / Cloudflare Pages / 任意静态服务器  
4. 完成 🎉

---

⚠️ 以下内容为「开发说明」，面向需要二次开发 / 深度定制的使用者  
如果你只是想直接使用模板，阅读到这里已经足够。  
---

## 🛠 开发说明

本项目最初用于个人站点搭建，但在持续迭代中逐渐演变为一个偏向「产品级体验」的静态站示例。

在设计上，本项目刻意强调：
- 日 / 夜模式并非简单反色，而是两套独立的视觉与对比逻辑
- 所有交互（点赞、鸣谢、弹窗、动画）均以“可用性优先”为目标
- UI 组件尽量保持低耦合，便于裁剪或替换

如果你计划进行二次开发，建议从以下角度入手：
- 统一管理配色变量（`:root` / `body.day` / `body.night`）
- 将页面级样式与组件样式拆分整理
- 根据需要接入 Supabase / 自建后端以实现完整数据流

### 信息鉴真工具

独立页面为 `/verify.html`，Pages Function 接口为 `GET /api/verify`（能力探测）和 `POST /api/verify`（核验）。DeepSeek 复用现有 `api.sunland.dev` Worker；Secret 仍只存在于该 Worker 的 `DEEPSEEK_API_KEY`，Pages 和浏览器都不保存副本。API 转发当前用户的 Bearer token，沿用现有 Worker 的 JWT 校验、每日额度和 KV 限流。

生产环境必须配置以下一种真实搜索服务；未配置时接口返回 `SEARCH_UNAVAILABLE`，不会让 DeepSeek 代替联网搜索：

```text
# Brave Search
SEARCH_PROVIDER=brave
BRAVE_SEARCH_API_KEY=<Cloudflare Pages Secret>

# 或 SearXNG
SEARCH_PROVIDER=searxng
SEARXNG_BASE_URL=https://search.example.com
SEARXNG_API_KEY=<可选 Cloudflare Pages Secret>
```

SearXNG 实例必须开放 `/search?format=json`。建议在 Cloudflare Pages 项目 `sunland` 中增加 `AI_GATEWAY` Service binding，目标 Worker 为 `ai`；未绑定时 Pages Function 会回退到服务端请求 `https://api.sunland.dev/`，契约不变。仓库当前没有 Pages Wrangler 配置，Cloudflare Dashboard 仍是配置来源，不应新增不完整的 `wrangler.toml` 覆盖生产设置。

图片使用 `multipart/form-data`，允许 `image/jpeg`、`image/png`、`image/webp`，最大 5 MB。Tesseract.js 在浏览器端 OCR，后端校验文件魔数，只把 OCR 文字交给 DeepSeek。OCR 失败时返回“不足以判断”，不会调用模型猜图。

本地检查：

```bash
npm test
npx wrangler pages functions build --outdir /tmp/sunland-verify-build
npx wrangler pages dev . --port 8788 --compatibility-date=2026-06-24
```

当前只预留了视频、反向搜图、C2PA / Content Credentials 和 AI 生成检测接口；这些能力不会输出伪造概率。

示例网站：https://sunland.dev
<img src="https://raw.githubusercontent.com/ikun-1145/xixi/main/follow.svg" width="300" />
