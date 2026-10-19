/**
 * Persisted Naismith pace. Kept out of the app class so the parse/validate path
 * is testable without a browser.
 */

import { DEFAULT_PACE, normalizePace, type Pace } from '../lib/format';

export const PACE_STORAGE_KEY = 'ruteanalyse.pace';

export function loadPace(storage: Pick<Storage, 'getItem'> | null): Pace {
  if (!storage) return { ...DEFAULT_PACE };
  let raw: string | null;
  try {
    raw = storage.getItem(PACE_STORAGE_KEY);
  } catch {
    // Private mode / blocked storage: defaults are a perfectly good pace.
    return { ...DEFAULT_PACE };
  }
  if (!raw) return { ...DEFAULT_PACE };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return { ...DEFAULT_PACE };
    return normalizePace(parsed as Partial<Pace>);
  } catch {
    // Corrupt storage is not worth a banner: fall back to the documented
    // default and overwrite on the next save.
    return { ...DEFAULT_PACE };
  }
}

export function savePace(storage: Pick<Storage, 'setItem'> | null, pace: Pace): void {
  if (!storage) return;
  try {
    storage.setItem(PACE_STORAGE_KEY, JSON.stringify(normalizePace(pace)));
  } catch {
    // Persistence is a convenience; the in-memory pace still applies.
  }
}
