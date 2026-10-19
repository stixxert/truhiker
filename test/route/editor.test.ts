import { describe, expect, it } from 'vitest';

import type { Trip } from '../../src/contracts';
import { RouteEditError, createEditor, tripDistanceM } from '../../src/route';
import type { RouteCommand } from '../../src/route';
import { fixedClock, makeTrip, straightPoints } from './helpers';

const ELEVATED = (index: number): number => 1000 + index * 20;

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(RouteEditError);
    expect((error as RouteEditError).code).toBe(code);
    return;
  }
  throw new Error(`expected a RouteEditError('${code}')`);
}

describe('immutability', () => {
  it('apply returns a new trip and never mutates the input', () => {
    const trip = makeTrip(straightPoints(8.3, 8.34, 61.5, 5, ELEVATED));
    const frozenCopy = structuredClone(trip);
    const editor = createEditor(trip, { now: fixedClock() });

    const next = editor.apply({
      type: 'insert',
      legId: 'leg-1',
      index: 2,
      point: { lon: 8.32, lat: 61.5001 },
    });

    expect(next).not.toBe(trip);
    expect(editor.trip).toBe(next);
    expect(trip.legs[0].points).toHaveLength(5);
    expect(next.legs[0].points).toHaveLength(6);
    expect(next.legs[0].points).not.toBe(trip.legs[0].points);
    expect(structuredClone(trip)).toEqual(frozenCopy);
  });
});

describe('undo/redo', () => {
  it('round-trips every command type back to a deep-equal trip', () => {
    const start = makeTrip(straightPoints(8.3, 8.4, 61.5, 6, ELEVATED), {
      provenance: [{ kind: 'gpx-upload', label: 'original', modified: false }],
    });
    const editor = createEditor(start, { now: fixedClock() });

    const snapshots: Trip[] = [editor.trip];
    const run = (command: RouteCommand): void => {
      editor.apply(command);
      snapshots.push(editor.trip);
    };

    run({ type: 'insert', legId: 'leg-1', index: 2, point: { lon: 8.33, lat: 61.5001 } });
    run({ type: 'move', legId: 'leg-1', index: 3, point: { lon: 8.345, lat: 61.5002 } });
    run({ type: 'delete-vertex', legId: 'leg-1', index: 1 });
    run({
      type: 'replace-span',
      legId: 'leg-1',
      from: 1,
      to: 2,
      points: [
        { lon: 8.335, lat: 61.5 },
        { lon: 8.34, lat: 61.5 },
      ],
      snapped: true,
    });
    run({ type: 'trim-leg', legId: 'leg-1', from: 0, to: 3 });
    run({ type: 'reverse-leg', legId: 'leg-1' });
    run({ type: 'rename-leg', legId: 'leg-1', name: '  Besseggen  ' });
    run({ type: 'split-leg', legId: 'leg-1', index: 1 });
    run({ type: 'merge-legs', legId: 'leg-1', withLegId: editor.trip.legs[1].id });
    run({ type: 'split-leg', legId: 'leg-1', index: 1 });
    run({ type: 'delete-leg', legId: editor.trip.legs[1].id });

    expect(snapshots).toHaveLength(12);

    // updatedAt moves forward on every command.
    for (let i = 1; i < snapshots.length; i++) {
      expect(Date.parse(snapshots[i].updatedAt)).toBeGreaterThan(
        Date.parse(snapshots[i - 1].updatedAt),
      );
    }

    for (let i = snapshots.length - 1; i > 0; i--) {
      const undone = editor.undo();
      expect(undone).toBe(editor.trip);
      expect(editor.trip).toEqual(snapshots[i - 1]);
    }
    expect(editor.canUndo).toBe(false);
    expect(editor.trip).toEqual(start);

    for (let i = 1; i < snapshots.length; i++) {
      editor.redo();
      expect(editor.trip).toEqual(snapshots[i]);
    }
    expect(editor.canRedo).toBe(false);
    expect(editor.trip).toEqual(snapshots[snapshots.length - 1]);
  });

  it('is a no-op at the ends of the stacks, clears redo on a new command, and reset clears both', () => {
    const trip = makeTrip(straightPoints(8.3, 8.4, 61.5, 5, ELEVATED));
    const editor = createEditor(trip, { now: fixedClock() });
    expect(editor.canUndo).toBe(false);
    expect(editor.canRedo).toBe(false);
    expect(editor.undo()).toBe(trip);
    expect(editor.redo()).toBe(trip);

    editor.apply({ type: 'reverse-leg', legId: 'leg-1' });
    editor.undo();
    expect(editor.redo()).toBe(editor.trip);
    expect(editor.canRedo).toBe(false);

    // A new command after an undo discards the redo branch.
    editor.apply({ type: 'reverse-leg', legId: 'leg-1' });
    editor.undo();
    expect(editor.canRedo).toBe(true);
    editor.apply({ type: 'rename-leg', legId: 'leg-1', name: 'Ny' });
    expect(editor.canRedo).toBe(false);

    const second = makeTrip(straightPoints(9.0, 9.1, 62.0, 3, ELEVATED), { tripId: 'trip-2' });
    editor.apply({ type: 'reverse-leg', legId: 'leg-1' });
    editor.undo();
    expect(editor.canRedo).toBe(true);
    editor.reset(second);
    expect(editor.trip).toBe(second);
    expect(editor.canUndo).toBe(false);
    expect(editor.canRedo).toBe(false);
  });
});

