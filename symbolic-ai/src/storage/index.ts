/**
 * MODULE: storage
 * Responsibility: the `StorageAdapter` contract (see `types/storage.ts`)
 * plus a dependency-free in-memory implementation. Real backends (browser
 * `localStorage`, a future Supabase-backed adapter, ...) are just objects
 * satisfying the same three-method interface -- Core never imports them,
 * hosts inject them.
 * Depends on: types only. Must NOT import parser/knowledge/reasoners/
 * personality/ui (leaf module, same posture as `types`).
 * Implemented in: Stage 3.5.
 *
 * Public API:
 *   - createMemoryStorageAdapter()   dependency-free in-memory StorageAdapter
 */
export * from "./memoryAdapter";
