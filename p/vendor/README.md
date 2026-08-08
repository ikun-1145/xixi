# 浏览器运行时依赖

这些文件从 `symbolic-ai/package-lock.json` 锁定的本地依赖复制，用于避免生产页面把关键启动流程绑定到第三方 CDN：

- `supabase-2.110.7.js`：`@supabase/supabase-js` 的 UMD 浏览器构建（MIT）
- `marked-18.0.6.umd.js`：Marked 的 UMD 浏览器构建（MIT）
- `dompurify-3.4.12.min.js`：DOMPurify 的浏览器构建（MPL-2.0 OR Apache-2.0）

更新版本时应同步更新 `symbolic-ai/package-lock.json`、文件名、页面引用和本目录中的许可证文件，并运行完整回归测试。
