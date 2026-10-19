import { describe, expect, it } from 'vitest';

import type { TripSummary } from '../src/contracts';
import { createI18n } from '../src/i18n';
import {
  buildTripLibraryView,
  formatTripDate,
} from '../src/ui/trip-library-view';
import { weatherSymbolFamily, normalizeSymbolCode } from '../src/lib/weather-symbol';
import { snapRouteLabel } from '../src/lib/snap-label';
import { flattenTrip, isPlaceholderLeg, localIndex, globalIndex, spanAt } from '../src/lib/trip-route';
import type { Leg, Trip } from '../src/contracts';

function summary(overrides: Partial<TripSummary> = {}): TripSummary {
  return {
    id: 'trip-1',
    name: 'Jotunheimen',
    updatedAt: '2026-07-01T12:00:00.000Z',
    legCount: 3,
    distanceM: 14_300,
    ...overrides,
  };
}

describe('trip library view', () => {
  it('renders name, distance, updated date and leg count', () => {
    const view = buildTripLibraryView(
      { summaries: [summary()], currentId: 'trip-1', problem: null, importEnabled: true },
      createI18n('no'),
    );
    expect(view.empty).toBe(false);
    expect(view.rows[0].name).toBe('Jotunheimen');
    expect(view.rows[0].distanceLabel).toBe('14,3 km');
    expect(view.rows[0].legCountLabel).toBe('3 etapper');
    expect(view.rows[0].updatedLabel).toContain('2026');
    expect(view.rows[0].isCurrent).toBe(true);
    // A junk date is echoed, never "Invalid Date".
    expect(formatTripDate('2026-07-01T12:00:00.000Z', 'en-GB')).toContain('2026');
    expect(formatTripDate('not-a-date', 'en-GB')).toBe('not-a-date');
  });

  it('states where the trips live and how full it is, and warns when it fell back', () => {
    const durable = buildTripLibraryView(
      {
        summaries: [summary()],
        currentId: null,
        problem: null,
        importEnabled: true,
        storage: {
          backend: 'indexeddb',
          persistent: true,
          usedBytes: 12_300_000,
          quotaBytes: 8_000_000_000,
          problem: null,
          migrated: 2,
          migrationError: null,
        },
      },
      createI18n('en'),
    );
    expect(durable.storageLabel).toContain('IndexedDB');
    expect(durable.storageLabel).toContain('12.3 MB of ~8 GB used');
    expect(durable.storageLabel).toContain('persistent storage');
    expect(durable.storageLabel).toContain('2 moved from localStorage');
    expect(durable.storageNote).toBeNull();

    const fallback = buildTripLibraryView(
      {
        summaries: [],
        currentId: null,
        problem: null,
        importEnabled: true,
        storage: {
          backend: 'localstorage',
          persistent: false,
          usedBytes: 900_000,
          quotaBytes: null,
          problem: 'IndexedDB is not available',
          migrated: 0,
          migrationError: 'transaction aborted',
        },
      },
      createI18n('no'),
    );
    expect(fallback.storageLabel).toContain('localStorage');
    expect(fallback.storageNote).toContain('IndexedDB er utilgjengelig');
    expect(fallback.storageNote).toContain('localStorage');
    expect(fallback.storageDetail).toContain('transaction aborted');

    // No backend yet: say nothing rather than guess.
    const unknown = buildTripLibraryView(
      { summaries: [], currentId: null, problem: null, importEnabled: true, storage: null },
      createI18n('no'),
    );
    expect(unknown.storageLabel).toBe('');
    expect(unknown.storageNote).toBeNull();
  });

  it('shows an explicit empty state and an unknown distance honestly', () => {
    const empty = buildTripLibraryView(
      { summaries: [], currentId: null, problem: null, importEnabled: true },
      createI18n('en'),
    );
    expect(empty.empty).toBe(true);
    expect(empty.emptyMessage).toContain('No trips are saved yet');

    const unknown = buildTripLibraryView(
      { summaries: [summary({ distanceM: null, name: '  ' })], currentId: null, problem: null, importEnabled: true },
      createI18n('en'),
    );
    expect(unknown.rows[0].distanceLabel).toBe('Distance unknown');
    expect(unknown.rows[0].name).toBe('Untitled');
    expect(unknown.rows[0].isCurrent).toBe(false);
  });

  it('surfaces an unreadable index rather than an empty list with no reason', () => {
    const view = buildTripLibraryView(
      {
        summaries: [],
        currentId: null,
        problem: { kind: 'error', code: 'corrupt', message: 'index unreadable' },
        importEnabled: false,
      },
      createI18n('no'),
    );
    expect(view.problem).toContain('skadet');
    expect(view.problemDetail).toBe('index unreadable');
    expect(view.importEnabled).toBe(false);
  });
});

