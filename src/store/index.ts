/**
 * Trip persistence in `localStorage`, plus GPX/GeoJSON import and export.
 *
 * Key layout (nothing else is ever written):
 *
 *   npl:trips:v1   → JSON array of trip ids, newest first
 *   npl:trip:<id>  → one JSON object: the trip, exactly as saved
 *
 * Reads are defensive: a corrupt index is rewritten to `[]` rather than thrown,
 * and a corrupt body yields `null`, so one bad trip cannot make the app
 * unusable. Writes are strict: a trip that does not validate, or that is too big
 * for the quota, raises `StoreError` — nothing is ever silently truncated.
 *
 * See `README.md` next to this file for the size limit, the metadata contract
 * and the round-trip guarantee.
 */

import { StoreError } from '../contracts';
import type { Trip, TripStore, TripSummary } from '../contracts';
import { fromFile as parseFile, toGeoJson as serializeGeoJson, toGpx as serializeGpx } from './serialize';
import type { GpxOptions } from './serialize';
import { migrate, validateTrip } from './trip';

export { emptyTrip, defaultProfile } from './trip';

/** Index key. The `:v1` suffix namespaces the storage generation. */
export const INDEX_KEY = 'npl:trips:v1';
/** Body key prefix; the trip id is appended verbatim. */
export const TRIP_KEY_PREFIX = 'npl:trip:';

/**
 * Refuse to store a trip whose serialised JSON exceeds this many UTF-8 bytes.
 *
 * localStorage is ~5 MB per origin and stores UTF-16 code units, so 1.5 MB of
 * UTF-8 is already close to 3 MB of quota — leaving room for the app's other
 * keys. Roughly: a 3,000 km trace with provenance is 5–10 MB of JSON, so the
 * guard trips long before the quota does, and says so with an actionable message
 * (download the GPX) instead of failing opaquely.
 */
export const MAX_TRIP_BYTES = 1_500_000;

export function tripKey(id: string): string {
  return `${TRIP_KEY_PREFIX}${id}`;
}

/** UTF-8 byte length of a string. Exported for the error messages and tests. */
export function byteSize(text: string): number {
  return new TextEncoder().encode(text).length;
}

function formatBytes(bytes: number): string {
  const mb = bytes / 1_000_000;
  return `${bytes} bytes (${mb.toFixed(2)} MB)`;
}

/* ------------------------------------------------------------------ */
/* Storage plumbing                                                    */
/* ------------------------------------------------------------------ */

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

function resolveStorage(storage?: Storage): Storage {
  if (storage) return storage;
  try {
    const candidate = (globalThis as { localStorage?: Storage }).localStorage;
    if (candidate) return candidate;
  } catch {
    // Access can throw in Safari private mode and in some embedded webviews.
  }
  return memoryStorage();
}

/**
 * `QuotaExceededError` is spelled three ways in the wild: `name` in modern
 * browsers, `code` 22 (DOM) or 1014 (Firefox's `NS_ERROR_DOM_QUOTA_REACHED`),
 * and occasionally only a message.
 */
function isQuotaError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown };
  if (candidate.name === 'QuotaExceededError' || candidate.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
    return true;
  }
  if (candidate.code === 22 || candidate.code === 1014) return true;
  return typeof candidate.message === 'string' && /quota|exceeded/i.test(candidate.message);
}

/* ------------------------------------------------------------------ */
/* Index handling                                                      */
/* ------------------------------------------------------------------ */

function readIndex(storage: Storage): string[] {
  let raw: string | null = null;
  try {
    raw = storage.getItem(INDEX_KEY);
  } catch {
    return [];
  }
  if (raw === null) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    rewriteIndex(storage, []);
    return [];
  }
  if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== 'string')) {
    rewriteIndex(storage, []);
    return [];
  }
  // De-duplicate while keeping order; a duplicated id would otherwise show twice.
  return [...new Set(parsed as string[])];
}

function rewriteIndex(storage: Storage, ids: readonly string[]): void {
  try {
    storage.setItem(INDEX_KEY, JSON.stringify(ids));
  } catch {
    // A corrupt index that we cannot repair is still better than a thrown list().
  }
}

