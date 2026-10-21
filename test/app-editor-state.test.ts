import { describe, expect, it } from 'vitest';

import type { Leg, Trip } from '../src/contracts';
import { applyCommand } from '../src/route/editor';
import { defaultProfile, emptyTrip } from '../src/store/trip';
import {
  DEFAULT_SNAP_RADIUS_M,
  availableCommands,
  clampSnapRadius,
  deleteLegCommand,
  deleteVertexCommand,
  drawPointCommand,
  editorKeyAction,
  initialEditorState,
  insertionIndexForClick,
  moveVertexCommand,
  noteDrawnPoint,
  renameCommand,
  reverseCommand,
  selectLeg,
  selectVertex,
  setMode,
  setRadius,
  SNAP_PREFETCH_MIN_ZOOM,
  setSnapping,
  shouldPrefetchSnap,
  splitCommand,
  trimCommand,
} from '../src/app/editor-state';

function points(count: number): Leg['points'] {
  return Array.from({ length: count }, (_, index) => ({
    lon: 8 + index * 0.001,
    lat: 61 + index * 0.001,
    eleSource: 'none' as const,
  }));
}

function leg(id: string, count = 4): Leg {
  return {
    id,
    name: `Leg ${id}`,
    points: points(count),
    provenance: [{ kind: 'drawn' }],
    distanceM: 100,
    ascentM: null,
    descentM: null,
  };
}

function placeholderLeg(): Leg {
  return {
    id: 'empty',
    points: [
      { lon: 0, lat: 0, eleSource: 'none' },
      { lon: 0, lat: 0, eleSource: 'none' },
    ],
    provenance: [],
    distanceM: 0,
    ascentM: null,
    descentM: null,
  };
}

function trip(legs: Leg[]): Trip {
  return {
    schemaVersion: 1,
    id: 't',
    name: 'T',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    legs,
    profile: {
      massKg: 75,
      heightCm: 178,
      ageYears: 35,
      sex: 'male',
      packBaseKg: 12,
      dailyKm: 20,
      dailyHours: 8,
      support: 'carry-all',
    },
  };
}

