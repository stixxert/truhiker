/**
 * Human labels for a snap result.
 *
 * Turrutebasen route names are frequently the literal string "Ukjent", so a
 * label that blindly prints `rutenavn` would read "snapper til Ukjent" — worse
 * than no label. Route number, then name, then a short id, in that order.
 */

import type { TurruteAttributes } from '../snap';

interface SnapRouteLabel {
  /** Route number if present, e.g. "jot21". */
  readonly number: string | null;
  /** Usable name, or `null` when the source says "Ukjent"/empty. */
  readonly name: string | null;
  /** Short id fallback, so the indicator is never blank. */
  readonly shortId: string;
  /** `number · name`, `name`, `number`, or the short id. */
  readonly label: string;
}

const PLACEHOLDER_NAMES = new Set(['ukjent', 'unknown', '-', '']);

export function snapRouteLabel(
  attributes: Pick<TurruteAttributes, 'rutenavn' | 'rutenummer' | 'lokalId'>,
): SnapRouteLabel {
  const rawName = (attributes.rutenavn ?? '').trim();
  const name = PLACEHOLDER_NAMES.has(rawName.toLowerCase()) ? null : rawName;
  const number = (attributes.rutenummer ?? '').trim() || null;
  const shortId = (attributes.lokalId ?? '').slice(0, 8);
  const parts = [number, name].filter((part): part is string => part !== null);
  const label = parts.length > 0 ? parts.join(' · ') : shortId.length > 0 ? shortId : '—';
  return { number, name, shortId, label };
}
