/**
 * MODULE: knowledge
 * Responsibility: in-memory KnowledgeStore of triples + indexing (by
 * subject/relation/object) + illustrative seed facts + optional
 * StorageAdapter-backed persistence.
 * Depends on: types only. Must NOT import parser/reasoners/personality/ui.
 * Persistence here is a generic `StorageAdapter` bridge (Stage 3.5); a
 * Supabase-backed `KnowledgeStore` implementation can still be added in
 * Stage 5 behind the same `KnowledgeStore` interface -- callers should never
 * need to change when that lands.
 * Implemented in: Stage 3 (store/seed), Stage 3.5 (persistence).
 *
 * Public API:
 *   - InMemoryKnowledgeStore     the KnowledgeStore implementation
 *   - createKnowledgeStore()     convenience factory (empty store)
 *   - seedTriples                readonly array of illustrative starter facts
 *   - seedKnowledgeStore(store)  populates a store with seedTriples
 *   - saveKnowledgeStore(...)    persist a store's facts via a StorageAdapter
 *   - loadKnowledgeStore(...)    restore a store's facts via a StorageAdapter
 *   - createSelfKnowledgeStore() a separate, always-on store of facts about
 *                                Sunland AI itself, backing the Identity
 *                                intent (see `selfKnowledge.ts`) -- distinct
 *                                from a user's own `KnowledgeStore`
 */
import type { KnowledgeStore } from "@/types";
import { InMemoryKnowledgeStore } from "./store";

export * from "./store";
export * from "./seed";
export * from "./persistence";
export * from "./selfKnowledge";

/** Convenience factory returning an empty, ready-to-use knowledge store. */
export function createKnowledgeStore(): KnowledgeStore {
  return new InMemoryKnowledgeStore();
}
