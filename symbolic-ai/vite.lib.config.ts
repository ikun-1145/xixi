import { defineConfig } from "vite";
import path from "node:path";

/**
 * Library-mode build for the Sunland Core SDK (`src/sdk.ts`).
 *
 * Separate from `vite.config.ts` on purpose: that config builds this
 * project's OWN React dev/demo shell (App.tsx); this one builds a portable,
 * dependency-free ESM bundle meant to be imported by an entirely different,
 * non-Vite, no-build-tool host -- the production website.
 *
 * `outDir` points OUTSIDE this package, directly at the production site's
 * `ai/vendor/` folder (this project lives at `xixi/symbolic-ai/`, the site
 * at `xixi/`) -- running `npm run build:lib` is the ENTIRE deploy step for
 * this artifact; there is no separate manual copy. `emptyOutDir: false` so
 * this build never deletes unrelated files that might already live in
 * `ai/vendor/`.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: path.resolve(__dirname, "../ai/vendor"),
    emptyOutDir: false,
    lib: {
      entry: path.resolve(__dirname, "./src/sdk.ts"),
      name: "SunlandCore",
      formats: ["es"],
      fileName: () => "sunland-core.js",
    },
    // The whole point: zero runtime dependencies. If a future SDK export
    // accidentally pulls in react/cytoscape/supabase, this build should
    // fail loudly rather than silently bundling (or externalizing and
    // breaking) them.
    rollupOptions: {
      external: [],
    },
  },
});
