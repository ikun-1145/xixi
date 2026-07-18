/**
 * Knowledge store contracts.
 *
 * Read and write are separated (Interface Segregation) so reasoners can depend
 * on the read-only `KnowledgeQuery` and never mutate state during inference.
 */
import type { Id, KnowledgeRecord, KnowledgeSource, Triple, TriplePattern } from "./knowledge";

/** Optional metadata supplied when inserting a fact. */
export interface AddOptions {
  readonly confidence?: number;
  readonly source?: KnowledgeSource;
}

/** Read-only view of the knowledge base. Safe to pass to reasoners. */
export interface KnowledgeQuery {
  /** Every stored fact. */
  all(): readonly KnowledgeRecord[];
  /** Facts matching a partial pattern (undefined fields are wildcards). */
  match(pattern: TriplePattern): readonly KnowledgeRecord[];
  /** Whether an equivalent fact already exists. */
  has(triple: Triple): boolean;
}

/** Full read/write knowledge base. */
export interface KnowledgeStore extends KnowledgeQuery {
  add(triple: Triple, options?: AddOptions): KnowledgeRecord;
  addMany(records: readonly KnowledgeRecord[]): void;
  remove(id: Id): void;
  clear(): void;
}
