/**
 * In-memory `MemoryManager` implementation.
 *
 * Records are keyed by `key` (one value per key, like a dictionary) --
 * `remember()` overwrites in place (keeping the original `id`/`createdAt`,
 * only bumping `updatedAt`) rather than accumulating a history of every
 * value ever set for that key, mirroring `KnowledgeStore.add`'s "a set of
 * facts, not a log of assertions" posture.
 */
import type { Id, MemoryManager, MemoryRecord } from "@/types";

let idCounter = 0;

/** Monotonic, collision-free id: timestamp + in-process counter, both base36. */
function generateId(): Id {
  idCounter += 1;
  return `mem_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

export class InMemoryMemoryManager implements MemoryManager {
  private readonly records = new Map<string, MemoryRecord>();

  remember(key: string, value: string): MemoryRecord {
    const now = new Date().toISOString();
    const existing = this.records.get(key);
    const record: MemoryRecord = existing
      ? { ...existing, value, updatedAt: now }
      : { id: generateId(), key, value, createdAt: now, updatedAt: now };
    this.records.set(key, record);
    return record;
  }

  recall(key: string): MemoryRecord | null {
    return this.records.get(key) ?? null;
  }

  forget(key: string): void {
    this.records.delete(key);
  }

  list(): readonly MemoryRecord[] {
    return Array.from(this.records.values());
  }

  search(query: string): readonly MemoryRecord[] {
    const q = query.toLowerCase();
    return this.list().filter(
      (record) => record.key.toLowerCase().includes(q) || record.value.toLowerCase().includes(q),
    );
  }

  restore(records: readonly MemoryRecord[]): void {
    for (const record of records) {
      if (!this.records.has(record.key)) this.records.set(record.key, record);
    }
  }
}
