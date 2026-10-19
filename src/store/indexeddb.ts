/**
 * IndexedDB — the durable trip store.
 *
 * ## Why
 *
 * localStorage holds about 5 MB per origin and stores UTF-16 code units, so a
 * 3,000 km walk (≈100 000 points, 5–10 MB per trip) never fit: the store refused
 * anything over 1.5 MB. IndexedDB has no comparable per-trip ceiling, stores
 * structured clones instead of JSON strings, and can be made persistent
 * (`navigator.storage.persist()`).
 *
 * ## Schema (database `truhiker`, version 1)
 *
 * | store | keyPath | contents |
 * | --- | --- | --- |
 * | `bodies` | `id` | the whole `Trip`, structured-cloned — not a JSON string |
 * | `summaries` | `id` | `{ id, name, updatedAt, legCount, distanceM, byteSize }` |
 *
 * `summaries` carries an `updatedAt` index. Keeping the two consistent is what
 * makes `list()` cheap: it reads the summary rows only, so a 10 MB trip is never
 * deserialised just to draw a row in the library.
 *
 * ## Transaction discipline
 *
 * - `save` and `remove` open **one** `readwrite` transaction over both stores.
 *   A body without a summary is invisible; a summary without a body is a broken
 *   row. Neither can be produced by a crash between two transactions because
 *   there is only one.
 * - `list` opens a transaction over `summaries` alone. That is the whole point
 *   of the second store, and the test asserts it on the transaction itself.
 * - The migration reads the legacy localStorage bodies first, then writes all
 *   of them in one transaction, and removes the legacy keys **after** it
 *   commits. A failure leaves the localStorage copy untouched.
 */

import { StoreError, type Trip } from '../contracts';
import {
  INDEX_KEY,
  TRIP_KEY_PREFIX,
  byUpdatedAtDesc,
  byteSize,
  formatBytes,
  isQuotaError,
  summarize,
  tripKey,
} from './persist';
import { createTripStore } from './local';
import { fromFile as parseFile, toGeoJson as serializeGeoJson, toGpx as serializeGpx } from './serialize';
import { LOCALSTORAGE_QUOTA_BYTES, localStorageUsage, resolveStorage } from './storage';
import { migrate, validateTrip } from './trip';
import type {
  AsyncTripStore,
  MigrationResult,
  StorageUsage,
  StoredTripSummary,
  TripStoreLike,
} from './types';

export const DB_NAME = 'truhiker';
export const DB_VERSION = 1;
export const BODIES = 'bodies';
export const SUMMARIES = 'summaries';
export const UPDATED_AT_INDEX = 'updatedAt';

/**
 * Per-trip ceiling. Not the old 1.5 MB guard: this is a sanity bound so a
 * runaway import cannot fill the origin's (much larger) IndexedDB quota.
 */
export const MAX_INDEXEDDB_TRIP_BYTES = 50_000_000;

export interface IndexedDbOptions {
  /** Injected for tests (`fake-indexeddb`); defaults to `globalThis.indexedDB`. */
  factory?: IDBFactory | null;
  dbName?: string;
  version?: number;
  /** Per-trip ceiling in bytes; default {@link MAX_INDEXEDDB_TRIP_BYTES}. */
  maxBytes?: number;
  /** `navigator.storage.estimate` seam. */
  estimate?: () => Promise<{ usage?: number; quota?: number } | null>;
  /** `navigator.storage.persist` seam. */
  persist?: () => Promise<boolean>;
}

