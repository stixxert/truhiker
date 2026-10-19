import { describe, expect, it } from 'vitest';

import { haversine, type LonLat } from '../../src/core/geo';
import { routeBetweenLines, routeBetweenPoints } from '../../src/route/trail-routing';
import { buildTrailGraph } from '../../src/route/trail-graph';

const p = (lon: number, lat: number): LonLat => ({ lon, lat });
const A = p(8.3, 61.5);
const B = p(8.31, 61.5);
const C = p(8.32, 61.5);
const D = p(8.31, 61.51);

const line = (id: string, points: LonLat[]) => ({ id, points });

/** A point `metres` north of `at` (lat degrees are ~111.32 km). */
const north = (at: LonLat, metres: number): LonLat => ({
  lon: at.lon,
  lat: at.lat + metres / 111_320,
});

describe('route between points', () => {
  it('snaps two off-trail points onto a straight trail and follows it', () => {
    const result = routeBetweenLines(
      [line('west', [A, B])],
      north(A, 55),
      north(B, 55),
      { maxSnapDistanceM: 100 },
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.points[0]?.lat).toBeCloseTo(A.lat, 6);
    expect(result.points.at(-1)?.lon).toBeCloseTo(B.lon, 6);
    // Every returned vertex is on the trail (lat 61.5), not at the click.
    for (const point of result.points) expect(point.lat).toBeCloseTo(61.5, 6);
    expect(result.distanceM).toBeCloseTo(haversine(A, B), 1);
  });

  it('rejects a start or end that is farther from a trail than the radius', () => {
    const far = north(A, 600);
    expect(routeBetweenLines([line('west', [A, B])], far, B, { maxSnapDistanceM: 100 })).toEqual({
      kind: 'failed',
      code: 'no-trail-near-start',
    });
    expect(routeBetweenLines([line('west', [A, B])], A, far, { maxSnapDistanceM: 100 })).toEqual({
      kind: 'failed',
      code: 'no-trail-near-end',
    });
  });

  it('returns no-path for disconnected trails instead of a straight line', () => {
    const E = p(8.35, 61.5);
    const F = p(8.36, 61.5);
    const result = routeBetweenLines(
      [line('west', [A, B]), line('east', [E, F])],
      north(A, 5),
      north(F, 5),
      { maxSnapDistanceM: 50 },
    );
    expect(result).toEqual({ kind: 'failed', code: 'no-path' });
  });

  it('routes within a single segment without detouring through its endpoints', () => {
    const start = north(p(8.302, 61.5), 5);
    const end = north(p(8.308, 61.5), 5);
    const result = routeBetweenLines([line('west', [A, B])], start, end, { maxSnapDistanceM: 50 });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.points).toHaveLength(2);
    expect(result.points[0]).toEqual(result.snappedStart);
    expect(result.points[1]).toEqual(result.snappedEnd);
    expect(result.distanceM).toBeCloseTo(haversine(result.snappedStart, result.snappedEnd), 1);
    expect(result.distanceM).toBeLessThan(haversine(A, B) * 0.8);
  });

  it('routes across a junction, keeping the junction vertex', () => {
    const graph = buildTrailGraph([
      line('west', [A, B, C]),
      line('north', [B, D]),
    ]);
    const start = north(A, 5);
    const end = north(D, 5);
    const result = routeBetweenPoints(graph, start, end, { maxSnapDistanceM: 50 });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.points).toContainEqual(B);
    const expected =
      haversine(result.snappedStart, B) + haversine(B, result.snappedEnd);
    expect(result.distanceM).toBeCloseTo(expected, 1);
  });

  it('rejects a non-positive snap radius', () => {
    const graph = buildTrailGraph([line('west', [A, B])]);
    expect(() => routeBetweenPoints(graph, A, B, { maxSnapDistanceM: 0 })).toThrow(RangeError);
  });
});
