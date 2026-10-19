import { describe, expect, it } from 'vitest';

import type {
  EditCommand,
  Leg,
  RouteEditor,
  Trip,
  TripStore,
  TripSummary,
  UserProfile,
} from '../src/contracts';
import { StoreError } from '../src/contracts';
import type { EngineSurface } from '../src/app/engine-types';
import { AUTOSAVE_DELAY_MS, TripSession } from '../src/app/trip-session';

const PROFILE: UserProfile = {
  massKg: 75,
  heightCm: 178,
  ageYears: 35,
  sex: 'male',
  packBaseKg: 12,
  dailyKm: 20,
  dailyHours: 8,
  startDate: '2026-07-01',
  support: 'carry-all',
};

function leg(id: string, offset = 0): Leg {
  return {
    id,
    points: [
      { lon: 8 + offset, lat: 61, eleSource: 'none' },
      { lon: 8.01 + offset, lat: 61.01, eleSource: 'none' },
    ],
    provenance: [{ kind: 'drawn' }],
    distanceM: 1000,
    ascentM: null,
    descentM: null,
  };
}

function trip(id = 'trip-1', name = 'Test'): Trip {
  return {
    schemaVersion: 1,
    id,
    name,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    legs: [leg('leg-1')],
    profile: PROFILE,
  };
}

/** Minimal editor: every command returns a new trip object, undo/redo work. */
function createFakeEditor(start: Trip): RouteEditor {
  let current = start;
  const past: Trip[] = [];
  const future: Trip[] = [];
  return {
    get trip() {
      return current;
    },
    get canUndo() {
      return past.length > 0;
    },
    get canRedo() {
      return future.length > 0;
    },
    apply(command: EditCommand) {
      past.push(current);
      future.length = 0;
      // Mutate nothing: a new object with a counter in the name stands in for
      // real geometry editing.
      current = { ...current, name: `${current.name}${command.type === 'reverse-leg' ? '↔' : '•'}` };
      return current;
    },
    undo() {
      const previous = past.pop();
      if (!previous) return current;
      future.push(current);
      current = previous;
      return current;
    },
    redo() {
      const next = future.pop();
      if (!next) return current;
      past.push(current);
      current = next;
      return current;
    },
    reset(next: Trip) {
      current = next;
      past.length = 0;
      future.length = 0;
    },
  };
}

class FakeStore implements TripStore {
  readonly trips = new Map<string, Trip>();
  failSave: Error | null = null;
  failList: Error | null = null;

  list(): TripSummary[] {
    if (this.failList) throw this.failList;
    return [...this.trips.values()].map((entry) => ({
      id: entry.id,
      name: entry.name,
      updatedAt: entry.updatedAt,
      legCount: entry.legs.length,
      distanceM: 1000,
    }));
  }

  load(id: string): Trip | null {
    return this.trips.get(id) ?? null;
  }

  save(trip: Trip): void {
    if (this.failSave) throw this.failSave;
    this.trips.set(trip.id, trip);
  }

  remove(id: string): void {
    this.trips.delete(id);
  }

  toGpx(trip: Trip): string {
    return `<gpx>${trip.name}</gpx>`;
  }

  toGeoJson(trip: Trip): string {
    return JSON.stringify({ type: 'FeatureCollection', name: trip.name });
  }

  fromFile(text: string): Trip {
    if (text === 'bad') throw new StoreError('corrupt', 'not a trip');
    return { ...trip('imported', text), name: text };
  }
}

function enginesWith(): EngineSurface {
  return {
    planTripWeather: async () => {
      throw new Error('not used');
    },
    forecastHorizonDays: () => 9,
    createEditor: createFakeEditor,
    emptyLeg: () => leg('empty'),
    tripFromPoints: (_points, name) => ({ ...trip('built', name), legs: [leg('leg-built')] }),
    rerouteSpan: (input) => input,
    createTripStore: () => new FakeStore(),
    emptyTrip: (name) => trip('empty', name),
    defaultProfile: () => PROFILE,
  };
}

interface Harness {
  session: TripSession;
  store: FakeStore;
  runAutosave: () => void;
  scheduled: () => number;
}

function harness(options: { failSave?: Error } = {}): Harness {
  const store = new FakeStore();
  if (options.failSave) store.failSave = options.failSave;
  let pending: (() => void) | null = null;
  let delay = 0;
  const now = () => new Date('2026-07-01T14:32:00.000Z');
  const session = new TripSession({
    engines: enginesWith(),
    store,
    now,
    schedule: (callback, ms) => {
      pending = callback;
      delay = ms;
      return () => {
        pending = null;
      };
    },
  });
  return {
    session,
    store,
    runAutosave: () => {
      const callback = pending;
      pending = null;
      callback?.();
    },
    scheduled: () => delay,
  };
}

