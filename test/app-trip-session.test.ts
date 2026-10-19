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
import type { StorageUsage, TripStoreLike } from '../src/store/types';

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

/**
 * A store that can be synchronous (like localStorage) or held open (like a slow
 * IndexedDB write), so the `'saving'` state and a rejected write are observable.
 */
class FakeStore implements TripStoreLike {
  readonly trips = new Map<string, Trip>();
  failSave: Error | null = null;
  failList: Error | null = null;
  /** When set, saves wait for this promise — the write is "in flight". */
  gate: Promise<void> | null = null;
  saves = 0;

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

  async save(trip: Trip): Promise<void> {
    this.saves += 1;
    if (this.gate) await this.gate;
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
    createTripStore: (): TripStore => new FakeStore(),
    emptyTrip: (name) => trip('empty', name),
    defaultProfile: () => PROFILE,
  };
}

interface Harness {
  session: TripSession;
  store: FakeStore;
  /** Run the scheduled autosave and wait for the write it started. */
  runAutosave: () => Promise<void>;
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
    runAutosave: async () => {
      const callback = pending;
      pending = null;
      callback?.();
      // Let the queued write settle.
      await session.flush();
    },
    scheduled: () => delay,
  };
}

/** A deferred promise, so a test can hold a write open. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('TripSession — autosave', () => {
  it('marks an adopted trip dirty, saves it after the debounce and stamps updatedAt on each edit', async () => {
    const { session, store, runAutosave, scheduled } = harness();
    session.adopt(trip());

    expect(session.saveStatus.kind).toBe('dirty');
    expect(scheduled()).toBe(AUTOSAVE_DELAY_MS);
    expect(store.trips.size).toBe(0);

    await runAutosave();

    expect(store.trips.get('trip-1')?.name).toBe('Test');
    expect(session.saveStatus.kind).toBe('saved');
    expect(session.saveStatus.at).toBe(Date.parse('2026-07-01T14:32:00.000Z'));

    const next = session.apply({ type: 'reverse-leg', legId: 'leg-1' });
    expect(next?.updatedAt).toBe('2026-07-01T14:32:00.000Z');
    expect(session.trip?.name).toBe('Test↔');
    expect(session.canUndo).toBe(true);
    expect(session.saveStatus.kind).toBe('dirty');
  });

  it('undo and redo return trips and schedule a save; no-ops return null', async () => {
    const { session, store, runAutosave } = harness();
    session.adopt(trip(), { save: 'now' });
    await session.flush();
    expect(session.undo()).toBeNull();
    expect(session.redo()).toBeNull();

    session.apply({ type: 'reverse-leg', legId: 'leg-1' });
    const undone = session.undo();
    expect(undone?.name).toBe('Test');
    expect(session.canRedo).toBe(true);
    const redone = session.redo();
    expect(redone?.name).toBe('Test↔');

    await runAutosave();
    expect(store.trips.get('trip-1')?.name).toBe('Test↔');
  });

  it('shows "saving" for a write that has not committed, and never "saved" before it lands', async () => {
    const { session, store } = harness();
    session.adopt(trip());
    const gate = deferred();
    store.gate = gate.promise;

    const first = session.saveNow();
    expect(session.saveStatus.kind).toBe('saving');
    gate.resolve();
    expect((await first).kind).toBe('saved');

    // A slow write for an *older* trip must not mark a newer edit as saved.
    const slow = deferred();
    store.gate = slow.promise;
    const inFlight = session.saveNow();
    expect(session.saveStatus.kind).toBe('saving');
    session.apply({ type: 'reverse-leg', legId: 'leg-1' });
    expect(session.saveStatus.kind).toBe('dirty');
    slow.resolve();
    await inFlight;
    expect(session.saveStatus.kind).toBe('dirty');
    store.gate = null;
    expect((await session.saveNow()).kind).toBe('saved');
  });

  it('surfaces a rejected write as an error status, and an unavailable store as unavailable', async () => {
    const { session, store } = harness({
      failSave: new StoreError('quota-exceeded', 'QuotaExceededError: 8 000 000 bytes'),
    });
    session.adopt(trip());
    const status = await session.saveNow();

    expect(status.kind).toBe('error');
    expect(status.code).toBe('quota-exceeded');
    expect(status.message).toContain('Quota');
    expect(store.trips.size).toBe(0);

    // A plain (non-StoreError) rejection is still visible.
    store.failSave = new Error('IndexedDB transaction aborted');
    const aborted = await session.saveNow();
    expect(aborted.kind).toBe('error');
    expect(aborted.message).toContain('aborted');

    const blocked = new TripSession({ engines: enginesWith(), store: null });
    expect(blocked.persistent).toBe(false);
    blocked.adopt(trip());
    expect((await blocked.saveNow()).kind).toBe('unavailable');
  });

  it('flushes a pending autosave when the page is hidden', async () => {
    const { session, store } = harness();
    session.adopt(trip());
    expect(store.trips.size).toBe(0);

    // `flush` is what the pagehide listener calls: it must write and wait.
    await session.flush();
    expect(store.trips.get('trip-1')?.name).toBe('Test');
    expect(session.saveStatus.kind).toBe('saved');

    // Nothing pending: flush is a no-op, not a second write.
    const before = store.saves;
    await session.flush();
    expect(store.saves).toBe(before);
  });
});

describe('TripSession — library', () => {
  it('sorts summaries by updatedAt descending and survives a broken index', async () => {
    const { session, store } = harness();
    store.trips.set('a', { ...trip('a'), updatedAt: '2026-01-01T00:00:00.000Z' });
    store.trips.set('b', { ...trip('b'), updatedAt: '2026-03-01T00:00:00.000Z' });
    expect((await session.list()).map((entry) => entry.id)).toEqual(['b', 'a']);

    store.failList = new StoreError('corrupt', 'index unreadable');
    expect(await session.list()).toEqual([]);
    expect(session.listProblem?.code).toBe('corrupt');
  });

  it('renames, duplicates and removes through the store, without adopting what it touches', async () => {
    const { session, store } = harness();
    session.adopt(trip(), { save: 'now' });
    await session.flush();
    store.trips.set('other', trip('other', 'Annen'));

    // Rename the open trip: editor and store both follow.
    expect(await session.renameSaved('trip-1', 'Ny tur')).toBe(true);
    expect(session.trip?.name).toBe('Ny tur');
    expect(store.trips.get('trip-1')?.name).toBe('Ny tur');
    // Rename a trip that is not open: it is not adopted.
    expect(await session.renameSaved('other', 'Omdøpt')).toBe(true);
    expect(session.trip?.id).toBe('trip-1');
    expect(store.trips.get('other')?.name).toBe('Omdøpt');
    expect(await session.renameSaved('other', '   ')).toBe(false);

    // Duplicate under a new id and name suffix; the open trip is untouched.
    const newId = await session.duplicate('trip-1', '(kopi)');
    expect(newId).not.toBe('trip-1');
    expect(store.trips.get(newId!)?.name).toBe('Ny tur (kopi)');
    expect(session.trip?.name).toBe('Ny tur');

    // Remove closes the trip it deleted, and reports a failure rather than lying.
    expect(await session.remove('trip-1')).toBe(true);
    expect(store.trips.has('trip-1')).toBe(false);
    expect(session.trip).toBeNull();

    store.failSave = new StoreError('quota-exceeded', 'full');
    expect(await session.renameSaved('other', 'Ny')).toBe(false);
  });

  it('imports a file, adopts and persists it before resolving, and exports without adopting', async () => {
    const { session, store } = harness();
    const imported = await session.importFile('Importert', 'tur.gpx');
    expect(imported.name).toBe('Importert');
    expect(session.trip?.name).toBe('Importert');
    expect(store.trips.has(imported.id)).toBe(true);

    await expect(session.importFile('bad', 'bad.gpx')).rejects.toBeInstanceOf(StoreError);

    // Exporting never adopts: the open trip stays the open trip.
    store.trips.set('other', trip('other', 'Andre'));
    expect(await session.exportGpxFor(imported.id)).toContain('Importert');
    expect(await session.exportGpxFor('other')).toContain('Andre');
    expect(await session.exportGeoJsonFor('other')).toContain('Andre');
    expect(session.trip?.id).toBe(imported.id);
    expect(await session.exportGpxFor('missing')).toBeNull();
  });
});

describe('TripSession — storage reporting', () => {
  it('reports the backend, persistence and usage the UI needs, and nothing it cannot know', async () => {
    const usage: StorageUsage = { usedBytes: 8_000_000, quotaBytes: 8_000_000_000, source: 'indexeddb' };
    const asyncStore: TripStoreLike = Object.assign(new FakeStore(), {
      backend: 'indexeddb' as const,
      persistent: true,
      problem: null,
      migration: null,
      usage: async () => usage,
    });
    const session = new TripSession({ engines: enginesWith(), store: asyncStore });
    expect(session.backend).toBe('indexeddb');
    expect(session.storageInfo).toEqual({ backend: 'indexeddb', persistent: true, problem: null });
    expect(await session.usage()).toEqual(usage);

    // A plain sync store knows nothing about the backend: say so, do not guess.
    const plain = harness().session;
    expect(plain.backend).toBeNull();
    expect(plain.storageInfo).toBeNull();
    expect(await plain.usage()).toBeNull();
  });
});
