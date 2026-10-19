/**
 * In-memory weather cache for the session.
 *
 * Not localStorage: the trip store owns that namespace (`npl:trips:v1`,
 * `npl:trip:<id>`) and "nothing else is written" is a rule, not a preference.
 * MET responses already carry `Expires`, so HTTP caching survives a reload; this
 * cache only stops the same page from asking twice for the same point.
 *
 * Entries are keyed by the caller (the weather engine builds the key), carry an
 * explicit `expiresAt`, and are evicted oldest-first when the cap is reached.
 */

export interface WeatherCacheStats {
  readonly size: number;
  readonly hits: number;
  readonly misses: number;
}

interface Entry {
  value: unknown;
  expiresAt: number | null;
  storedAt: number;
}

export class MemoryWeatherCache {
  private readonly entries = new Map<string, Entry>();
  private hits = 0;
  private misses = 0;

  constructor(
    private readonly options: { now?: () => number; maxEntries?: number } = {},
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private get maxEntries(): number {
    return this.options.maxEntries ?? 80;
  }

  async get(key: string): Promise<unknown> {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }
    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      this.misses++;
      return null;
    }
    this.hits++;
    return entry.value;
  }

  async set(key: string, value: unknown, expiresAt?: string): Promise<void> {
    const parsed = expiresAt ? new Date(expiresAt).getTime() : Number.NaN;
    this.entries.set(key, {
      value,
      expiresAt: Number.isFinite(parsed) ? parsed : null,
      storedAt: this.now(),
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  get stats(): WeatherCacheStats {
    return { size: this.entries.size, hits: this.hits, misses: this.misses };
  }
}
