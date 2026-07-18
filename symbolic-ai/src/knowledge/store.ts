/**
 * In-memory `KnowledgeStore` implementation.
 *
 * Indexing strategy: alongside the primary `Map<Id, KnowledgeRecord>`, three
 * secondary indexes (by subject / relation / object) map each field value to
 * the set of record ids sharing it. `match()` intersects only the indexes
 * implied by the fields actually present in the pattern (wildcards are
 * skipped), then does a final exact check (including `negated`) against the
 * candidate records -- this keeps lookups close to O(smallest matching
 * index) instead of scanning every record for every query.
 */
import type {
  AddOptions,
  Id,
  KnowledgeRecord,
  KnowledgeStore,
  Triple,
  TriplePattern,
} from "@/types";

let idCounter = 0;

/** Monotonic, collision-free id: timestamp + in-process counter, both base36. */
function generateId(): Id {
  idCounter += 1;
  return `k_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

const DEFAULT_CONFIDENCE = 1;
const DEFAULT_SOURCE: KnowledgeRecord["source"] = "user";

/** Stable key identifying a triple's *fact identity* (ignores id/provenance). */
function tripleKey(triple: Triple): string {
  return `${triple.subject} ${triple.relation} ${triple.object} ${triple.negated}`;
}

function addToIndex(index: Map<string, Set<Id>>, key: string, id: Id): void {
  const existing = index.get(key);
  if (existing === undefined) {
    index.set(key, new Set([id]));
  } else {
    existing.add(id);
  }
}

function removeFromIndex(index: Map<string, Set<Id>>, key: string, id: Id): void {
  const existing = index.get(key);
  if (existing === undefined) return;
  existing.delete(id);
  if (existing.size === 0) index.delete(key);
}

/** Intersection of several id sets, smallest-first for efficiency. */
function intersect(sets: readonly Set<Id>[]): Set<Id> {
  const bySizeAsc = [...sets].sort((a, b) => a.size - b.size);
  const [smallest, ...rest] = bySizeAsc;
  if (smallest === undefined) return new Set();
  let result = smallest;
  for (const set of rest) {
    const next = new Set<Id>();
    for (const id of result) {
      if (set.has(id)) next.add(id);
    }
    result = next;
    if (result.size === 0) break;
  }
  return result;
}

function matchesPattern(record: KnowledgeRecord, pattern: TriplePattern): boolean {
  if (pattern.subject !== undefined && record.subject !== pattern.subject) return false;
  if (pattern.relation !== undefined && record.relation !== pattern.relation) return false;
  if (pattern.object !== undefined && record.object !== pattern.object) return false;
  if (pattern.negated !== undefined && record.negated !== pattern.negated) return false;
  return true;
}

/**
 * `KnowledgeRecord.confidence` is documented as "belief strength in the
 * closed interval [0, 1]" (`types/knowledge.ts`). Enforced at the one place
 * new confidence values enter the store (`add()`), so every record already
 * inside the store can be trusted to satisfy the invariant without every
 * consumer re-checking it.
 */
function assertValidConfidence(confidence: number): void {
  if (Number.isNaN(confidence) || confidence < 0 || confidence > 1) {
    throw new RangeError(`confidence must be within [0, 1], got ${confidence}`);
  }
}

/**
 * In-memory `KnowledgeStore`.
 *
 * `add()` is idempotent per fact identity: re-adding an exact duplicate
 * (same subject+relation+object+negated) returns the already-stored record
 * unchanged rather than inserting a second copy -- the store models a set of
 * *facts*, not a log of every assertion ever made. To change a fact's
 * confidence/source, `remove()` it and `add()` again.
 *
 * `addMany()` is for bulk restore (seed data now; Supabase hydration in
 * Stage 5): input records already carry their own `id`, and re-adding a
 * record whose `id` is already present is a no-op -- safe to call repeatedly
 * (e.g. re-seeding on every app start).
 */
export class InMemoryKnowledgeStore implements KnowledgeStore {
  private readonly records = new Map<Id, KnowledgeRecord>();
  private readonly bySubject = new Map<string, Set<Id>>();
  private readonly byRelation = new Map<string, Set<Id>>();
  private readonly byObject = new Map<string, Set<Id>>();
  private readonly idByTripleKey = new Map<string, Id>();

  all(): readonly KnowledgeRecord[] {
    return Array.from(this.records.values());
  }

  has(triple: Triple): boolean {
    return this.idByTripleKey.has(tripleKey(triple));
  }

  match(pattern: TriplePattern): readonly KnowledgeRecord[] {
    const candidateSets: Set<Id>[] = [];
    if (pattern.subject !== undefined) {
      candidateSets.push(this.bySubject.get(pattern.subject) ?? new Set());
    }
    if (pattern.relation !== undefined) {
      candidateSets.push(this.byRelation.get(pattern.relation) ?? new Set());
    }
    if (pattern.object !== undefined) {
      candidateSets.push(this.byObject.get(pattern.object) ?? new Set());
    }

    const candidateIds: Iterable<Id> =
      candidateSets.length > 0 ? intersect(candidateSets) : this.records.keys();

    const results: KnowledgeRecord[] = [];
    for (const id of candidateIds) {
      const record = this.records.get(id);
      if (record !== undefined && matchesPattern(record, pattern)) {
        results.push(record);
      }
    }
    return results;
  }

  add(triple: Triple, options?: AddOptions): KnowledgeRecord {
    const existingId = this.idByTripleKey.get(tripleKey(triple));
    if (existingId !== undefined) {
      const existing = this.records.get(existingId);
      if (existing !== undefined) return existing;
    }

    const confidence = options?.confidence ?? DEFAULT_CONFIDENCE;
    assertValidConfidence(confidence);

    const record: KnowledgeRecord = {
      subject: triple.subject,
      relation: triple.relation,
      object: triple.object,
      negated: triple.negated,
      id: generateId(),
      confidence,
      source: options?.source ?? DEFAULT_SOURCE,
      createdAt: new Date().toISOString(),
    };
    this.insertRecord(record);
    return record;
  }

  addMany(records: readonly KnowledgeRecord[]): void {
    for (const record of records) {
      if (this.records.has(record.id)) continue;
      this.insertRecord(record);
    }
  }

  remove(id: Id): void {
    const record = this.records.get(id);
    if (record === undefined) return;
    this.records.delete(id);
    this.idByTripleKey.delete(tripleKey(record));
    removeFromIndex(this.bySubject, record.subject, id);
    removeFromIndex(this.byRelation, record.relation, id);
    removeFromIndex(this.byObject, record.object, id);
  }

  clear(): void {
    this.records.clear();
    this.bySubject.clear();
    this.byRelation.clear();
    this.byObject.clear();
    this.idByTripleKey.clear();
  }

  private insertRecord(record: KnowledgeRecord): void {
    this.records.set(record.id, record);
    this.idByTripleKey.set(tripleKey(record), record.id);
    addToIndex(this.bySubject, record.subject, record.id);
    addToIndex(this.byRelation, record.relation, record.id);
    addToIndex(this.byObject, record.object, record.id);
  }
}