describe('weather symbol families', () => {
  it('normalises day/night/polar-twilight suffixes', () => {
    expect(normalizeSymbolCode('clearsky_polartwilight')).toBe('clearsky');
    expect(normalizeSymbolCode('PartlyCloudy_Night')).toBe('partlycloudy');
  });

  it('classifies the MET vocabulary into a small set', () => {
    expect(weatherSymbolFamily('clearsky_day')).toBe('clear');
    expect(weatherSymbolFamily('fair_night')).toBe('fair');
    expect(weatherSymbolFamily('partlycloudy_day')).toBe('partly-cloudy');
    expect(weatherSymbolFamily('cloudy')).toBe('cloudy');
    expect(weatherSymbolFamily('fog')).toBe('fog');
    expect(weatherSymbolFamily('lightrain')).toBe('rain');
    expect(weatherSymbolFamily('heavyrainshowers_day')).toBe('rain');
    expect(weatherSymbolFamily('lightsleet')).toBe('sleet');
    expect(weatherSymbolFamily('heavysnowshowers_night')).toBe('snow');
    // Thunder wins: it is the fact that changes the plan.
    expect(weatherSymbolFamily('rainandthunder')).toBe('thunder');
    // An unknown code is never guessed into a family.
    expect(weatherSymbolFamily(undefined)).toBe('unknown');
    expect(weatherSymbolFamily('')).toBe('unknown');
    expect(weatherSymbolFamily('meteor_shower')).toBe('unknown');
  });
});

describe('snap route labels', () => {
  it('prefers number and name, and skips the literal "Ukjent"', () => {
    expect(
      snapRouteLabel({ rutenavn: 'Memurubu–Glitterheim', rutenummer: 'jot21', lokalId: 'abc12345' })
        .label,
    ).toBe('jot21 · Memurubu–Glitterheim');
    expect(
      snapRouteLabel({ rutenavn: 'Ukjent', rutenummer: 'jot21', lokalId: 'abc12345' }).label,
    ).toBe('jot21');
    expect(
      snapRouteLabel({ rutenavn: 'Ukjent', rutenummer: '', lokalId: 'abcdef12345' }).label,
    ).toBe('abcdef12');
    expect(snapRouteLabel({ rutenavn: '', rutenummer: '', lokalId: '' }).label).toBe('—');
  });
});

function leg(id: string, count: number): Leg {
  return {
    id,
    name: id,
    points: Array.from({ length: count }, (_, index) => ({
      lon: 8 + index * 0.001,
      lat: 61,
      eleSource: 'none' as const,
    })),
    provenance: [{ kind: 'drawn' }],
    distanceM: 100,
    ascentM: null,
    descentM: null,
  };
}

function trip(): Trip {
  return {
    schemaVersion: 1,
    id: 't',
    name: 'T',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    legs: [leg('a', 3), leg('b', 2)],
    profile: {
      massKg: 70,
      heightCm: 175,
      ageYears: 40,
      sex: 'male',
      packBaseKg: 10,
      dailyKm: 15,
      dailyHours: 8,
      support: 'carry-all',
    },
  };
}

describe('flattenTrip', () => {
  it('concatenates legs and records inclusive global spans', () => {
    const flat = flattenTrip(trip());
    expect(flat.points).toHaveLength(5);
    expect(flat.spans).toEqual([
      { legId: 'a', name: 'a', startIndex: 0, endIndex: 2, pointCount: 3, distanceM: 100 },
      { legId: 'b', name: 'b', startIndex: 3, endIndex: 4, pointCount: 2, distanceM: 100 },
    ]);
    expect(flat.distanceM).toBeGreaterThan(0);
    expect(flat.distances).toHaveLength(5);
  });

  it('maps global indices back to leg-local ones and vice versa', () => {
    const flat = flattenTrip(trip());
    expect(localIndex(flat, 4)).toEqual({ legId: 'b', index: 1 });
    expect(localIndex(flat, 9)).toBeNull();
    expect(globalIndex(flat, 'b', 0)).toBe(3);
    expect(globalIndex(flat, 'b', 5)).toBeNull();
    expect(spanAt(flat, 0)?.legId).toBe('a');
    expect(spanAt(flat, 3)?.legId).toBe('b');
  });

  it('handles an empty trip without inventing geometry, and recognises the emptyLeg placeholder', () => {
    expect(flattenTrip(null)).toEqual({ points: [], distances: [], distanceM: 0, spans: [] });

    const placeholder: Leg = {
      ...leg('p', 2),
      points: [
        { lon: 0, lat: 0, eleSource: 'none' },
        { lon: 0, lat: 0, eleSource: 'none' },
      ],
    };
    expect(isPlaceholderLeg(placeholder)).toBe(true);
    expect(isPlaceholderLeg(leg('real', 2))).toBe(false);
    expect(isPlaceholderLeg(undefined)).toBe(true);
  });
});
