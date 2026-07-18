/**
 * `KnowledgeStore` <-> `StorageAdapter` bridge.
 *
 * Deliberately NOT a method on `InMemoryKnowledgeStore` itself: persistence
 * is an orthogonal concern layered on top via plain functions, so ANY
 * `KnowledgeStore` implementation (including a future Supabase-backed one)
 * can opt in/out without the store class ever knowing storage exists.
 *
 * Serialization format is simply `KnowledgeRecord[]` (exactly what `all()`
 * returns) -- `loadKnowledgeStore` restores it via `addMany`, which already
 * treats records as pre-built (keeps their own `id`) and skips ids already
 * present, so calling this at every app start is safe and idempotent.
 */
import type { KnowledgeQuery, KnowledgeRecord, KnowledgeStore, StorageAdapter } from "@/types";

/** Persist the store's current facts under `key` via `adapter`. */
export function saveKnowledgeStore(store: KnowledgeQuery, adapter: StorageAdapter, key: string): void {
  adapter.setItem(key, JSON.stringify(store.all()));
}

/**
 * Restore previously-saved facts from `key` via `adapter` into `store`.
 * A no-op (never throws) when the key is empty or holds corrupted JSON --
 * persisted data must never be able to crash the host app.
 */
export function loadKnowledgeStore(store: KnowledgeStore, adapter: StorageAdapter, key: string): void {
  const raw = adapter.getItem(key);
  if (raw === null) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (!Array.isArray(parsed)) return;

  store.addMany(parsed as readonly KnowledgeRecord[]);
}
