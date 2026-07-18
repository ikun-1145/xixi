import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Separate from vite.config.ts on purpose: our unit tests (parser, knowledge,
 * reasoners) are pure TypeScript logic with no DOM/React dependency, so they
 * run faster in Node than in jsdom. UI component tests (added in later
 * stages) can opt into a jsdom environment via a per-file `@vitest-environment`
 * comment if/when needed.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
