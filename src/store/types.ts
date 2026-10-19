/**
 * Store contracts that are *not* in `src/contracts` (which is frozen for this
 * wave): the async store, the summary-with-size row, and the storage usage the
 * UI reports.
 *
 * `TripStore` (sync, `src/contracts`) remains the interface of the
 * localStorage fallback. `AsyncTripStore` adds IndexedDB's asynchronous
 * `list`/`load`/`save`/`remove`; serialisation (`toGpx`, `toGeoJson`,
 * `fromFile`) stays synchronous and pure on both, because it touches no
 * storage and a download should not need an await.
 */

import type { Trip, TripSummary } from '../contracts';
/**
 * `TripSummary` plus the stored byte size. The size lives in the `summaries`
 * object store so a 10 MB trip can be listed without reading its body.
 */
export interface StoredTripSummary extends TripSummary {
  readonly byteSize: number;
}

export type MaybePromise<T> = T | Promise<T>;

/**
 * What the session talks to. Every storage operation may be synchronous (the
 * in-memory/localStorage store) or asynchronous (IndexedDB); a caller that
 * `await`s the result works with both, and no adapter is needed in the tests.
 */
export interface TripStoreLike {
  list(): MaybePromise<TripSummary[]>;
  load(id: string): MaybePromise<Trip | null>;
  save(trip: Trip): MaybePromise<void>;
  remove(id: string): MaybePromise<void>;
  toGpx(trip: Trip, options?: { legIds?: readonly string[]; includeElevation?: boolean }): string;
  toGeoJson(trip: Trip): string;
  fromFile(text: string, filename: string): Trip;
}

/** Bytes in use and available, as the browser reports them. */
export interface StorageUsage {
  readonly usedBytes: number;
  readonly quotaBytes: number;
  /**
   * Where the numbers come from. `localstorage-estimate` is our own sum of the
   * stored strings against a documented ~5 MB cap, not a browser measurement —
   * the UI must not present it as one.
   */
  readonly source: 'indexeddb' | 'localstorage-estimate';
}

/** Which backend persisted the trips, and whether the browser made it durable. */
export interface TripStorageInfo {
  readonly backend: 'indexeddb' | 'localstorage';
  /** `navigator.storage.persist()` granted. localStorage never is. */
  readonly persistent: boolean;
  /** Why we are not on IndexedDB; `null` when we are. Never silent. */
  readonly problem: string | null;
}

/** Result of importing the pre-IndexedDB localStorage trips. */
export interface MigrationResult {
  /** Trips written into IndexedDB. */
  readonly imported: number;
  /** Legacy keys removed after the transaction committed. */
  readonly removed: number;
  /** Bodies that could not be read and were therefore kept on disk. */
  readonly skipped: number;
  /** Set when the import failed; the localStorage copies are still there. */
  readonly error?: string;
}

/**
 * The async trip store: `list`/`load`/`save`/`remove` return promises, and the
 * two facts the UI must be able to state — which backend, and how full it is —
 * are part of the interface rather than something the caller guesses.
 */
export interface AsyncTripStore extends TripStoreLike {
  readonly backend: 'indexeddb' | 'localstorage';
  readonly persistent: boolean;
  readonly problem: string | null;
  /** Summaries carry the stored size, so the library can show it without load. */
  list(): Promise<StoredTripSummary[]>;
  load(id: string): Promise<Trip | null>;
  save(trip: Trip): Promise<void>;
  remove(id: string): Promise<void>;
  /** `null` when the browser exposes no storage estimate at all. */
  usage(): Promise<StorageUsage | null>;
  /** The legacy migration, when this store performed one. */
  readonly migration: MigrationResult | null;
  /** Present on the IndexedDB backend only: import the localStorage trips. */
  migrateLegacy?(storage?: Storage | null): Promise<MigrationResult>;
}