describe('editor state', () => {
  it('starts in view mode with snapping on and the last leg active', () => {
    const state = initialEditorState(trip([leg('a'), leg('b')]));
    expect(state.mode).toBe('view');
    expect(state.snapping).toBe(true);
    expect(state.activeLegId).toBe('b');
    expect(state.radiusM).toBe(DEFAULT_SNAP_RADIUS_M);
  });

  it('clamps the snap radius and rejects junk', () => {
    expect(clampSnapRadius(5)).toBe(20);
    expect(clampSnapRadius(10_000)).toBe(300);
    expect(clampSnapRadius('90')).toBe(90);
    expect(clampSnapRadius('abc')).toBe(DEFAULT_SNAP_RADIUS_M);
    const state = setRadius(initialEditorState(trip([leg('a')])), 500);
    expect(state.radiusM).toBe(300);
    expect(setSnapping(state, false).snapping).toBe(false);
  });

  it('clears the selection when the mode changes and tracks the draw target', () => {
    const model = trip([leg('a')]);
    const selected = selectVertex(initialEditorState(model), 'a', 2, false);
    const drawing = setMode(selected, 'draw', model);
    expect(drawing.selection).toBeNull();
    expect(drawing.mode).toBe('draw');
    expect(drawing.drawPoints).toEqual([]);
    const back = setMode(drawing, 'view', model);
    expect(back.drawPoints).toEqual([]);
  });

  it('selects a span with extend and maps it to a trim command', () => {
    const model = trip([leg('a', 5)]);
    let state = selectVertex(initialEditorState(model), 'a', 1, false);
    state = selectVertex(state, 'a', 3, true);
    expect(state.selection).toEqual({ legId: 'a', from: 1, to: 3 });
    expect(availableCommands(state, model).canTrim).toBe(true);
    expect(trimCommand(state)).toEqual({ type: 'trim-leg', legId: 'a', from: 1, to: 3 });

    const reversed = selectVertex(state, 'a', 3, true);
    expect(trimCommand(reversed)).toMatchObject({ from: 1, to: 3 });
  });

  it('reports which commands are available for a single vertex', () => {
    const model = trip([leg('a', 4)]);
    const first = selectVertex(initialEditorState(model), 'a', 0, false);
    const commands = availableCommands(first, model);
    expect(commands.canDeleteVertex).toBe(true);
    expect(commands.canSplit).toBe(false); // cannot split at an endpoint
    expect(commands.canTrim).toBe(false); // needs a second anchor
    expect(commands.canReroute).toBe(false);
    expect(commands.canReverse).toBe(true);
    expect(commands.canDeleteLeg).toBe(false); // only one leg

    const middle = selectVertex(first, 'a', 2, false);
    expect(availableCommands(middle, model).canSplit).toBe(true);

    const twoLegs = trip([leg('a', 4), leg('b', 4)]);
    expect(availableCommands(middle, twoLegs).canDeleteLeg).toBe(true);

    // A two-point leg has no vertex to spare: the invariant is a leg with ≥2.
    const tiny = trip([leg('a', 2)]);
    const tinyState = selectVertex(initialEditorState(tiny), 'a', 0, false);
    expect(availableCommands(tinyState, tiny).canDeleteVertex).toBe(false);
  });

  it('builds delete/split/reverse/rename/delete-leg commands', () => {
    const model = trip([leg('a', 4), leg('b', 3)]);
    let state = initialEditorState(model);
    state = selectVertex(state, 'a', 2, false);
    expect(deleteVertexCommand(state)).toEqual({ type: 'delete-vertex', legId: 'a', index: 2 });
    expect(splitCommand(state)).toEqual({ type: 'split-leg', legId: 'a', index: 2 });
    expect(reverseCommand(state, model)).toEqual({ type: 'reverse-leg', legId: 'a' });
    expect(renameCommand(state, model, 'Ny')).toEqual({
      type: 'rename-leg',
      legId: 'a',
      name: 'Ny',
    });
    expect(renameCommand(state, model, '  ')).toBeNull();
    expect(renameCommand(state, model, 'Leg a')).toBeNull(); // unchanged
    expect(deleteLegCommand(state, model)).toEqual({ type: 'delete-leg', legId: 'a' });

    const selectB = selectLeg(state, 'b');
    expect(deleteLegCommand(selectB, model)).toEqual({ type: 'delete-leg', legId: 'b' });
    expect(reverseCommand(selectB, model)).toEqual({ type: 'reverse-leg', legId: 'b' });

    // With nothing selected there is no vertex command — and deleting the only
    // leg is still a command (it is the way to abandon it).
    const blank = initialEditorState(trip([leg('a')]));
    expect(deleteVertexCommand(blank)).toBeNull();
    expect(splitCommand(blank)).toBeNull();
    expect(trimCommand(blank)).toBeNull();
    expect(deleteLegCommand(blank, trip([leg('a')]))).toEqual({ type: 'delete-leg', legId: 'a' });
  });

  it('inserts points at the end of a real leg when drawing', () => {
    const model = trip([leg('a', 3)]);
    const state = setMode(initialEditorState(model), 'draw', model);
    const command = drawPointCommand(state, model, { lon: 9, lat: 62 });
    expect(command).toEqual({
      type: 'insert',
      legId: 'a',
      index: 3,
      point: { lon: 9, lat: 62 },
      snapped: false,
    });
    // A drawn point that came from a trail snap carries it into the command, and
    // the command layer records it as provenance (D5). Before this, only a
    // replaced span recorded `snapped`, so every point after the first two lost it.
    const snappedCommand = drawPointCommand(state, model, { lon: 9, lat: 62 }, true);
    expect(snappedCommand).toMatchObject({ type: 'insert', snapped: true });
    const applied = applyCommand(model, snappedCommand!, { now: () => new Date(0) });
    expect(applied.legs[0].provenance).toContainEqual({ kind: 'snapped', modified: true });
    // ... and an unsnapped point does not claim to be snapped.
    const plain = applyCommand(model, command!, { now: () => new Date(0) });
    expect(plain.legs[0].provenance.some((entry) => entry.kind === 'snapped')).toBe(false);
  });

  it('replaces a placeholder leg while drawing and pads to two points', () => {
    const model = trip([placeholderLeg()]);
    const state = setMode(initialEditorState(model), 'draw', model);
    expect(state.drawReplacesLeg).toBe(true);

    const first = drawPointCommand(state, model, { lon: 8, lat: 61 });
    expect(first).toMatchObject({
      type: 'replace-span',
      legId: 'empty',
      from: 0,
      to: 1,
      points: [
        { lon: 8, lat: 61 },
        { lon: 8, lat: 61 },
      ],
    });

    const second = drawPointCommand(
      noteDrawnPoint(state, { lon: 8, lat: 61 }),
      model,
      { lon: 8.1, lat: 61.1 },
    );
    expect(second).toMatchObject({
      type: 'replace-span',
      points: [
        { lon: 8, lat: 61 },
        { lon: 8.1, lat: 61.1 },
      ],
    });
  });

  /**
   * What the app is allowed to fetch, and when.
   *
   * Same promise the shops layer makes: a data-saver connection is not made to
   * pay for map decoration, and a country view has nothing a 75 m radius can act
   * on (D5) — so the prefetch is skipped rather than merely cheap.
   */
  it('prefetches the trail network only where it can be used, and never against saveData', () => {
    expect(shouldPrefetchSnap({ zoom: 14, saveData: false })).toBe(true);
    expect(shouldPrefetchSnap({ zoom: SNAP_PREFETCH_MIN_ZOOM, saveData: false })).toBe(true);
    expect(shouldPrefetchSnap({ zoom: SNAP_PREFETCH_MIN_ZOOM - 0.01, saveData: false })).toBe(false);
    expect(shouldPrefetchSnap({ zoom: 5, saveData: false })).toBe(false);
    expect(shouldPrefetchSnap({ zoom: 16, saveData: true })).toBe(false);
  });

  it('derives a move command for a dragged vertex', () => {
    expect(moveVertexCommand('a', 2, { lon: 1, lat: 2 })).toEqual({
      type: 'move',
      legId: 'a',
      index: 2,
      point: { lon: 1, lat: 2 },
    });
  });

  it('finds the insertion index on the nearest screen-space segment', () => {
    const line = points(4);
    const project = (point: { lon: number; lat: number }) => ({
      x: (point.lon - 8) * 10_000,
      y: 0,
    });
    // Between the second and third vertex → insert at index 2.
    expect(insertionIndexForClick(line, { lon: 8.0012, lat: 61 }, project)).toBe(2);
    // Near the last segment → insert at index 3.
    expect(insertionIndexForClick(line, { lon: 8.0029, lat: 61 }, project)).toBe(3);
    expect(insertionIndexForClick([], { lon: 8, lat: 61 }, project)).toBe(0);
  });
});

