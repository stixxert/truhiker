/**
 * The trip library, as data.
 *
 * Each saved trip becomes one row: name, distance, last updated. The view also
 * carries the states that are easy to forget — an empty library, an unreadable
 * index, and a store that is not available at all — so the dialog can never be
 * blank.
 */

import type { TripSummary } from '../contracts';
import { formatDay, type I18n } from '../i18n';
import type { SaveStatus } from '../app/trip-session';

export interface TripRowView {
  readonly id: string;
  readonly name: string;
  readonly updatedLabel: string;
  readonly distanceLabel: string;
  readonly legCountLabel: string;
  readonly isCurrent: boolean;
}

export interface TripLibraryView {
  readonly rows: readonly TripRowView[];
  readonly empty: boolean;
  readonly emptyMessage: string | null;
  /** Explanation when the index could not be read (corrupt, blocked). */
  readonly problem: string | null;
  readonly problemDetail: string | null;
  readonly importEnabled: boolean;
  /** "IndexedDB · 12.3 MB of ~8 GB used". Empty when nothing is known. */
  readonly storageLabel: string;
  /** Visible warning when storage is not what it should be. Never silent. */
  readonly storageNote: string | null;
  /** The technical reason behind `storageNote`, for a tooltip. */
  readonly storageDetail: string | null;
}

/**
 * What the library should say about storage. Gathered from the session, which
 * asks the backend itself — the view only formats it.
 */
interface TripLibraryStorage {
  readonly backend: 'indexeddb' | 'localstorage';
  readonly persistent: boolean;
  readonly usedBytes: number | null;
  readonly quotaBytes: number | null;
  /** Why IndexedDB is not in use, when it is not. */
  readonly problem: string | null;
  /** Trips imported from localStorage on this load. */
  readonly migrated: number;
  /** A failed migration message; the old copies are still there. */
  readonly migrationError: string | null;
}

/**
 * Date only, short form — the trip list is a list, not a changelog. The day is
 * taken in Europe/Oslo (D8): a save at 23:30 UTC on 30 June is 1 July in Oslo,
 * and the list must not show a different day from the save status line.
 */
export function formatTripDate(iso: string, locale: string): string {
  return formatDay(iso, locale, { year: 'numeric', month: 'short', day: 'numeric' });
}

interface TripLibraryInput {
  summaries: readonly TripSummary[];
  currentId: string | null;
  problem: SaveStatus | null;
  importEnabled: boolean;
  /** `null` while the backend is still being opened. */
  storage?: TripLibraryStorage | null;
}

/** Bytes as "12.3 MB" / "1.2 GB", in the UI's locale. */
function formatBytes(bytes: number, locale: string): string {
  const megabytes = bytes / 1_000_000;
  const value = megabytes >= 1000 ? megabytes / 1000 : megabytes;
  const unit = megabytes >= 1000 ? 'GB' : 'MB';
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
  return `${number} ${unit}`;
}

function storageParts(
  storage: TripLibraryStorage | null | undefined,
  i18n: Pick<I18n, 't' | 'locale'>,
): Pick<TripLibraryView, 'storageLabel' | 'storageNote' | 'storageDetail'> {
  if (!storage) return { storageLabel: '', storageNote: null, storageDetail: null };

  const parts: string[] = [i18n.t(storage.backend === 'indexeddb' ? 'storage.indexeddb' : 'storage.localstorage')];
  // The size of what we store, and nothing else. `navigator.storage.estimate()
  // .quota` is a browser heuristic about the disk (it reads as "~247 GB" on a
  // laptop), not a limit this origin can fill or that a user can act on.
  if (storage.usedBytes !== null) {
    parts.push(i18n.t('storage.used', { used: formatBytes(storage.usedBytes, i18n.locale) }));
  }
  if (storage.backend === 'indexeddb') {
    parts.push(i18n.t(storage.persistent ? 'storage.persistent' : 'storage.notPersistent'));
  }
  if (storage.migrated > 0) parts.push(i18n.t('storage.migrated', { n: storage.migrated }));

  const notes: string[] = [];
  const details: string[] = [];
  if (storage.backend !== 'indexeddb') {
    notes.push(i18n.t('storage.fallback'));
    if (storage.problem) details.push(storage.problem);
  }
  if (storage.migrationError) {
    notes.push(i18n.t('storage.migrationFailed'));
    details.push(storage.migrationError);
  }

  return {
    storageLabel: parts.join(' · '),
    storageNote: notes.length > 0 ? notes.join(' ') : null,
    storageDetail: details.length > 0 ? details.join('\n') : null,
  };
}

export function buildTripLibraryView(
  input: TripLibraryInput,
  i18n: Pick<I18n, 't' | 'locale' | 'format'>,
): TripLibraryView {
  const rows: TripRowView[] = input.summaries.map((summary) => ({
    id: summary.id,
    name: summary.name.trim().length > 0 ? summary.name : i18n.t('trips.untitled'),
    updatedLabel: i18n.t('trips.updated', {
      date: formatTripDate(summary.updatedAt, i18n.locale),
    }),
    distanceLabel:
      summary.distanceM === null ? i18n.t('trips.unknownDistance') : i18n.format.distance(summary.distanceM),
    legCountLabel: i18n.t('trips.legCount', {
      n: summary.legCount,
      unit: i18n.t(summary.legCount === 1 ? 'trips.unitLegOne' : 'trips.unitLegMany'),
    }),
    isCurrent: summary.id === input.currentId,
  }));

  const problem =
    input.problem && (input.problem.kind === 'error' || input.problem.kind === 'unavailable')
      ? i18n.t(input.problem.code === 'corrupt' ? 'store.corrupt' : 'store.indexUnreadable')
      : null;

  return {
    rows,
    empty: rows.length === 0,
    emptyMessage: rows.length === 0 ? i18n.t('trips.empty') : null,
    problem,
    problemDetail: input.problem?.message ?? null,
    importEnabled: input.importEnabled,
    ...storageParts(input.storage, i18n),
  };
}