export interface IndexedDbTripStore extends AsyncTripStore {
  readonly backend: 'indexeddb';
  readonly migration: MigrationResult | null;
  /** Open the connection and create the stores if needed. Idempotent. */
  ready(): Promise<void>;
  /** Ask the browser to make this origin's storage durable. Once. */
  requestPersistence(): Promise<boolean>;
  /**
   * Import the trips written by the localStorage era. Never throws: a failure
   * is reported in the result and the legacy keys are left in place.
   */
  migrateLegacy(storage?: Storage | null): Promise<MigrationResult>;
  close(): void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultFactory(): IDBFactory | null {
  try {
    const candidate = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    return candidate ?? null;
  } catch {
    return null;
  }
}

function defaultEstimate(): Promise<{ usage?: number; quota?: number } | null> {
  try {
    const storage = (globalThis as { navigator?: { storage?: { estimate?: () => Promise<StorageEstimate> } } })
      .navigator?.storage;
    if (!storage?.estimate) return Promise.resolve(null);
    return storage.estimate();
  } catch {
    return Promise.resolve(null);
  }
}

function defaultPersist(): Promise<boolean> {
  try {
    const storage = (globalThis as { navigator?: { storage?: { persist?: () => Promise<boolean> } } }).navigator
      ?.storage;
    if (!storage?.persist) return Promise.resolve(false);
    return storage.persist();
  } catch {
    return Promise.resolve(false);
  }
}

/* ------------------------------------------------------------------ */
/* Promise plumbing                                                    */
/* ------------------------------------------------------------------ */

function request<T>(source: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    source.onsuccess = () => resolve(source.result);
    source.onerror = () => reject(source.error ?? new Error('IndexedDB request failed'));
  });
}

/**
 * Run `work` inside one transaction and resolve when it has **committed**.
 *
 * `work` must issue its requests synchronously (or at most await a single
 * request), because an IndexedDB transaction auto-commits as soon as control
 * returns to the event loop with no pending request. Every caller here does.
 */
async function inTransaction<R>(
  db: IDBDatabase,
  stores: readonly string[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => R | Promise<R>,
): Promise<R> {
  const tx = db.transaction(stores as string[], mode);
  const committed = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
  let result: R;
  try {
    result = await work(tx);
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // already finished
    }
    await committed.catch(() => undefined);
    throw error;
  }
  await committed;
  return result;
}

/* ------------------------------------------------------------------ */
/* Opening                                                             */
/* ------------------------------------------------------------------ */

function openDatabase(factory: IDBFactory, name: string, version: number): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let open: IDBOpenDBRequest;
    try {
      open = factory.open(name, version);
    } catch (error) {
      reject(new StoreError('unsupported', `IndexedDB could not be opened: ${messageOf(error)}`));
      return;
    }
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(BODIES)) {
        db.createObjectStore(BODIES, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(SUMMARIES)) {
        const summaries = db.createObjectStore(SUMMARIES, { keyPath: 'id' });
        summaries.createIndex(UPDATED_AT_INDEX, UPDATED_AT_INDEX, { unique: false });
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () =>
      reject(
        new StoreError(
          'unsupported',
          `IndexedDB could not be opened: ${messageOf(open.error ?? 'unknown error')}`,
        ),
      );
    // Another tab holds a connection at an older version. Do not block.
    open.onblocked = () => reject(new StoreError('unsupported', 'IndexedDB upgrade was blocked by another tab.'));
  });
}

/* ------------------------------------------------------------------ */
/* Validation and measurement                                          */
/* ------------------------------------------------------------------ */

function normalise(trip: Trip): Trip {
  if (typeof trip?.id !== 'string' || trip.id === '') {
    throw new StoreError('corrupt', 'Cannot save a trip without an id.');
  }
  return validateTrip(trip);
}

/** UTF-8 size of the trip as compared with the per-trip ceiling. */
function measure(trip: Trip): number {
  let json: string;
  try {
    json = JSON.stringify(trip);
  } catch (error) {
    throw new StoreError('corrupt', `Trip "${trip.name}" cannot be stored: ${messageOf(error)}`);
  }
  return byteSize(json);
}

function ceilingError(trip: Trip, bytes: number, limit: number): StoreError {
  return new StoreError(
    'quota-exceeded',
    `Trip "${trip.name}" is ${formatBytes(bytes)} (${(bytes / 1_000_000).toFixed(2)} MB), over the ` +
      `${formatBytes(limit)} per-trip storage limit. Nothing was saved. ` +
      `Download it as GPX instead — the round trip is lossless.`,
  );
}

function writeError(error: unknown, trip: Trip, bytes: number): unknown {
  if (isQuotaError(error)) {
    return new StoreError(
      'quota-exceeded',
      `Could not save "${trip.name}": the browser refused ${formatBytes(bytes)} ` +
        `(${(bytes / 1_000_000).toFixed(2)} MB) because storage is full. Nothing was saved. ` +
        `Download the trip as GPX, or delete an old trip, then try again.`,
    );
  }
  return error;
}