describe('geometry commands', () => {
  it('reversing twice is the identity, and one reversal mirrors ascent and descent', () => {
    const points = straightPoints(8.3, 8.4, 61.5, 6, ELEVATED);
    const start = makeTrip(points);
    const editor = createEditor(start, { now: fixedClock() });

    const once = editor.apply({ type: 'reverse-leg', legId: 'leg-1' });
    expect(once.legs[0].points.map((p) => p.lon)).toEqual([...points].reverse().map((p) => p.lon));
    expect(once.legs[0].ascentM).toBe(start.legs[0].descentM);

    const twice = editor.apply({ type: 'reverse-leg', legId: 'leg-1' });
    expect(twice.legs[0].points).toEqual(start.legs[0].points);
    expect(twice.legs[0].distanceM).toBeCloseTo(start.legs[0].distanceM as number, 9);
    expect(twice.legs[0].ascentM).toBe(start.legs[0].ascentM);
    expect(twice.legs[0].descentM).toBe(start.legs[0].descentM);
  });

  it('splitting then merging is lossless and unions provenance without duplicates', () => {
    const points = straightPoints(8.3, 8.4, 61.5, 6, ELEVATED);
    const start = makeTrip(points, {
      provenance: [{ kind: 'gpx-upload', label: 'gjendesheim-besseggen.gpx' }],
    });
    const editor = createEditor(start, { now: fixedClock() });

    const split = editor.apply({ type: 'split-leg', legId: 'leg-1', index: 3 });
    expect(split.legs).toHaveLength(2);
    expect(split.legs[0].points).toEqual(points.slice(0, 4));
    expect(split.legs[1].points).toEqual(points.slice(3));
    expect(split.legs[1].id).not.toBe(split.legs[0].id);
    expect(split.legs[1].name).toBe('Jotunheimen (2)');

    const merged = editor.apply({ type: 'merge-legs', legId: 'leg-1', withLegId: split.legs[1].id });
    expect(merged.legs).toHaveLength(1);
    expect(merged.legs[0].id).toBe('leg-1');
    expect(merged.legs[0].points).toEqual(points);
    expect(merged.legs[0].distanceM).toBeCloseTo(start.legs[0].distanceM as number, 9);
    expect(merged.legs[0].ascentM).toBe(start.legs[0].ascentM);
    // Provenance unioned and de-duplicated, not doubled by the round trip.
    expect(merged.legs[0].provenance.filter((entry) => entry.kind === 'gpx-upload')).toHaveLength(1);

    // Two legs with overlapping provenance: the duplicate label is dropped and
    // the result records that it was edited.
    const a = makeTrip(straightPoints(8.3, 8.32, 61.5, 3, ELEVATED), {
      legId: 'leg-a',
      provenance: [{ kind: 'turrutebasen', label: 'jot15' }],
    });
    const both: Trip = {
      ...a,
      legs: [
        a.legs[0],
        {
          ...a.legs[0],
          id: 'leg-b',
          points: straightPoints(8.32, 8.34, 61.5, 3, ELEVATED),
          provenance: [{ kind: 'turrutebasen', label: 'jot15' }, { kind: 'drawn' }],
        },
      ],
    };
    const provenance = createEditor(both, { now: fixedClock() }).apply({
      type: 'merge-legs',
      legId: 'leg-a',
      withLegId: 'leg-b',
    }).legs[0]!.provenance;
    expect(provenance.filter((entry) => entry.label === 'jot15')).toHaveLength(1);
    expect(provenance.some((entry) => entry.kind === 'drawn')).toBe(true);
    expect(provenance[provenance.length - 1]).toEqual({ kind: 'edited', modified: true });
  });

  it('move, insert, replace-span, trim, rename and delete-leg keep geometry and provenance honest', () => {
    const points = straightPoints(8.3, 8.4, 61.5, 5, ELEVATED);
    const start = makeTrip(points, {
      provenance: [{ kind: 'gpx-upload', label: 'source', url: 'https://example.test/x.gpx' }],
    });
    const editor = createEditor(start, { now: fixedClock() });

    // move: elevation survives, the rest of the line is untouched.
    const moved = editor.apply({
      type: 'move',
      legId: 'leg-1',
      index: 2,
      point: { lon: 8.355, lat: 61.5005, ele: 1040, eleSource: 'gpx' },
    });
    expect(moved.legs[0].points[2]).toEqual({ lon: 8.355, lat: 61.5005, ele: 1040, eleSource: 'gpx' });
    expect(moved.legs[0].points[1]).toEqual(points[1]);
    expect(moved.legs[0].provenance[0]).toEqual(start.legs[0].provenance[0]);
    expect(moved.legs[0].provenance).toHaveLength(2);
    expect(moved.legs[0].provenance[1]).toEqual({ kind: 'edited', modified: true });

    const inserted = editor.apply({
      type: 'insert',
      legId: 'leg-1',
      index: 4,
      point: { lon: 8.365, lat: 61.5, ele: 1010, eleSource: 'dem' },
    });
    expect(inserted.legs[0].points).toHaveLength(6);
    expect(inserted.legs[0].points[4]).toEqual({ lon: 8.365, lat: 61.5, ele: 1010, eleSource: 'dem' });
    expect(inserted.legs[0].provenance).toHaveLength(3);
    expect(inserted.legs[0].points[3]).toEqual(moved.legs[0].points[3]);
    expect(inserted.legs[0].ascentM).not.toBeNull();

    // insert may append; with no elevations the climb is unknown, not 0.
    const appended = createEditor(makeTrip(straightPoints(8.3, 8.34, 61.5, 2)), {
      now: fixedClock(),
    }).apply({ type: 'insert', legId: 'leg-1', index: 2, point: { lon: 8.36, lat: 61.5 } });
    expect(appended.legs[0].points.map((p) => p.lon)).toEqual([8.3, 8.34, 8.36]);
    expect(appended.legs[0].ascentM).toBeNull();
    expect(appended.legs[0].distanceM).toBeGreaterThan(0);

    // replace-span records the snapped marker once, however often it is applied.
    const spanned = createEditor(makeTrip(straightPoints(8.3, 8.4, 61.5, 5, ELEVATED)), {
      now: fixedClock(),
    });
    const first = spanned.apply({
      type: 'replace-span',
      legId: 'leg-1',
      from: 1,
      to: 3,
      points: [
        { lon: 8.33, lat: 61.51 },
        { lon: 8.34, lat: 61.52 },
      ],
      snapped: true,
    });
    expect(first.legs[0].points).toHaveLength(4);
    expect(first.legs[0].points.map((p) => p.lat)).toEqual([61.5, 61.51, 61.52, 61.5]);
    expect(first.legs[0].provenance.filter((e) => e.kind === 'snapped')).toHaveLength(1);

    const second = spanned.apply({
      type: 'replace-span',
      legId: 'leg-1',
      from: 1,
      to: 2,
      points: [{ lon: 8.35, lat: 61.5 }],
      snapped: true,
    });
    expect(second.legs[0].provenance.filter((e) => e.kind === 'snapped')).toHaveLength(1);
    expect(second.legs[0].provenance.filter((e) => e.kind === 'edited' && !e.label)).toHaveLength(2);

    // rename trims, and clears an empty name entirely.
    const named = createEditor(makeTrip(straightPoints(8.3, 8.4, 61.5, 4, ELEVATED)), {
      now: fixedClock(),
    });
    const renamed = named.apply({ type: 'rename-leg', legId: 'leg-1', name: '  Glitterheim  ' });
    expect(renamed.legs[0].name).toBe('Glitterheim');
    expect(renamed.legs[0].points).toEqual(straightPoints(8.3, 8.4, 61.5, 4, ELEVATED));
    expect(renamed.legs[0].provenance).toEqual([{ kind: 'drawn' }, { kind: 'edited', modified: true }]);
    const cleared = named.apply({ type: 'rename-leg', legId: 'leg-1', name: '   ' });
    expect(cleared.legs[0].name).toBeUndefined();
    expect('name' in cleared.legs[0]).toBe(false);

    // trim keeps an inclusive sub-range and is fully undoable.
    const trimPoints = straightPoints(8.3, 8.4, 61.5, 6, ELEVATED);
    const trimStart = makeTrip(trimPoints);
    const trimEditor = createEditor(trimStart, { now: fixedClock() });
    const trimmed = trimEditor.apply({ type: 'trim-leg', legId: 'leg-1', from: 1, to: 4 });
    expect(trimmed.legs[0].points).toEqual(trimPoints.slice(1, 5));
    expect(trimmed.legs[0].distanceM as number).toBeLessThan(trimStart.legs[0].distanceM as number);
    expect(trimEditor.undo()).toEqual(trimStart);

    // delete-leg removes the last leg, leaving an empty trip with no distance.
    const deleted = editor.apply({ type: 'delete-leg', legId: 'leg-1' });
    expect(deleted.legs).toEqual([]);
    expect(tripDistanceM(deleted)).toBeNull();
    expect(editor.undo()).toEqual(inserted);
  });
});

