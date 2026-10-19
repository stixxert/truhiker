/**
 * The trip library, as data.
 *
 * Each saved trip becomes one row: name, distance, last updated. The view also
 * carries the states that are easy to forget — an empty library, an unreadable
 * index, and a store that is not available at all — so the dialog can never be
 * blank.
 */

import type { TripSummary } from '../contracts';
import type { I18n } from '../i18n';
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
}

/** Date only, short form — the trip list is a list, not a changelog. */
export function formatTripDate(iso: string, locale: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

export interface TripLibraryInput {
  summaries: readonly TripSummary[];
  currentId: string | null;
  problem: SaveStatus | null;
  importEnabled: boolean;
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
  };
}
