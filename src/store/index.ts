/**
 * Trip persistence.
 *
 * Two backends with one shape:
 *
 * - `createTripStorage()` — **IndexedDB** (database `truhiker`): large trips,
 *   durable, summaries kept beside the bodies so listing never deserialises a
 *   10 MB trip. Falls back to the localStorage store when IndexedDB is missing,
 *   and says so instead of failing quietly.
 * - `createTripStore()` — **localStorage** (or memory): the fallback and the
 *   store the tests use. Keeps the old `npl:trips:v1` / `npl:trip:<id>` keys,
 *   which the IndexedDB store imports once and then deletes.
 *
 * Both round-trip through GPX 1.1 and GeoJSON without losing geometry,
 * elevation provenance or licence metadata. See `README.md` next to this file
 * and `docs/12-storage.md`.
 */

export {
  INDEX_KEY,
  MAX_TRIP_BYTES,
  TRIP_KEY_PREFIX,
  byteSize,
  createTripStore,
  tripKey,
} from './local';
export type { GpxOptions } from './local';

export { defaultProfile, emptyTrip } from './trip';

export { LOCALSTORAGE_QUOTA_BYTES, localStorageUsage, memoryStorage, resolveStorage } from './storage';

export {
  BODIES,
  DB_NAME,
  DB_VERSION,
  MAX_INDEXEDDB_TRIP_BYTES,
  SUMMARIES,
  UPDATED_AT_INDEX,
  asAsyncTripStore,
  createIndexedDbTripStore,
  createTripStorage,
} from './indexeddb';
export type { IndexedDbOptions, IndexedDbTripStore, TripStorageOptions } from './indexeddb';

export type {
  AsyncTripStore,
  MaybePromise,
  MigrationResult,
  StorageUsage,
  StoredTripSummary,
  TripStorageInfo,
  TripStoreLike,
} from './types';

export { summarize } from './persist';
