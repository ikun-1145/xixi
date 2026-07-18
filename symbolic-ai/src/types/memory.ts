/**
 * User memory contracts (Stage 5 -- Memory Foundation).
 *
 * "Memory" here means facts Sunland AI remembers ABOUT a specific user
 * (their name, later age/preferences/...) -- explicitly NOT the same thing
 * as either of the two other places facts live:
 *   - Conversation History: the chat transcript, owned entirely by the
 *     chat/provider layer (`ai/providers/conversation.js` on the website
 *     side) -- Core never sees or stores it.
 *   - `KnowledgeStore` (`types/knowledgeStore.ts`): general WORLD knowledge
 *     ("猫属于哺乳动物"), never facts about a specific user.
 * Kept in its own store, addressed by simple string keys, with one
 * `MemoryManager` instance scoped to a single user (mirroring how one
 * `KnowledgeStore` instance is already scoped to one user via a storage
 * key) -- so `MemoryRecord` doesn't need to carry a `userId` field itself.
 */
import type { Id } from "./knowledge";

/**
 * Well-known memory keys, mirroring `CoreRelations` in `knowledge.ts`: a
 * small set of canonical string constants the engine (writes/reads) and
 * Personality (renders naturally) both agree on, while `MemoryKey` itself
 * stays an open `string` so future intents (RememberAge, RememberPreference,
 * ...) can introduce new keys without touching this file or `MemoryManager`.
 */
export const MemoryKeys = {
  Name: "name",
} as const;

export type MemoryKey = string;

/** A single remembered fact about one user. */
export interface MemoryRecord {
  readonly id: Id;
  readonly key: MemoryKey;
  readonly value: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Per-user long-term memory. Synchronous, same posture as `KnowledgeStore`
 * (backed by a `StorageAdapter` -- see `memory/persistence.ts`): a future
 * Supabase-backed implementation can satisfy this exact interface (eagerly
 * loaded/cached) without any caller changing, exactly like the migration
 * path already documented for `KnowledgeStore`.
 */
export interface MemoryManager {
  /** Store (or overwrite) a fact under `key`. */
  remember(key: MemoryKey, value: string): MemoryRecord;
  /** Look up a fact by exact key, or `null` if never remembered / forgotten. */
  recall(key: MemoryKey): MemoryRecord | null;
  /** Erase a fact. No-op if `key` isn't set. */
  forget(key: MemoryKey): void;
  /** Every remembered fact. */
  list(): readonly MemoryRecord[];
  /** Facts whose key or value contains `query` (case-insensitive substring). */
  search(query: string): readonly MemoryRecord[];
  /**
   * Bulk-restore pre-built records (keeping their own id/createdAt) -- the
   * `MemoryManager` counterpart to `KnowledgeStore.addMany`, used ONLY by
   * the persistence bridge (`memory/persistence.ts`). Skips any key already
   * present, so it's safe to call on top of live in-session data.
   */
  restore(records: readonly MemoryRecord[]): void;
}