function writeIndex(storage: Storage, ids: readonly string[], bytesHint?: number): void {
  try {
    storage.setItem(INDEX_KEY, JSON.stringify(ids));
  } catch (error) {
    if (isQuotaError(error)) {
      throw new StoreError(
        'quota-exceeded',
        `Could not update the trip index: storage quota exceeded` +
          (bytesHint === undefined ? '' : ` while writing ${formatBytes(bytesHint)}`) +
          `. Download the trip as GPX instead, then free some space.`,
      );
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Per-trip read/write                                                 */
/* ------------------------------------------------------------------ */

/** Parse a stored body. Returns null for anything unreadable, rethrows `unsupported`. */
function parseBody(raw: string): Trip | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  try {
    return migrate(parsed);
  } catch (error) {
    // A body from a future build is a real condition the user must see.
    if (error instanceof StoreError && error.code === 'unsupported') throw error;
    return null;
  }
}

function readBody(storage: Storage, id: string): { trip: Trip | null; bytes: number; raw: string | null } {
  let raw: string | null;
  try {
    raw = storage.getItem(tripKey(id));
  } catch {
    return { trip: null, bytes: 0, raw: null };
  }
  if (raw === null) return { trip: null, bytes: 0, raw: null };
  return { trip: parseBody(raw), bytes: byteSize(raw), raw };
}

function summaryOf(trip: Trip): TripSummary {
  let distance: number | null = 0;
  for (const leg of trip.legs) {
    if (leg.distanceM === null || leg.distanceM === undefined) {
      distance = null;
      break;
    }
    distance += leg.distanceM;
  }
  return {
    id: trip.id,
    name: trip.name,
    updatedAt: trip.updatedAt,
    legCount: trip.legs.length,
    distanceM: trip.legs.length === 0 ? null : distance,
  };
}

/* ------------------------------------------------------------------ */
/* The store                                                           */
/* ------------------------------------------------------------------ */

/**
 * Create a trip store over `storage` (defaults to `localStorage`, falling back
 * to memory when there is none — Node, tests, private-mode failures).
 */
export function createTripStore(storage?: Storage): TripStore {
  const backend = resolveStorage(storage);

  const store: TripStore = {
    list(): TripSummary[] {
      const summaries: TripSummary[] = [];
      for (const id of readIndex(backend)) {
        let trip: Trip | null = null;
        try {
          trip = readBody(backend, id).trip;
        } catch {
          // A body from a newer build cannot be summarised. It is not deleted —
          // `load()` still throws `unsupported` and the UI can explain why.
          trip = null;
        }
        if (trip) summaries.push(summaryOf(trip));
      }
      // Newest first; unparsable dates sort last rather than throwing.
      return summaries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    },

    load(id: string): Trip | null {
      // `unsupported` (a body from a newer build) propagates: the UI must be able
      // to tell the user why the trip will not open.
      return readBody(backend, id).trip;
    },

    save(trip: Trip): void {
      if (typeof trip.id !== 'string' || trip.id === '') {
        throw new StoreError('corrupt', 'Cannot save a trip without an id.');
      }
      validateTrip(trip);

      const json = JSON.stringify(trip);
      const bytes = byteSize(json);
      if (bytes > MAX_TRIP_BYTES) {
        throw new StoreError(
          'quota-exceeded',
          `Trip "${trip.name}" is ${formatBytes(bytes)}, over the ${formatBytes(
            MAX_TRIP_BYTES,
          )} storage limit (localStorage holds about 5 MB). Nothing was saved. ` +
            `Download it as GPX instead — the round trip is lossless.`,
        );
      }

      let previousBody: string | null = null;
      try {
        previousBody = backend.getItem(tripKey(trip.id));
      } catch {
        // unreadable storage: nothing to roll back to
      }

      try {
        backend.setItem(tripKey(trip.id), json);
      } catch (error) {
        if (isQuotaError(error)) {
          throw new StoreError(
            'quota-exceeded',
            `Could not save "${trip.name}": storage quota exceeded while writing ${formatBytes(
              bytes,
            )}. Download the trip as GPX instead, then remove an old trip to free space.`,
          );
        }
        throw error;
      }

      // The index is written last: a body without an index entry is invisible but
      // harmless, whereas an index entry without a body would be a broken row.
      const ids = readIndex(backend);
      const next = [trip.id, ...ids.filter((existing) => existing !== trip.id)];
      try {
        writeIndex(backend, next, bytes);
      } catch (error) {
        // Roll the body back: on a re-save the previous version must survive.
        try {
          if (previousBody === null) backend.removeItem(tripKey(trip.id));
          else backend.setItem(tripKey(trip.id), previousBody);
        } catch {
          // ignore: the body is orphaned, but nothing is lost from the index
        }
        throw error;
      }
    },

    remove(id: string): void {
      try {
        backend.removeItem(tripKey(id));
      } catch {
        // ignore: removing an unreachable body must not break the list
      }
      const ids = readIndex(backend);
      if (ids.includes(id)) writeIndex(backend, ids.filter((existing) => existing !== id));
    },

    toGpx(trip: Trip, options?: GpxOptions): string {
      return serializeGpx(trip, options);
    },

    toGeoJson(trip: Trip): string {
      return serializeGeoJson(trip);
    },

    fromFile(text: string, filename: string): Trip {
      return parseFile(text, filename);
    },
  };

  return store;
}

export type { GpxOptions };
