import { describe, expect, it } from 'vitest';

import { DEFAULT_PACE, PACE_LIMITS } from '../src/lib/format';
import { PACE_STORAGE_KEY, loadPace, savePace } from '../src/ui/pace-store';

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    value: (key: string) => data.get(key) ?? null,
  };
}

describe('pace storage', () => {
  it('falls back to the documented Naismith defaults, round-trips a saved pace and clamps out-of-range values', () => {
    expect(loadPace(fakeStorage())).toEqual(DEFAULT_PACE);
    expect(DEFAULT_PACE).toEqual({ speedKmh: 5, ascentMPerHour: 600 });

    const storage = fakeStorage();
    savePace(storage, { speedKmh: 4, ascentMPerHour: 450 });
    expect(JSON.parse(storage.value(PACE_STORAGE_KEY)!)).toEqual({ speedKmh: 4, ascentMPerHour: 450 });
    expect(loadPace(storage)).toEqual({ speedKmh: 4, ascentMPerHour: 450 });

    const clamped = fakeStorage({
      [PACE_STORAGE_KEY]: JSON.stringify({ speedKmh: 99, ascentMPerHour: 1 }),
    });
    expect(loadPace(clamped)).toEqual({
      speedKmh: PACE_LIMITS.speedKmh.max,
      ascentMPerHour: PACE_LIMITS.ascentMPerHour.min,
    });
  });

  it('survives corrupt, null and blocked storage, and never throws when writing fails', () => {
    expect(loadPace(fakeStorage({ [PACE_STORAGE_KEY]: '{not json' }))).toEqual(DEFAULT_PACE);
    expect(loadPace(fakeStorage({ [PACE_STORAGE_KEY]: 'null' }))).toEqual(DEFAULT_PACE);
    expect(loadPace(null)).toEqual(DEFAULT_PACE);
    expect(() => savePace(null, DEFAULT_PACE)).not.toThrow();

    // Private mode: setItem throws.
    const blocked = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(() => savePace(blocked, DEFAULT_PACE)).not.toThrow();
  });
});
