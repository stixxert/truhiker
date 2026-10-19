/**
 * `Storage` resolution: the real `localStorage` when it is reachable, an
 * in-memory stand-in when it is not (Node, SSR, Safari private mode where even
 * reading the property throws).
 *
 * Both backends use this — IndexedDB for the legacy migration source and the
 * fallback store, the localStorage store for everything.
 */

const FALLBACK_LIMIT = 5_000_000;

/** In-memory `Storage` used when there is no `localStorage` (SSR, tests, CLI). */
export function memoryStorage(): Storage {
  const map = new Map<string, string>();
  const storage: Storage = {
    get length(): number {
      return map.size;
    },
    clear(): void {
      map.clear();
    },
    getItem(key: string): string | null {
      return map.has(key) ? map.get(key)! : null;
    },
    key(index: number): string | null {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string): void {
      map.delete(key);
    },
    setItem(key: string, value: string): void {
      map.set(key, value);
    },
  };
  // Some test fakes read this; harmless otherwise.
  Object.defineProperty(storage, 'quotaBytes', { value: FALLBACK_LIMIT, enumerable: false });
  return storage;
}

/** The injected storage, else `localStorage`, else an in-memory one. */
export function resolveStorage(storage?: Storage | null): Storage {
  if (storage) return storage;
  try {
    const candidate = (globalThis as { localStorage?: Storage }).localStorage;
    if (candidate) return candidate;
  } catch {
    // Access can throw in Safari private mode and in some embedded webviews.
  }
  return memoryStorage();
}

/** How much localStorage holds per origin, for the fallback's honest estimate. */
export const LOCALSTORAGE_QUOTA_BYTES = FALLBACK_LIMIT;

/**
 * Bytes localStorage is using, counted as UTF-16 code units × 2 (which is what
 * browsers store). It is our own sum, not a browser measurement.
 */
export function localStorageUsage(storage: Storage): number {
  let total = 0;
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key === null) break;
      const value = storage.getItem(key) ?? '';
      total += (key.length + value.length) * 2;
    }
  } catch {
    return 0;
  }
  return total;
}