/* ------------------------------------------------------------------ */
/* The store                                                           */
/* ------------------------------------------------------------------ */

export function createIndexedDbTripStore(options: IndexedDbOptions = {}): IndexedDbTripStore {
  const factory = options.factory === undefined ? defaultFactory() : options.factory;
  const dbName = options.dbName ?? DB_NAME;
  const version = options.version ?? DB_VERSION;
  const maxBytes = options.maxBytes ?? MAX_INDEXEDDB_TRIP_BYTES;
  const estimate = options.estimate ?? defaultEstimate;
  const persist = options.persist ?? defaultPersist;

  let connection: Promise<IDBDatabase> | null = null;
  let persistent = false;
  let migration: MigrationResult | null = null;

  function db(): Promise<IDBDatabase> {
    if (!factory) {
      return Promise.reject(
        new StoreError('unsupported', 'IndexedDB is not available in this browser.'),
      );
    }
    if (connection === null) {
      connection = openDatabase(factory, dbName, version).catch((error: unknown) => {
        connection = null;
        throw error;
      });
    }
    return connection;
  }

  const store: IndexedDbTripStore = {
    backend: 'indexeddb',

    get persistent(): boolean {
      return persistent;
    },

    get problem(): string | null {
      return null;
    },

    get migration(): MigrationResult | null {
      return migration;
    },

    ready(): Promise<void> {
      return db().then(() => undefined);
    },

    close(): void {
      const current = connection;
      connection = null;
      void current?.then((database) => database.close()).catch(() => undefined);
    },

    async requestPersistence(): Promise<boolean> {
      try {
        persistent = await persist();
      } catch {
        persistent = false;
      }
      return persistent;
    },

    async usage(): Promise<StorageUsage | null> {
      const result = await estimate();
      // Absent figures are unknown, not zero (docs/12 §4): omit the line rather
      // than print "0 MB used".
      if (!result || (result.usage === undefined && result.quota === undefined)) return null;
      return {
        usedBytes: result.usage ?? 0,
        quotaBytes: result.quota ?? 0,
        source: 'indexeddb',
      };
    },

    async list(): Promise<StoredTripSummary[]> {
      const database = await db();
      const rows = await inTransaction(database, [SUMMARIES], 'readonly', async (tx) => {
        const summaries = tx.objectStore(SUMMARIES);
        // The index gives the newest-first order without loading a single body.
        const get = summaries.indexNames.contains(UPDATED_AT_INDEX)
          ? summaries.index(UPDATED_AT_INDEX).getAll()
          : summaries.getAll();
        return request(get as IDBRequest<StoredTripSummary[]>);
      });
      return [...rows].sort(byUpdatedAtDesc);
    },

    async load(id: string): Promise<Trip | null> {
      const database = await db();
      const raw = await inTransaction(database, [BODIES], 'readonly', (tx) =>
        request(tx.objectStore(BODIES).get(id) as IDBRequest<unknown>),
      );
      if (raw === undefined || raw === null) return null;
      try {
        // A body written by an older shape is migrated; a string is what the
        // localStorage era stored, and is accepted for an in-place upgrade.
        return migrate(typeof raw === 'string' ? JSON.parse(raw) : raw);
      } catch (error) {
        if (error instanceof StoreError && error.code === 'unsupported') throw error;
        return null;
      }
    },

    async save(trip: Trip): Promise<void> {
      const body = normalise(trip);
      const bytes = measure(body);
      if (bytes > maxBytes) throw ceilingError(body, bytes, maxBytes);

      const database = await db();
      const summary = summarize(body, bytes);
      try {
        // One transaction: a body and its summary are written together or not
        // at all, so a crash cannot leave a row that points at nothing.
        await inTransaction(database, [BODIES, SUMMARIES], 'readwrite', (tx) => {
          tx.objectStore(BODIES).put(body);
          tx.objectStore(SUMMARIES).put(summary);
        });
      } catch (error) {
        throw writeError(error, body, bytes);
      }
    },

    async remove(id: string): Promise<void> {
      const database = await db();
      await inTransaction(database, [BODIES, SUMMARIES], 'readwrite', (tx) => {
        tx.objectStore(BODIES).delete(id);
        tx.objectStore(SUMMARIES).delete(id);
      });
    },

    toGpx(trip, gpxOptions) {
      return serializer.toGpx(trip, gpxOptions);
    },

    toGeoJson(trip) {
      return serializer.toGeoJson(trip);
    },

    fromFile(text, filename) {
      return serializer.fromFile(text, filename);
    },

    async migrateLegacy(storage?: Storage | null): Promise<MigrationResult> {
      const legacy = resolveStorage(storage);
      const candidates = readLegacyCandidates(legacy);
      const readable = candidates.filter((candidate) => candidate.trip !== null);
      const skipped = candidates.length - readable.length;
      const empty: MigrationResult = { imported: 0, removed: 0, skipped };
      if (readable.length === 0) {
        migration = empty;
        return empty;
      }

      try {
        const database = await db();
        const existing = await inTransaction(database, [SUMMARIES], 'readonly', (tx) =>
          request(tx.objectStore(SUMMARIES).getAll() as IDBRequest<StoredTripSummary[]>),
        );
        const known = new Map(existing.map((row) => [row.id, row]));

        // A trip already in IndexedDB wins when it is at least as new, so
        // running the migration twice cannot roll a newer edit back.
        const writes = readable.filter((candidate) => {
          const current = known.get(candidate.id);
          return !current || current.updatedAt < candidate.trip!.updatedAt;
        });
        const handled = readable.map((candidate) => candidate.id);

        await inTransaction(database, [BODIES, SUMMARIES], 'readwrite', (tx) => {
          const bodies = tx.objectStore(BODIES);
          const summaries = tx.objectStore(SUMMARIES);
          for (const candidate of writes) {
            const trip = candidate.trip!;
            const bytes = byteSize(JSON.stringify(trip));
            bodies.put(trip);
            summaries.put(summarize(trip, bytes));
          }
        });

        // Committed. Only now is it safe to drop the localStorage copies.
        const removed = removeLegacyKeys(legacy, handled);
        const result: MigrationResult = { imported: writes.length, removed, skipped };
        migration = result;
        return result;
      } catch (error) {
        // Nothing was removed: the localStorage trips are still the only copy.
        const failed: MigrationResult = {
          imported: 0,
          removed: 0,
          skipped,
          error: messageOf(error),
        };
        migration = failed;
        return failed;
      }
    },
  };

  return store;
}

