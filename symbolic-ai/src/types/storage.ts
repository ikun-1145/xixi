/**
 * Storage contracts.
 *
 * Deliberately shaped like the browser's native `Storage` interface (the
 * same one `window.localStorage` / `sessionStorage` already implement), so a
 * host can hand `window.localStorage` straight to Core with zero wrapper
 * code. Core itself never imports `window`/`localStorage` (or any other
 * platform global) -- persistence is always something a host *injects*,
 * never something Core reaches out and grabs. That is what keeps every Core
 * module usable identically in a browser, Node, a CLI, or tests.
 *
 * Introduced in Stage 3.5, prerequisite for `SunlandEngine`'s knowledge
 * persistence and the website integration's "shared brain across
 * conversations" requirement.
 */
export interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
