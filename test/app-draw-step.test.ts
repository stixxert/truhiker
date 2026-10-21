/**
 * The drawn step, end to end and offline.
 *
 * `drawStepCommand` is the decision the map makes on every click: a single vertex,
 * or the trail path between two snapped points. The path itself is produced by the
 * routing engine (`buildTrailGraph` + `routeBetweenPoints`) and the app never
 * invents one — so this test builds a *real* graph from a synthetic curved trail,
 * routes across it, and checks the command that reaches the trip.
 *
 * That is the point: the app's branch was previously only verifiable against
 * Turrutebasen, which makes it unverifiable on the day the service is down.
 */
import { describe, expect, it } from 'vitest';

import type { Trip } from '../src/contracts';
import { applyCommand } from '../src/route/editor';
import { buildTrailGraph, type TrailLine } from '../src/route/trail-graph';
import { routeBetweenPoints } from '../src/route/trail-routing';
import { defaultProfile, emptyTrip } from '../src/store/trip';
import {
  drawStepCommand,
  initialEditorState,
  selectLeg,
  setMode,
} from '../src/app/editor-state';
import type { LonLat } from '../src/core/geo';

/** A trail that bends: three legs, ~75 m each, at 61.5°N. */
const CURVED: TrailLine = {
  id: 'curved',
  points: [
    { lon: 8.5, lat: 61.5 },
    { lon: 8.501, lat: 61.5006 },
    { lon: 8.5025, lat: 61.5009 },
    { lon: 8.504, lat: 61.5006 },
  ],
};

function tripWith(points: LonLat[]): Trip {
  return {
    ...emptyTrip('draw-step', defaultProfile()),
    legs: [
      {
        id: 'leg-1',
        points: points.map((point) => ({ lon: point.lon, lat: point.lat })),
        provenance: [],
        distanceM: null,
        ascentM: null,
        descentM: null,
      },
    ],
  };
}

function stateFor(trip: Trip) {
  const base = initialEditorState(trip);
  return selectLeg(setMode(base, 'draw', trip), 'leg-1');
}

describe('drawStepCommand — drawing along a trail', () => {
  it('turns a snapped step into the trail path as one edit, and keeps a plain vertex otherwise', () => {
    const graph = buildTrailGraph([CURVED], { mergeToleranceM: 5 });
    // A leg with two *distinct* vertices: the placeholder check (all one coordinate)
    // is what makes a padded first click a replace-span instead of an insert.
    const anchor = CURVED.points[1];
    const from = anchor;
    const to = CURVED.points[CURVED.points.length - 1];
    const routed = routeBetweenPoints(graph, from, to, { maxSnapDistanceM: 75 });
    expect(routed.kind).toBe('ok');
    if (routed.kind !== 'ok') return;
    // A bend, not the chord: three or more points means the geometry came from the
    // trail rather than from a straight line between the ends.
    expect(routed.points.length).toBeGreaterThanOrEqual(3);

    const trip = tripWith([CURVED.points[0], anchor]);
    const state = stateFor(trip);
    const append = drawStepCommand({
      state,
      trip,
      point: { lon: to.lon, lat: to.lat },
      snapped: true,
      anchor: { lon: from.lon, lat: from.lat },
      path: routed.points,
    });
    expect(append).toMatchObject({ type: 'replace-span', legId: 'leg-1', snapped: true });
    if (!append || append.type !== 'replace-span') return;
    // Applied to the trip it grows the leg by the path, with the anchor kept once.
    const after = applyCommand(trip, append, { now: () => new Date(0) });
    expect(after.legs[0].points.length).toBe(1 + routed.points.length);
    expect(after.legs[0].points[0]).toMatchObject({ lon: CURVED.points[0].lon, lat: CURVED.points[0].lat });
    expect(after.legs[0].points[1]).toMatchObject({ lon: anchor.lon, lat: anchor.lat });
    expect(after.legs[0].points[after.legs[0].points.length - 1]).toMatchObject({
      lon: to.lon,
      lat: to.lat,
    });
    // The step is recorded as snapped, because it came off the trail.
    expect(after.legs[0].provenance).toContainEqual({ kind: 'snapped', modified: true });

    // No path (different components, dead reckoning, service down) → plain vertex:
    // the click still lands, and the map's off-trail styling is what says so.
    const plain = drawStepCommand({
      state,
      trip,
      point: { lon: to.lon, lat: to.lat },
      snapped: true,
      anchor: { lon: from.lon, lat: from.lat },
      path: null,
    });
    expect(plain).toMatchObject({ type: 'insert', snapped: true });
    // An unsnapped click never claims a path, even if one was offered.
    const unsnapped = drawStepCommand({
      state,
      trip,
      point: { lon: to.lon, lat: to.lat },
      snapped: false,
      anchor: { lon: from.lon, lat: from.lat },
      path: routed.points,
    });
    expect(unsnapped).toMatchObject({ type: 'insert', snapped: false });
  });
});