describe('TripSession — autosave', () => {
  it('marks a newly adopted trip dirty and saves it after the debounce', () => {
    const { session, store, runAutosave, scheduled } = harness();
    session.adopt(trip());

    expect(session.saveStatus.kind).toBe('dirty');
    expect(scheduled()).toBe(AUTOSAVE_DELAY_MS);
    expect(store.trips.size).toBe(0);

    runAutosave();

    expect(store.trips.get('trip-1')?.name).toBe('Test');
    expect(session.saveStatus.kind).toBe('saved');
    expect(session.saveStatus.at).toBe(Date.parse('2026-07-01T14:32:00.000Z'));
  });

  it('saves immediately when asked (imports)', () => {
    const { session, store } = harness();
    session.adopt(trip(), { save: 'now' });
    expect(store.trips.has('trip-1')).toBe(true);
    expect(session.saveStatus.kind).toBe('saved');
  });

  it('stamps updatedAt on every edit and keeps the editor in sync', () => {
    const { session } = harness();
    session.adopt(trip());
    const next = session.apply({ type: 'reverse-leg', legId: 'leg-1' });
    expect(next?.updatedAt).toBe('2026-07-01T14:32:00.000Z');
    expect(session.trip?.name).toBe('Test↔');
    expect(session.canUndo).toBe(true);
    expect(session.saveStatus.kind).toBe('dirty');
  });

  it('undo and redo return trips and schedule a save; no-ops return null', () => {
    const { session, store, runAutosave } = harness();
    session.adopt(trip(), { save: 'now' });
    expect(session.undo()).toBeNull();
    expect(session.redo()).toBeNull();

    session.apply({ type: 'reverse-leg', legId: 'leg-1' });
    const undone = session.undo();
    expect(undone?.name).toBe('Test');
    expect(session.canRedo).toBe(true);
    const redone = session.redo();
    expect(redone?.name).toBe('Test↔');

    runAutosave();
    expect(store.trips.get('trip-1')?.name).toBe('Test↔');
  });

  it('surfaces a quota error as a StoreError code, not a silent failure', () => {
    const { session, store, runAutosave } = harness({
      failSave: new StoreError('quota-exceeded', 'QuotaExceededError'),
    });
    session.adopt(trip());
    runAutosave();

    expect(session.saveStatus.kind).toBe('error');
    expect(session.saveStatus.code).toBe('quota-exceeded');
    expect(session.saveStatus.message).toContain('Quota');
    expect(store.trips.size).toBe(0);
  });

  it('reports an unavailable store instead of pretending to save', () => {
    const session = new TripSession({ engines: enginesWith(), store: null });
    expect(session.persistent).toBe(false);
    session.adopt(trip());
    const status = session.saveNow();
    expect(status.kind).toBe('unavailable');
  });
});

describe('TripSession — library', () => {
  it('sorts summaries by updatedAt descending and survives a broken index', () => {
    const { session, store } = harness();
    store.trips.set('a', { ...trip('a'), updatedAt: '2026-01-01T00:00:00.000Z' });
    store.trips.set('b', { ...trip('b'), updatedAt: '2026-03-01T00:00:00.000Z' });
    expect(session.list().map((entry) => entry.id)).toEqual(['b', 'a']);

    store.failList = new StoreError('corrupt', 'index unreadable');
    expect(session.list()).toEqual([]);
    expect(session.listProblem?.code).toBe('corrupt');
  });

  it('renames the open trip through the editor and saves it', () => {
    const { session, store } = harness();
    session.adopt(trip(), { save: 'now' });
    expect(session.renameSaved('trip-1', 'Ny tur')).toBe(true);
    expect(session.trip?.name).toBe('Ny tur');
    expect(store.trips.get('trip-1')?.name).toBe('Ny tur');
  });

  it('renames a stored trip that is not open without adopting it', () => {
    const { session, store } = harness();
    store.trips.set('other', trip('other', 'Annen'));
    expect(session.renameSaved('other', 'Omdøpt')).toBe(true);
    expect(session.trip).toBeNull();
    expect(store.trips.get('other')?.name).toBe('Omdøpt');
  });

  it('duplicates under a new id and name suffix without touching the open trip', () => {
    const { session, store } = harness();
    store.trips.set('trip-1', trip());
    session.open('trip-1');
    const newId = session.duplicate('trip-1', '(kopi)');
    expect(newId).not.toBeNull();
    expect(newId).not.toBe('trip-1');
    expect(store.trips.get(newId!)?.name).toBe('Test (kopi)');
    expect(session.trip?.name).toBe('Test');
  });

  it('removes a trip and closes it when it was open', () => {
    const { session, store } = harness();
    store.trips.set('trip-1', trip());
    session.open('trip-1');
    expect(session.remove('trip-1')).toBe(true);
    expect(store.trips.has('trip-1')).toBe(false);
    expect(session.trip).toBeNull();
  });

  it('imports a file, adopts and persists it immediately; malformed input throws', () => {
    const { session, store } = harness();
    const imported = session.importFile('Importert', 'tur.gpx');
    expect(imported.name).toBe('Importert');
    expect(session.trip?.name).toBe('Importert');
    expect(store.trips.has(imported.id)).toBe(true);

    expect(() => session.importFile('bad', 'bad.gpx')).toThrow(StoreError);
  });

  it('exports the open trip and any stored trip without adopting it', () => {
    const { session, store } = harness();
    store.trips.set('other', trip('other', 'Andre'));
    session.adopt(trip(), { save: 'now' });
    expect(session.exportGpxFor('trip-1')).toContain('Test');
    expect(session.exportGpxFor('other')).toContain('Andre');
    expect(session.exportGeoJsonFor('other')).toContain('Andre');
    expect(session.trip?.id).toBe('trip-1');
    expect(session.exportGpxFor('missing')).toBeNull();
  });
});