/* The serialisers are storage-free, so both backends share them verbatim. */
const serializer = {
  toGpx: serializeGpx,
  toGeoJson: serializeGeoJson,
  fromFile: parseFile,
};

/* ------------------------------------------------------------------ */
/* Legacy localStorage migration                                       */
/* ------------------------------------------------------------------ */

interface LegacyCandidate {
  readonly id: string;
  readonly key: string;
  readonly trip: Trip | null;
}

function legacyIds(storage: Storage): string[] {
  const ids = new Set<string>();
  try {
    const raw = storage.getItem(INDEX_KEY);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const id of parsed) if (typeof id === 'string') ids.add(id);
      }
    }
  } catch {
    // A corrupt index is no reason to lose the bodies next to it.
  }
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key && key.startsWith(TRIP_KEY_PREFIX)) ids.add(key.slice(TRIP_KEY_PREFIX.length));
    }
  } catch {
    // unreadable storage: nothing to migrate
  }
  return [...ids];
}

/** Read and validate every legacy body. Unreadable ones are kept, not deleted. */
function readLegacyCandidates(storage: Storage): LegacyCandidate[] {
  const candidates: LegacyCandidate[] = [];
  for (const id of legacyIds(storage)) {
    let raw: string | null;
    try {
      raw = storage.getItem(tripKey(id));
    } catch {
      raw = null;
    }
    if (raw === null) continue;
    let trip: Trip | null = null;
    try {
      trip = migrate(JSON.parse(raw));
    } catch {
      trip = null;
    }
    candidates.push({ id, key: tripKey(id), trip });
  }
  return candidates;
}

/**
 * Drop the legacy keys, after the IndexedDB transaction committed. Returns how
 * many body keys were removed. Unreadable bodies keep their key *and* stay in
 * the index, so a later build can still find them.
 */
