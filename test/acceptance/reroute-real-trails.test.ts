/**
 * Acceptance #4 — reroute against the only real trail network we have.
 *
 * The fixture is a recorded Turrutebasen `GetFeature` response (seven Fotrute
 * features around Gjendesheim). Until now it was only parsed; here it is the
 * index the rerouter actually snaps against.
 *
 * "Within 1 m of the polyline" is measured with an independent local
 * equirectangular projection in this file, not with `SnapIndex` itself, so the
 * assertion cannot be satisfied by the code under test agreeing with itself.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { RoutePoint, Trip } from '../../src/contracts';
import { rerouteSpan, tripFromPoints } from '../../src/route';
import { METRES_PER_DEG_LAT, SnapIndex, type LonLat, type TurruteLine } from '../../src/snap';
import { parseTurruteGml } from '../../src/snap/wfs';
import { PROFILE, fixedClock } from '../route/helpers';

const FIXTURE = readFileSync(new URL('../snap/fixtures/turrute.gml', import.meta.url), 'utf8');
const LINES: TurruteLine[] = parseTurruteGml(FIXTURE).lines;

/** `point` moved `metres` perpendicular to the local trail direction. */
function offToTheSide(coords: readonly LonLat[], index: number, metres: number): LonLat {
  const a = coords[index - 1]!;
  const b = coords[index + 1]!;
  const point = coords[index]!;
  const mPerDegLat = METRES_PER_DEG_LAT;
  const mPerDegLon = METRES_PER_DEG_LAT * Math.cos((point.lat * Math.PI) / 180);
  const dx = (b.lon - a.lon) * mPerDegLon;
  const dy = (b.lat - a.lat) * mPerDegLat;
  const length = Math.hypot(dx, dy);
  // Left normal of the local direction.
  const ox = (-dy / length) * metres;
  const oy = (dx / length) * metres;
  return { lon: point.lon + ox / mPerDegLon, lat: point.lat + oy / mPerDegLat };
}

/** Independent point-to-polyline distance, metres (local equirectangular). */
function distanceToPolyline(point: LonLat, coords: readonly LonLat[]): number {
  const mPerDegLat = METRES_PER_DEG_LAT;
  const mPerDegLon = METRES_PER_DEG_LAT * Math.cos((point.lat * Math.PI) / 180);
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i + 1 < coords.length; i++) {
    const a = coords[i]!;
    const b = coords[i + 1]!;
    const bx = (b.lon - a.lon) * mPerDegLon;
    const by = (b.lat - a.lat) * mPerDegLat;
    const px = (point.lon - a.lon) * mPerDegLon;
    const py = (point.lat - a.lat) * mPerDegLat;
    const lengthSq = bx * bx + by * by;
    const t = lengthSq > 0 ? Math.max(0, Math.min(1, (px * bx + py * by) / lengthSq)) : 0;
    best = Math.min(best, Math.hypot(px - t * bx, py - t * by));
  }
  return best;
}

/** Distance from `point` to the nearest of the fixture's trails. */
function distanceToNetwork(point: LonLat, lines: readonly TurruteLine[] = LINES): number {
  return Math.min(...lines.map((line) => distanceToPolyline(point, line.coords)));
}

function rerouteWholeLeg(trip: Trip, index: SnapIndex): Trip {
  return rerouteSpan(trip, trip.legs[0]!.id, 0, trip.legs[0]!.points.length - 1, {
    snapIndex: index,
    now: fixedClock(),
  });
}

describe('acceptance: reroute against real Turrutebasen geometry', () => {
  it('snaps a leg drawn 30 m off a real trail onto it, every point within 1 m', () => {
    const index = new SnapIndex();
    index.addLines(LINES);

    // A long feature (240 vertices) is the most demanding target.
    const trail = LINES.reduce((longest, line) => (line.coords.length > longest.coords.length ? line : longest));
    const from = offToTheSide(trail.coords, 40, 30);
    const to = offToTheSide(trail.coords, 120, 30);

    // Before the reroute, the drawn leg is ~30 m away.
    expect(Math.min(distanceToNetwork(from), distanceToNetwork(to))).toBeGreaterThan(20);

    const trip = tripFromPoints([from, to], 'Off-trail cut', PROFILE, {
      now: fixedClock(),
    });
    const routed = rerouteWholeLeg(trip, index);
    const points: readonly RoutePoint[] = routed.legs[0]!.points;

    expect(points.length).toBeGreaterThan(2); // the trail's own bends were followed
    for (const point of points) {
      expect(distanceToPolyline(point, trail.coords), `${point.lon},${point.lat}`).toBeLessThan(1);
    }
    expect(routed.legs[0]!.provenance.some((entry) => entry.kind === 'snapped')).toBe(true);
    // And it really moved: the distance is no longer the straight-line cut.
    expect(routed.legs[0]!.distanceM as number).toBeGreaterThan(trip.legs[0]!.distanceM as number);
  });

  it('adds no bridging geometry across two features that do not connect', () => {
    const index = new SnapIndex();
    index.addLines(LINES);

    // The westernmost and easternmost features are ~4 km apart and unconnected.
    const byLongitude = [...LINES].sort(
      (a, b) => a.coords[0]!.lon - b.coords[0]!.lon,
    );
    const west = byLongitude[0]!;
    const east = byLongitude[byLongitude.length - 1]!;
    const from = offToTheSide(west.coords, Math.floor(west.coords.length / 2), 30);
    const to = offToTheSide(east.coords, Math.floor(east.coords.length / 2), 30);

    const trip = tripFromPoints([from, to], 'Across the gap', PROFILE, { now: fixedClock() });
    const routed = rerouteWholeLeg(trip, index);
    const points = routed.legs[0]!.points;

    // One vertex per end, each snapped onto its own trail: nothing is invented
    // in the gap between them.
    expect(points.length).toBeLessThanOrEqual(2);
    for (const point of points) {
      expect(distanceToNetwork(point)).toBeLessThan(1);
    }
    expect(routed.legs[0]!.provenance.some((entry) => entry.label === 'off-trail gap')).toBe(true);
  });
});