describe('a new trip', () => {
  it('starts empty, in draw mode, with no active leg until the first point', () => {
    const trip = emptyTrip('Untitled route', defaultProfile());
    expect(trip.legs).toEqual([]);

    const state = setMode(initialEditorState(trip), 'draw', trip);
    expect(state.mode).toBe('draw');
    // Nothing to act on yet: the first map click creates the leg (drawPoint).
    expect(state.activeLegId).toBeNull();
    expect(availableCommands(state, trip).canDeleteLeg).toBe(false);
  });
});

describe('keyboard contract', () => {
  it('maps Escape, Backspace and Delete to the mode they belong to', () => {
    expect(editorKeyAction('draw', 'Escape')).toBe('leave-mode');
    expect(editorKeyAction('edit', 'Escape')).toBe('leave-mode');
    expect(editorKeyAction('draw', 'Backspace')).toBe('undo');
    expect(editorKeyAction('edit', 'Backspace')).toBeNull();
    expect(editorKeyAction('edit', 'Delete')).toBe('delete-selection');
    expect(editorKeyAction('draw', 'Delete')).toBeNull();
    // View mode has no editor keys, and typing or an open panel swallows them all.
    expect(editorKeyAction('view', 'Escape')).toBeNull();
    expect(editorKeyAction('draw', 'Backspace', { typing: true })).toBeNull();
    expect(editorKeyAction('draw', 'Escape', { panelOpen: true })).toBeNull();
    expect(editorKeyAction('draw', 'Escape', { routePick: true })).toBeNull();
  });
});
