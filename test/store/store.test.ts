import { describe, expect, it } from 'vitest';

import { StoreError } from '../../src/contracts';
import type { Trip } from '../../src/contracts';
import {
  INDEX_KEY,
  MAX_TRIP_BYTES,
  byteSize,
  createTripStore,
  defaultProfile,
  emptyTrip,
  memoryStorage,
  tripKey,
} from '../../src/store';
import {
  FakeStorage,
  ThrowingStorage,
  otherTrip,
  quotaError,
  quotaErrorByCode,
  syntheticPoints,
  syntheticTrip,
} from './helpers';

const ID = 'trip-1';

function storeWith(storage: Storage) {
  return createTripStore(storage);
}

/** A `Storage` that passes everything through but fails the index write. */
function flakyIndex(storage: FakeStorage): Storage {
  return {
    get length() {
      return storage.length;
    },
    clear: () => storage.clear(),
    getItem: (key) => storage.getItem(key),
    key: (index) => storage.key(index),
    removeItem: (key) => storage.removeItem(key),
    setItem: (key, value) => {
      if (key === INDEX_KEY) throw quotaError();
      storage.setItem(key, value);
    },
  };
}

describe('the localStorage fallback store', () => {
  it('ships a documented default profile and an empty trip that is already storable', () => {
    expect(defaultProfile()).toEqual({
      massKg: 75,
      heightCm: 178,
      ageYears: 35,
      sex: 'male',
      packBaseKg: 12,
      dailyKm: 20,
      dailyHours: 8,
      support: 'carry-all',
    });
    // A fresh object every time: the caller may edit it without sharing state.
    expect(defaultProfile()).not.toBe(defaultProfile());

    const trip = emptyTrip('New trip', defaultProfile());
    expect(trip.schemaVersion).toBe(1);
    expect(trip.legs).toEqual([]);
    expect(trip.createdAt).toBe(trip.updatedAt);

    const store = storeWith(memoryStorage());
    store.save(trip);
    expect(store.load(trip.id)).toStrictEqual(trip);
  });

  it('round-trips a trip unchanged — unknown fields included — and lists summaries newest first', () => {
    const storage = new FakeStorage();
    const store = storeWith(storage);
    const trip = syntheticTrip();

    store.save(trip);
    expect(store.load(ID)).toStrictEqual(trip);

    store.save(otherTrip());
    expect(storage.keys().sort()).toEqual([INDEX_KEY, tripKey('trip-1'), tripKey('trip-2')].sort());

    const summaries = store.list();
    expect(summaries.map((summary) => summary.id)).toEqual(['trip-2', 'trip-1']);
    expect(summaries[1]).toMatchObject({
      id: 'trip-1',
      name: 'Besseggen over',
      updatedAt: '2024-06-01T09:30:00.000Z',
      legCount: 1,
    });
    expect(summaries[1]!.distanceM).toBeCloseTo(syntheticTrip().legs[0]!.distanceM!, 3);

    const renamed: Trip = { ...trip, name: 'Renamed', updatedAt: '2024-08-01T00:00:00.000Z' };
    store.save(renamed);
    expect(store.list().map((summary) => summary.id)).toEqual(['trip-1', 'trip-2']);
    expect(store.load(ID)!.name).toBe('Renamed');

    // A field this build does not know survives a read/write cycle.
    const body = {
      ...trip,
      futureField: { keep: true },
      legs: [{ ...trip.legs[0]!, futureLegField: 'yes' }],
    };
    storage.sabotage(tripKey(ID), JSON.stringify(body));
    const loaded = store.load(ID) as unknown as Record<string, unknown>;
    expect(loaded.futureField).toEqual({ keep: true });
    expect((loaded.legs as Record<string, unknown>[])[0]!.futureLegField).toBe('yes');
    store.save(loaded as unknown as Trip);
    expect((store.load(ID) as unknown as Record<string, unknown>).futureField).toEqual({ keep: true });
  });

  it('remove deletes the body and the index entry; unknown and already-gone ids are no-ops', () => {
    const storage = new FakeStorage();
    const store = storeWith(storage);
    store.save(syntheticTrip());
    store.save(otherTrip());

    store.remove(ID);
    expect(store.load(ID)).toBeNull();
    expect(store.list().map((summary) => summary.id)).toEqual(['trip-2']);
    expect(storage.getItem(tripKey(ID))).toBeNull();

    expect(() => store.remove('nope')).not.toThrow();
    expect(store.list()).toHaveLength(1);
    expect(storeWith(new FakeStorage()).load('missing')).toBeNull();
  });

  it('survives a corrupt index, a corrupt body and a future-version body', () => {
    const cases: ReadonlyArray<readonly [string, (storage: FakeStorage) => void, boolean]> = [
      ['an index that is not JSON', (s) => s.sabotage(INDEX_KEY, '{"not":"an array"'), false],
      ['an index that is not an array of strings', (s) => s.sabotage(INDEX_KEY, '[1, 2, 3]'), false],
      ['a dangling index id', (s) => s.sabotage(INDEX_KEY, JSON.stringify(['ghost'])), false],
      [
        'a body that is not JSON',
        (s) => {
          s.sabotage(INDEX_KEY, JSON.stringify([ID]));
          s.sabotage(tripKey(ID), 'surely not json');
        },
        false,
      ],
      [
        'a body that parses but is not a trip',
        (s) => {
          s.sabotage(INDEX_KEY, JSON.stringify([ID]));
          s.sabotage(tripKey(ID), JSON.stringify({ schemaVersion: 1, id: 'x' }));
        },
        false,
      ],
      [
        'a body from a newer build',
        (s) => {
          s.sabotage(INDEX_KEY, JSON.stringify([ID]));
          s.sabotage(tripKey(ID), JSON.stringify({ ...syntheticTrip(), schemaVersion: 99 }));
        },
        true,
      ],
    ];

    for (const [label, sabotage, futureVersion] of cases) {
      const storage = new FakeStorage();
      sabotage(storage);
      const store = storeWith(storage);

      expect(store.list(), label).toEqual([]);
      if (futureVersion) {
        // The UI must be able to explain why it will not open.
        expect(() => store.load(ID), label).toThrow(StoreError);
        // Not silently deleted: a newer app can still read it.
        expect(storage.getItem(tripKey(ID)), label).not.toBeNull();
      } else {
        expect(store.load(ID), label).toBeNull();
      }
    }

    // A corrupt index is repaired rather than left broken.
    const repaired = new FakeStorage();
    repaired.sabotage(INDEX_KEY, '{"not":"an array"');
    expect(storeWith(repaired).list()).toEqual([]);
    expect(repaired.getItem(INDEX_KEY)).toBe('[]');
  });

  it('maps every QuotaExceededError spelling to StoreError("quota-exceeded") and leaves no half-written trip', () => {
    const make = storeWith(new FakeStorage(500));
    let thrown: unknown;
    try {
      make.save(syntheticTrip());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StoreError);
    const error = thrown as StoreError;
    expect(error.code).toBe('quota-exceeded');
    expect(error.message).toMatch(/\d+ bytes/);
    expect(error.message).toMatch(/download/i);

    const variants: ReadonlyArray<readonly [string, () => unknown]> = [
      ['name only', () => quotaError()],
      ['name and code 22', () => quotaError(22)],
      ['code 22 only', () => quotaErrorByCode(22)],
      ['code 1014 only (Firefox)', () => quotaErrorByCode(1014)],
    ];
    for (const [label, factory] of variants) {
      const store = storeWith(new ThrowingStorage(factory));
      try {
        store.save(syntheticTrip());
        throw new Error(`${label}: expected a StoreError`);
      } catch (caught) {
        expect(caught, label).toBeInstanceOf(StoreError);
        expect((caught as StoreError).code, label).toBe('quota-exceeded');
      }
    }

    // A failing index write leaves nothing behind, and never destroys the
    // version a re-save was replacing.
    const storage = new FakeStorage();
    expect(() => storeWith(flakyIndex(storage)).save(syntheticTrip())).toThrow(StoreError);
    expect(storage.getItem(tripKey(ID))).toBeNull();

    storeWith(storage).save(syntheticTrip());
    const before = storage.getItem(tripKey(ID));
    expect(() =>
      storeWith(flakyIndex(storage)).save({ ...syntheticTrip(), name: 'Second attempt' }),
    ).toThrow(StoreError);
    expect(storage.getItem(tripKey(ID))).toBe(before);
    expect(storeWith(storage).load(ID)!.name).toBe('Besseggen over');
  });

  it('refuses a trip that does not validate and one over the 1.5 MB localStorage ceiling, and says the size', () => {
    const validating = storeWith(new FakeStorage());
    const valid = syntheticTrip();
    for (const bad of [
      { ...valid, id: '' } as Trip,
      {
        ...valid,
        legs: [{ ...valid.legs[0]!, points: [{ lon: 8, lat: 200, eleSource: 'none' }] }],
      } as unknown as Trip,
    ]) {
      try {
        validating.save(bad);
        throw new Error('expected a StoreError');
      } catch (error) {
        expect(error).toBeInstanceOf(StoreError);
        expect((error as StoreError).code).toBe('corrupt');
      }
    }

    const storage = new FakeStorage();
    const store = storeWith(storage);
    const huge = syntheticTrip(syntheticPoints(24_000));
    const expected = byteSize(JSON.stringify(huge));
    expect(expected).toBeGreaterThan(MAX_TRIP_BYTES);

    const error = (() => {
      try {
        store.save(huge);
      } catch (caught) {
        return caught as StoreError;
      }
      throw new Error('expected a StoreError');
    })();
    expect(error.code).toBe('quota-exceeded');
    expect(error.message).toContain(String(expected));
    expect(error.message).toContain(String(MAX_TRIP_BYTES));
    expect(error.message).toMatch(/download/i);
    // Nothing written: no body, no index entry.
    expect(storage.keys()).toEqual([]);

    const trip = syntheticTrip(syntheticPoints(5_000));
    expect(byteSize(JSON.stringify(trip))).toBeLessThan(MAX_TRIP_BYTES);
    store.save(trip);
    expect(store.list()).toHaveLength(1);
  });

  it('falls back to an in-memory Storage when nothing is injected', () => {
    const memory = memoryStorage();
    const store = storeWith(memory);
    store.save(syntheticTrip());
    expect(store.list()).toHaveLength(1);

    const fallback = createTripStore();
    const trip = emptyTrip('No storage injected', defaultProfile());
    fallback.save(trip);
    expect(fallback.load(trip.id)).toStrictEqual(trip);
    fallback.remove(trip.id);
    expect(fallback.load(trip.id)).toBeNull();
  });
});
