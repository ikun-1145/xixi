import type { StorageAdapter } from "@/types";

/**
 * In-memory `StorageAdapter` -- the default for Node/CLI/tests, and a safe
 * fallback for any host that has no (or wants no) real persistence. Data
 * lives only as long as the returned object does; nothing touches disk,
 * `localStorage`, or any network.
 */
export function createMemoryStorageAdapter(): StorageAdapter {
  const data = new Map<string, string>();
  return {
    getItem(key: string): string | null {
      return data.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      data.set(key, value);
    },
    removeItem(key: string): void {
      data.delete(key);
    },
  };
}