function removeLegacyKeys(storage: Storage, handled: readonly string[]): number {
  const handledSet = new Set(handled);
  let removed = 0;
  for (const id of handled) {
    try {
      storage.removeItem(tripKey(id));
      removed += 1;
    } catch {
      // ignore: leaving a copy behind is not a loss
    }
  }
  try {
    const raw = storage.getItem(INDEX_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    const ids = Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
    const remaining = ids.filter((id) => !handledSet.has(id));
    if (remaining.length === 0) storage.removeItem(INDEX_KEY);
    else storage.setItem(INDEX_KEY, JSON.stringify(remaining));
  } catch {
    // A corrupt index is left for the next run to reconcile.
  }
  return removed;
}

/* ------------------------------------------------------------------ */
/* The localStorage fallback, wearing the async interface              */
/* ------------------------------------------------------------------ */

function legacyByteSize(storage: Storage, id: string): number {
  try {
    const raw = storage.getItem(tripKey(id));
    return raw === null ? 0 : byteSize(raw);
  } catch {
    return 0;
  }
}

export function asAsyncTripStore(
  store: TripStoreLike,
  problem: string | null,
  storage?: Storage | null,
): AsyncTripStore {
  const backend = resolveStorage(storage);
  return {
    backend: 'localstorage',
    persistent: false,
    problem,
    migration: null,
    async list(): Promise<StoredTripSummary[]> {
      const summaries = await store.list();
      // The localStorage store has already read every body to summarise it, so
      // the size is a re-read of a string that is in memory anyway.
      return summaries.map((summary) => ({
        ...summary,
        byteSize: legacyByteSize(backend, summary.id),
      }));
    },
    async load(id: string) {
      return store.load(id);
    },
    async save(trip: Trip) {
      return store.save(trip);
    },
    async remove(id: string) {
      return store.remove(id);
    },
    toGpx(trip, options) {
      return store.toGpx(trip, options);
    },
    toGeoJson(trip) {
      return store.toGeoJson(trip);
    },
    fromFile(text, filename) {
      return store.fromFile(text, filename);
    },
    async usage(): Promise<StorageUsage> {
      return {
        usedBytes: localStorageUsage(backend),
        quotaBytes: LOCALSTORAGE_QUOTA_BYTES,
        source: 'localstorage-estimate',
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Choosing a backend                                                  */
/* ------------------------------------------------------------------ */

export interface TripStorageOptions {
  /** Where the legacy trips live (and where the fallback writes). */
  storage?: Storage | null;
  /** `null` forces the fallback, which is how the fallback is tested. */
  factory?: IDBFactory | null;
  dbName?: string;
  version?: number;
  maxBytes?: number;
  estimate?: () => Promise<{ usage?: number; quota?: number } | null>;
  persist?: () => Promise<boolean>;
  /** Skip the localStorage import (tests that assert on a clean database). */
  migrate?: boolean;
}

/**
 * The backend the app should use: IndexedDB when the browser has it, the
 * localStorage store when it does not (private mode, blocked storage), never
 * both and never a silent choice — the returned store says which it is and why.
 */
export async function createTripStorage(options: TripStorageOptions = {}): Promise<AsyncTripStore> {
  const legacy = resolveStorage(options.storage);
  const factory = options.factory === undefined ? defaultFactory() : options.factory;

  if (!factory) {
    return asAsyncTripStore(
      createTripStore(legacy),
      'IndexedDB is not available in this browser (private mode or blocked storage), so trips ' +
        'are kept in localStorage, which holds about 5 MB in total.',
      legacy,
    );
  }

  const store = createIndexedDbTripStore({
    factory,
    dbName: options.dbName,
    version: options.version,
    maxBytes: options.maxBytes,
    estimate: options.estimate,
    persist: options.persist,
  });

  try {
    await store.ready();
  } catch (error) {
    store.close();
    return asAsyncTripStore(
      createTripStore(legacy),
      `IndexedDB could not be opened (${messageOf(error)}), so trips are kept in localStorage, ` +
        'which holds about 5 MB in total.',
      legacy,
    );
  }

  // Best effort, once: ask the browser not to evict this origin's data.
  await store.requestPersistence();
  // Idempotent, and never throws: a failed import leaves the old keys in place.
  if (options.migrate !== false) await store.migrateLegacy(legacy);
  return store;
}
