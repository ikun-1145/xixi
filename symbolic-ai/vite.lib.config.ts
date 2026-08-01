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
 * Vite writes one canonical staging artifact inside this package. The
 * `scripts/release-core.mjs` release step then publishes those exact bytes to
 * every supported host and verifies their SHA-256 manifests. Keeping publish
 * destinations out of the bundler makes the artifact source explicit and
 * prevents Web and Flutter builds from drifting.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: path.resolve(__dirname, "./dist/core"),
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
