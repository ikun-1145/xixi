/**
 * Sunland Core SDK -- the ONE public, framework-agnostic entry point meant
 * for consumption OUTSIDE this project (the production website's
 * `SunlandProvider`, a future CLI, a future API server, ...).
 *
 * This file is the sole input to the library build (`vite.lib.config.ts` /
 * `npm run build:lib`), which bundles it into a single dependency-free ESM
 * file any plain-`<script type="module">` host can import directly.
 *
 * Deliberately re-exports ONLY engine/knowledge/parser/personality/storage
 * (all of which are, by the project's one-way dependency rule, free of any
 * react/cytoscape/supabase/DOM dependency). It must NEVER re-export
 * anything from `graph/`, `memory/`, `ui`, or `App.tsx` -- those are
 * internal to this project's own React shell, not part of the portable
 * Sunland Core.
 */
export * from "./engine";
export * from "./knowledge";
export * from "./parser";
export * from "./personality";
export * from "./storage";
export type * from "./types";
