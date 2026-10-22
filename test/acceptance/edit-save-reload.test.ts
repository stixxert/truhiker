/**
 * Acceptance: load → edit → save → reload, through the real session, store and
 * editor over one shared backend.
 *
 * Each piece was previously tested against a fake of the next: the session with
 * a fake store, the store with synthetic trips that were never edited. This is
 * the journey a user actually performs, and it also pins that undo history does
 * not leak into storage.
 *
 * The backend is the real async store over injected storage: in Node there is no
 * `indexedDB`, so `createTripStorage` exercises its localStorage fallback path —
 * and the reload proves that the fallback is the same behaviour the IndexedDB
 * store provides (`test/store/indexeddb.test.ts` covers that side).
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { engines } from '../../src/app/engines';
import { TripSession } from '../../src/app/trip-session';
import { memoryStorage } from '../../src/store';

const DEMO = new URL('../fixtures/gjendesheim-besseggen.gpx', import.meta.url);

function newSession(storage: Storage): TripSession {
  return new TripSession({
    engines,
    storage,
    now: () => new Date('2026-10-19T10:00:00Z'),
    // Never schedule autosave: the test saves explicitly.
    schedule: () => () => {},
  });
}

describe('acceptance: edit, save, reload', () => {
  it('restores an edited trip exactly, and does not restore undo history', async () => {
    const storage = memoryStorage();

    const first = newSession(storage);
    await first.whenReady();
    const { trip: imported } = await first.importFile(readFileSync(DEMO, 'utf8'), 'gjendesheim-besseggen.gpx');
    const legId = imported.legs[0]!.id;

    // A scripted edit sequence covering geometry, splitting and naming.
    first.apply({ type: 'insert', legId, index: 1, point: { lon: 8.36, lat: 61.5, ele: 1200, eleSource: 'dem' } });
    first.apply({ type: 'reverse-leg', legId });
    first.apply({ type: 'split-leg', legId, index: 2 });
    const secondLegId = first.trip!.legs[1]!.id;
    first.apply({ type: 'merge-legs', legId, withLegId: secondLegId });
    first.apply({ type: 'rename-leg', legId, name: 'Dag 1' });

    expect(first.canUndo).toBe(true);
    const edited = first.trip!;
    const status = await first.saveNow();
    expect(status.kind).toBe('saved');

    // --- reload through a *new* session over the same storage ---------------
    const second = newSession(storage);
    const listed = await second.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.name).toBe(edited.name);

    const reloaded = await second.open(edited.id);
    expect(reloaded).not.toBeNull();

    // Geometry, elevation provenance and the derived numbers survive.
    expect(reloaded!.legs).toHaveLength(1);
    expect(reloaded!.legs[0]!.points).toEqual(edited.legs[0]!.points);
    expect(reloaded!.legs[0]!.points.some((point) => point.eleSource === 'dem')).toBe(true);
    expect(reloaded!.legs[0]!.provenance.some((entry) => entry.kind === 'edited')).toBe(true);
    expect(reloaded!.legs[0]!.name).toBe('Dag 1');
    expect(reloaded!.updatedAt).toBe(edited.updatedAt);

    // History must not persist into storage: a fresh editor starts clean.
    expect(second.canUndo).toBe(false);
    expect(second.canRedo).toBe(false);

    // And the export/import path agrees with what is stored.
    const gpx = second.exportGpx();
    expect(gpx).toBeTruthy();
    const third = newSession(memoryStorage());
    const { trip: reimported } = await third.importFile(gpx!, 'reload.gpx');
    expect(reimported.legs[0]!.points).toHaveLength(edited.legs[0]!.points.length);
  });
});
