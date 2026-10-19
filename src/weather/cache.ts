/**
 * The weather cache contract and its in-memory implementation.
 *
 * A cache entry is the **parsed MET body** plus the time MET said it expires
 * (`Expires`, lowercased by `Headers`). The TTL is not ours to choose: the
 * measured response carries `expires` ≈ +30 minutes, and the engine refetches
 * once that instant has passed. There is no timer and no polling — a plan is
 * recomputed only when the user asks for one, and that recomputation is what
 * notices an expired entry.
 *
 * Values are treated as immutable by `planTripWeather`; implementations need
 * not copy them.
 */

export interface CachedForecast {
  /** The MET Locationforecast JSON body, unchanged. */
  readonly body: unknown;
  /** ISO timestamp from the response's `Expires` (or a documented fallback). */
  readonly expiresAt: string;
}

export interface WeatherCache {
  get(key: string): Promise<CachedForecast | null>;
  set(key: string, value: CachedForecast): Promise<void>;
}

/**
 * A `Map`-backed cache. It does **not** filter expired entries itself: the
 * engine checks `expiresAt`, so that every cache implementation (localStorage,
 * IndexedDB, a test double) behaves identically.
 *
 * Useful for tests and for a single-session UI; a page reload loses it.
 */
export function memoryWeatherCache(): WeatherCache {
  const store = new Map<string, CachedForecast>();
  return {
    async get(key: string): Promise<CachedForecast | null> {
      return store.get(key) ?? null;
    },
    async set(key: string, value: CachedForecast): Promise<void> {
      store.set(key, value);
    },
  };
}
