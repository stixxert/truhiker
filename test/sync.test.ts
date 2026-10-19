import { describe, expect, it } from 'vitest';

import { cumulativeDistances } from '../src/core/geo';
import {
  TILE_SIZE,
  clampDistance,
  lonLatToMercator,
  mercatorScale,
  nearestRoutePoint,
  pointAtDistance,
} from '../src/lib/sync';
import type { RouteGeometry } from '../src/lib/sync';

function geometry(coords: Array<{ lon: number; lat: number }>): RouteGeometry {
  return { points: coords, distances: cumulativeDistances(coords) };
}

// A straight west→east line through Jotunheimen, ~1 km per 0.02° longitude.
const line = geometry([
  { lon: 8.3, lat: 61.5 },
  { lon: 8.32, lat: 61.5 },
  { lon: 8.34, lat: 61.5 },
  { lon: 8.36, lat: 61.5 },
  { lon: 8.38, lat: 61.5 },
]);

describe('Web-Mercator projection helpers', () => {
  it('maps the world edges, is monotonic in both axes, and doubles the pixel scale per zoom', () => {
    const origin = lonLatToMercator(0, 0);
    expect(origin.x).toBeCloseTo(0.5, 12);
    expect(origin.y).toBeCloseTo(0.5, 12);

    expect(lonLatToMercator(180, 0).x).toBeCloseTo(1, 12);
    expect(lonLatToMercator(-180, 0).x).toBeCloseTo(0, 12);
    expect(lonLatToMercator(0, 85.051129).y).toBeCloseTo(0, 6);

    expect(lonLatToMercator(10, 60).x).toBeGreaterThan(lonLatToMercator(9, 60).x);
    expect(lonLatToMercator(10, 61).y).toBeLessThan(lonLatToMercator(10, 60).y);

    expect(mercatorScale(0)).toBe(TILE_SIZE);
    expect(mercatorScale(1)).toBe(TILE_SIZE * 2);
    expect(mercatorScale(10)).toBe(TILE_SIZE * 1024);
  });
});

describe('nearestRoutePoint', () => {
  it('finds the exact vertex, snaps when off-route, scales with zoom, handles long routes and empty geometry', () => {
    const nearest = nearestRoutePoint(line, { lon: 8.34, lat: 61.5 }, 12);
    expect(nearest).not.toBeNull();
    expect(nearest?.index).toBe(2);
    expect(nearest?.distanceM).toBeCloseTo(line.distances[2]!, 6);
    expect(nearest?.screenPx).toBeCloseTo(0, 6);

    expect(nearestRoutePoint(line, { lon: 8.355, lat: 61.51 }, 12)?.index).toBe(3);

    // Screen distance doubles with one zoom level.
    const centre = { lon: 8.3, lat: 61.6 }; // ~11 km north of the line
    const a = nearestRoutePoint(line, centre, 10)!;
    const b = nearestRoutePoint(line, centre, 11)!;
    expect(b.screenPx / a.screenPx).toBeCloseTo(2, 6);

    // The coarse+refine pass never misses the last point of a long route.
    const coords = Array.from({ length: 5000 }, (_, i) => ({ lon: 5 + i * 0.001, lat: 60 }));
    const long = geometry(coords);
    expect(nearestRoutePoint(long, { lon: 5 + 4999 * 0.001, lat: 60 }, 9)?.index).toBe(4999);

    expect(nearestRoutePoint({ points: [], distances: [] }, { lon: 0, lat: 0 }, 5)).toBeNull();
  });
});

describe('pointAtDistance', () => {
  it('interpolates, clamps beyond the ends, handles a single point and empty geometry, and round-trips distances', () => {
    const halfway = pointAtDistance(line, line.distances[1]! / 2)!;
    expect(halfway.lon).toBeCloseTo(8.31, 9);
    expect(halfway.lat).toBeCloseTo(61.5, 12);

    expect(pointAtDistance(line, -100)).toEqual({ lon: 8.3, lat: 61.5 });
    expect(pointAtDistance(line, 1e9)).toEqual({ lon: 8.38, lat: 61.5 });

    expect(pointAtDistance(geometry([{ lon: 7, lat: 60 }]), 50)).toEqual({ lon: 7, lat: 60 });
    expect(pointAtDistance({ points: [], distances: [] }, 0)).toBeNull();

    // The map marker's distance → point → distance round-trip is exact.
    for (const index of [0, 1, 2, 3, 4]) {
      const point = pointAtDistance(line, line.distances[index]!)!;
      expect(nearestRoutePoint(line, point, 14)?.index).toBe(index);
    }
  });
});

describe('clampDistance', () => {
  it('keeps the cursor inside the route', () => {
    const total = line.distances[line.distances.length - 1]!;
    expect(clampDistance(line, -10)).toBe(0);
    expect(clampDistance(line, total + 10)).toBeCloseTo(total, 9);
    expect(clampDistance(line, 123)).toBe(123);
    expect(clampDistance({ points: [], distances: [] }, 10)).toBe(0);
  });
});
