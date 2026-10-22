/**
 * The last-chance journal (D6).
 *
 * Autosave is debounced by a second and the store write is asynchronous; the browser
 * does not wait for IndexedDB when a tab closes, so an edit made in the final moment
 * was lost silently. `pagehide` is the last point where a *synchronous* write can
 * still land, and `localStorage` is the only synchronous storage — so the trip goes
 * there on the way out and is folded back in at the next boot when it is newer.
 */
import { describe, expect, it } from 'vitest';

import type { Trip } from '../src/contracts';
import type { EngineSurface } from '../src/app/engine-types';
import { TripSession } from '../src/app/trip-session';
import type { TripStoreLike } from '../src/store/types';
import { createEditor } from '../src/route';

function trip(id: string, name: string, updatedAt: string): Trip {
  return {
    schemaVersion: 1,
    id,
    name,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt,
    legs: [
      {
        id: 'leg-1',
        points: [
          { lon: 8, lat: 61 },
          { lon: 8.01, lat: 61.01 },
        ],
        provenance: [{ kind: 'drawn' }],
        distanceM: 1000,
        ascentM: null,
        descentM: null,
      },
    ],
    profile: {
      massKg: 75,
      heightCm: 178,
      ageYears: 35,
      sex: 'male',
      packBaseKg: 12,
      dailyKm: 20,
      dailyHours: 8,
      startDate: '2026-07-01',
      support: 'carry-all',
    },
  };
}

class MapStore implements TripStoreLike {
  readonly trips = new Map<string, Trip>();
  saves = 0;
  list() {
    return [...this.trips.values()].map((entry) => ({
      id: entry.id,
      name: entry.name,
      updatedAt: entry.updatedAt,
      legCount: entry.legs.length,
      distanceM: entry.legs[0]?.distanceM ?? null,
    }));
  }
  async save(value: Trip) {
    this.saves += 1;
    this.trips.set(value.id, value);
  }
  remove(id: string) {
    this.trips.delete(id);
  }
  load(id: string) {
    return this.trips.get(id) ?? null;
  }
  toGpx(value: Trip) {
    return `<gpx>${value.name}</gpx>`;
  }
  toGeoJson() {
    return '{}';
  }
  fromFile(text: string): Trip {
    return trip('from-file', text, '2026-07-01T00:00:00.000Z');
  }
  fromGeoJson(): Trip {
    return trip('from-geo', 'geo', '2026-07-01T00:00:00.000Z');
  }
}

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
}

function engines(): EngineSurface {
  return { createEditor: ((value: Trip) => createEditor(value)) as EngineSurface['createEditor'] } as EngineSurface;
}

function session(store: MapStore, journal: Storage): TripSession {
  return new TripSession({ engines: engines(), store, journal, now: () => new Date('2026-07-02T00:00:00.000Z') });
}

describe('TripSession — last-chance journal', () => {
  it('keeps an edit made after the last autosave, and recovers it on the next boot', async () => {
    const store = new MapStore();
    const journal = new MemoryStorage();
    const first = session(store, journal);
    await first.whenReady();
    await first.adopt(trip('t1', 'Lagret', '2026-07-01T00:00:00.000Z'), { save: 'manual' });
    await first.saveNow(); // deterministic: the journal test must not race the debounce

    // An edit that the debounce has not written yet... then the tab closes.
    const edited: Trip = { ...trip('t1', 'Endret', '2026-07-02T00:00:00.000Z') };
    first.rewrite(edited);
    first.writeJournalNow();
    expect(journal.getItem('truhiker:journal:t1')).toContain('Endret');
    // The store still has the old version — that is the loss this guards against.
    expect(store.trips.get('t1')?.name).toBe('Lagret');

    // Next boot folds the journal back in, because it is newer.
    const second = session(store, journal);
    await second.whenReady();
    expect(store.trips.get('t1')?.name).toBe('Endret');
    expect(journal.getItem('truhiker:journal:t1')).toBeNull();
  });

  it('ignores a journal entry that is not newer than the stored trip', async () => {
    const store = new MapStore();
    const journal = new MemoryStorage();
    store.trips.set('t1', trip('t1', 'Lagret', '2026-07-03T00:00:00.000Z'));
    journal.setItem('truhiker:journal:t1', JSON.stringify(trip('t1', 'Gammel', '2026-07-01T00:00:00.000Z')));

    const boot = session(store, journal);
    await boot.whenReady();

    expect(store.trips.get('t1')?.name).toBe('Lagret');
    expect(store.saves).toBe(0);
    expect(journal.getItem('truhiker:journal:t1')).toBeNull();
  });

  it('writes back a trip the store never received', async () => {
    const store = new MapStore();
    const journal = new MemoryStorage();
    journal.setItem('truhiker:journal:t9', JSON.stringify(trip('t9', 'Ulagerbar', '2026-07-02T00:00:00.000Z')));

    const boot = session(store, journal);
    await boot.whenReady();

    expect(store.trips.get('t9')?.name).toBe('Ulagerbar');
    expect(journal.length).toBe(0);
  });
});

/**
 * The recovery has to happen before the app decides what to open. `open()` waits for
 * the store, not for the journal, so reading a trip first and recovering afterwards
 * leaves the recovered edit in the store and off the screen until the next reload.
 * That ordering is the contract the boot path relies on by awaiting `whenReady()`.
 */
describe('TripSession — the journal is recovered before a trip is read', () => {
  it('shows the stored version until whenReady(), then the recovered one', async () => {
    const store = new MapStore();
    const journal = new MemoryStorage();
    store.trips.set('t1', trip('t1', 'Lagret', '2026-07-01T00:00:00.000Z'));
    journal.setItem('truhiker:journal:t1', JSON.stringify(trip('t1', 'Endret', '2026-07-02T00:00:00.000Z')));

    const boot = session(store, journal);
    // Before the recovery point: the journal has not been folded in yet.
    expect((await boot.open('t1'))?.name).toBe('Lagret');
    // After it: the recovered edit is what the app will see, and the journal is gone.
    await boot.whenReady();
    expect((await boot.open('t1'))?.name).toBe('Endret');
    expect(journal.getItem('truhiker:journal:t1')).toBeNull();
  });
});
