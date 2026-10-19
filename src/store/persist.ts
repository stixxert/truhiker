/**
 * The pieces both backends share: key names, byte accounting, the quota-error
 * detector, and the summary projection.
 *
 * Kept in its own module so `index.ts` (the synchronous localStorage store) and
 * `indexeddb.ts` (the durable one) can use them without importing each other.
 */

import type { Trip, TripSummary } from '../contracts';
import type { StoredTripSummary } from './types';

/** Index key. The `:v1` suffix namespaces the storage generation. */
export const INDEX_KEY = 'npl:trips:v1';
/** Body key prefix; the trip id is appended verbatim. */
export const TRIP_KEY_PREFIX = 'npl:trip:';

export function tripKey(id: string): string {
  return `${TRIP_KEY_PREFIX}${id}`;
}

/** UTF-8 byte length of a string. Exported for the error messages and tests. */
export function byteSize(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function formatBytes(bytes: number): string {
  const mb = bytes / 1_000_000;
  return `${bytes} bytes (${mb.toFixed(2)} MB)`;
}

/**
 * `QuotaExceededError` is spelled three ways in the wild: `name` in modern
 * browsers (and in IndexedDB's `DOMException`), `code` 22 (DOM) or 1014
 * (Firefox's `NS_ERROR_DOM_QUOTA_REACHED`), and occasionally only a message.
 */
export function isQuotaError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown };
  if (candidate.name === 'QuotaExceededError' || candidate.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
    return true;
  }
  if (candidate.code === 22 || candidate.code === 1014) return true;
  return typeof candidate.message === 'string' && /quota|exceeded/i.test(candidate.message);
}

/**
 * The one row in the `summaries` store. `distanceM` is `null` — never `0` —
 * when any leg has an unknown distance or the trip has no legs at all.
 */
export function summarize(trip: Trip, bytes: number): StoredTripSummary {
  let distance: number | null = 0;
  for (const leg of trip.legs) {
    if (leg.distanceM === null || leg.distanceM === undefined) {
      distance = null;
      break;
    }
    distance += leg.distanceM;
  }
  const summary: TripSummary & { byteSize: number } = {
    id: trip.id,
    name: trip.name,
    updatedAt: trip.updatedAt,
    legCount: trip.legs.length,
    distanceM: trip.legs.length === 0 ? null : distance,
    byteSize: bytes,
  };
  return summary;
}

/** Newest first; equal or unparsable dates keep their relative order. */
export function byUpdatedAtDesc(a: { updatedAt: string }, b: { updatedAt: string }): number {
  return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
}
