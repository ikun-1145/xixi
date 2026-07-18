/**
 * MODULE: memory
 * Responsibility: per-user long-term `MemoryManager` -- facts Sunland AI
 * remembers ABOUT a user (name today; age/preferences later), strictly
 * separate from world knowledge (`src/knowledge/`) and from conversation
 * history (owned entirely by the chat/provider layer, never by Core).
 * localStorage-backed today via the same `StorageAdapter` abstraction used
 * by `knowledge/persistence.ts`; a Supabase-backed `MemoryManager` can be
 * added later behind the same interface without callers changing.
 * Depends on: types only. Must NOT import parser/knowledge/reasoners/
 * personality/ui.
 * Implemented in: Stage 5 (Memory Foundation).
 *
 * Public API:
 *   - InMemoryMemoryManager    the MemoryManager implementation
 *   - createMemoryManager()   convenience factory (empty manager)
 *   - saveMemoryManager(...)  persist a manager's facts via a StorageAdapter
 *   - loadMemoryManager(...)  restore a manager's facts via a StorageAdapter
 */
import type { MemoryManager } from "@/types";
import { InMemoryMemoryManager } from "./manager";

export * from "./manager";
export * from "./persistence";

/** Convenience factory returning an empty, ready-to-use memory manager. */
export function createMemoryManager(): MemoryManager {
  return new InMemoryMemoryManager();
}