describe('validation', () => {
  const trip = (): Trip => makeTrip(straightPoints(8.3, 8.4, 61.5, 4, ELEVATED));

  it('rejects a leg below the two-point floor, bad indices, unknown legs, bad points and merge-self', () => {
    const editor = createEditor(trip(), { now: fixedClock() });
    editor.apply({ type: 'trim-leg', legId: 'leg-1', from: 0, to: 1 });
    const before = editor.trip;
    expectCode(() => editor.apply({ type: 'delete-vertex', legId: 'leg-1', index: 0 }), 'leg-too-short');
    expect(editor.trip).toBe(before);
    expect(editor.trip.legs[0].points).toHaveLength(2);

    const fresh = createEditor(trip(), { now: fixedClock() });
    const badIndices: RouteCommand[] = [
      { type: 'insert', legId: 'leg-1', index: 99, point: { lon: 8.3, lat: 61.5 } },
      { type: 'move', legId: 'leg-1', index: -1, point: { lon: 8.3, lat: 61.5 } },
      { type: 'move', legId: 'leg-1', index: 1.5, point: { lon: 8.3, lat: 61.5 } },
      { type: 'delete-vertex', legId: 'leg-1', index: 4 },
      { type: 'split-leg', legId: 'leg-1', index: 0 },
      { type: 'split-leg', legId: 'leg-1', index: 3 },
      { type: 'trim-leg', legId: 'leg-1', from: 3, to: 1 },
      {
        type: 'replace-span',
        legId: 'leg-1',
        from: 2,
        to: 1,
        points: [{ lon: 8.3, lat: 61.5 }],
        snapped: false,
      },
    ];
    for (const command of badIndices) expectCode(() => fresh.apply(command), 'index-out-of-range');
    expectCode(() => fresh.apply({ type: 'trim-leg', legId: 'leg-1', from: 1, to: 1 }), 'leg-too-short');
    expectCode(
      () =>
        fresh.apply({
          type: 'replace-span',
          legId: 'leg-1',
          from: 0,
          to: 3,
          points: [{ lon: 8.3, lat: 61.5 }],
          snapped: false,
        }),
      'leg-too-short',
    );
    expect(fresh.trip).toEqual(trip());

    expectCode(() => fresh.apply({ type: 'reverse-leg', legId: 'nope' }), 'unknown-leg');
    expectCode(() => fresh.apply({ type: 'delete-leg', legId: 'nope' }), 'unknown-leg');
    expectCode(
      () => fresh.apply({ type: 'insert', legId: 'leg-1', index: 0, point: { lon: Number.NaN, lat: 61.5 } }),
      'invalid-point',
    );
    expectCode(
      () =>
        fresh.apply({
          type: 'move',
          legId: 'leg-1',
          index: 0,
          point: { lon: 8.3, lat: 61.5, ele: Number.POSITIVE_INFINITY },
        }),
      'invalid-point',
    );
    expectCode(() => fresh.apply({ type: 'merge-legs', legId: 'leg-1', withLegId: 'leg-1' }), 'invalid-command');

    // A failed command does not pollute the undo history.
    expect(fresh.canUndo).toBe(false);
  });
});
