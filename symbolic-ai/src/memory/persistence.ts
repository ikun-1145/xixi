/**
 * `MemoryManager` <-> `StorageAdapter` bridge, the exact counterpart of
 * `knowledge/persistence.ts` for `KnowledgeStore` -- persistence is layered
 * on top via plain functions rather than being a method on the manager
 * itself, so any `MemoryManager` implementation (including a future
 * Supabase-backed one) can opt in/out without the manager ever knowing
 * storage exists.
 *
 * Serialization format is simply `MemoryRecord[]` (exactly what `list()`
 * returns) -- `loadMemoryManager` restores it via `restore()`, which keeps
 * each record's own `id`/`createdAt` and skips keys already present, so
 * calling this at every app start is safe and idempotent.
 */
import type { MemoryManager, MemoryRecord, StorageAdapter } from "@/types";

/** Persist the manager's current facts under `key` via `adapter`. */
export function saveMemoryManager(manager: MemoryManager, adapter: StorageAdapter, key: string): void {
  adapter.setItem(key, JSON.stringify(manager.list()));
}

/**
 * Restore previously-saved facts from `key` via `adapter` into `manager`.
 * A no-op (never throws) when the key is empty or holds corrupted JSON --
 * persisted data must never be able to crash the host app.
 */
export function loadMemoryManager(manager: MemoryManager, adapter: StorageAdapter, key: string): void {
  const raw = adapter.getItem(key);
  if (raw === null) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (!Array.isArray(parsed)) return;

  manager.restore(parsed as readonly MemoryRecord[]);
}
