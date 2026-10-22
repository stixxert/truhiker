import { describe, expect, it } from 'vitest';

import { parseGpx } from '../src/core/gpx';
import {
  MAX_SAMPLES,
  SAMPLE_SPACING_M,
  buildRoute,
  checkSupported,
  displayCoordinates,
  pickTrack,
  routeBounds,
} from '../src/lib/route';
import { haversine, pathLength } from '../src/core/geo';

const simpleGpx = `<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Jotunheimen</name>
    <trkseg>
      <trkpt lat="61.5" lon="8.3"/>
      <trkpt lat="61.5" lon="8.31"/>
      <trkpt lat="61.5" lon="8.32"/>
    </trkseg>
  </trk>
</gpx>`;

describe('pickTrack', () => {
  it('prefers the first usable track, falls back to routes, and returns null when there is no geometry', () => {
    const track = pickTrack(parseGpx(simpleGpx));
    expect(track?.name).toBe('Jotunheimen');
    expect(track?.points).toHaveLength(3);

    const withRoute = pickTrack(
      parseGpx(`<gpx version="1.1">
        <trk><trkseg><trkpt lat="61" lon="8"/></trkseg></trk>
        <rte><name>Fallback</name><rtept lat="61" lon="8"/><rtept lat="61.01" lon="8.01"/></rte>
      </gpx>`),
    );
    expect(withRoute?.name).toBe('Fallback');

    expect(pickTrack(parseGpx(`<gpx version="1.1"><wpt lat="61" lon="8"/></gpx>`))).toBeNull();
  });
});

describe('buildRoute', () => {
  it('resamples at ~25 m, keeps the total length and caps the sample count for very long routes', () => {
    const route = buildRoute({
      name: 'Leg',
      origin: 'file',
      coords: [
        { lon: 8.3, lat: 61.5 },
        { lon: 8.32, lat: 61.5 },
      ],
    });
    expect(route.points.length).toBeGreaterThan(40);
    expect(route.distances).toHaveLength(route.points.length);
    // ~1.07 km at 61.5°N
    expect(route.distanceM).toBeGreaterThan(900);
    expect(route.distanceM).toBeLessThan(1200);
    expect(route.distances[0]).toBe(0);

    // Sample spacing is ~25 m; the final gap is the remainder of the route.
    const spaced = buildRoute({
      origin: 'file',
      coords: Array.from({ length: 101 }, (_, i) => ({ lon: 8.3 + i * 0.0003, lat: 61.5 })),
    });
    const gaps = spaced.distances.slice(1, -1).map((d, i) => d - spaced.distances[i]!);
    expect(Math.max(...gaps)).toBeLessThan(SAMPLE_SPACING_M * 1.01);
    expect(Math.min(...gaps)).toBeGreaterThan(SAMPLE_SPACING_M * 0.9);
    expect(
      spaced.distances[spaced.distances.length - 1]! - spaced.distances[spaced.distances.length - 2]!,
    ).toBeLessThanOrEqual(SAMPLE_SPACING_M);

    // ~600 km straight line across southern Norway.
    const long = buildRoute({
      origin: 'file',
      coords: [
        { lon: 5.5, lat: 58.5 },
        { lon: 12, lat: 61.5 },
      ],
    });
    expect(long.points.length).toBeLessThanOrEqual(MAX_SAMPLES + 2);
  });

  it('reports the route\'s measured length, not the shorter sampled polyline', () => {
    // A zigzag: resampling at 25 m cuts its corners, so the sampled polyline is
    // measurably shorter than the track. The route must still report one length —
    // the one its own geometry measures — and the profile must inherit it.
    const coords = Array.from({ length: 200 }, (_, i) => ({
      lon: 8.3 + i * 0.00004,
      lat: 61.5 + (i % 2 === 0 ? 0.00022 : -0.00022),
    }));
    const route = buildRoute({ origin: 'file', coords });
    const measured = pathLength(coords);
    const sampled = route.points.reduce((sum, point, i) => {
      if (i === 0) return 0;
      const previous = route.points[i - 1]!;
      return sum + haversine(previous, point);
    }, 0);
    // The fixture actually exercises the correction: sampling alone loses length.
    expect(sampled).toBeLessThan(measured * 0.99);
    expect(route.distanceM).toBeCloseTo(measured, 6);
    expect(route.distances[route.distances.length - 1]).toBeCloseTo(measured, 6);
    // Sample positions keep their order, so the axis still reads left to right.
    for (let i = 1; i < route.distances.length; i += 1) {
      expect(route.distances[i]!).toBeGreaterThan(route.distances[i - 1]!);
    }
  });

  it('rejects routes that cannot produce a profile and drops non-finite coordinates', () => {
    expect(() => buildRoute({ origin: 'file', coords: [{ lon: 8, lat: 61 }] })).toThrow();
    expect(() =>
      buildRoute({
        origin: 'file',
        coords: [
          { lon: 8, lat: 61 },
          { lon: 8, lat: 61 },
        ],
      }),
    ).toThrow();

    const dropped = buildRoute({
      origin: 'file',
      coords: [
        { lon: Number.NaN, lat: 61 },
        { lon: 8.3, lat: 61.5 },
        { lon: 8.32, lat: 61.5 },
      ],
    });
    expect(dropped.points.length).toBeGreaterThan(2);
    expect(Number.isFinite(dropped.points[0]!.lon)).toBe(true);
  });
});

describe('displayCoordinates', () => {
  it('passes short routes through, decimates long ones keeping the last point, and handles empty input', () => {
    expect(
      displayCoordinates([
        { lon: 8.3, lat: 61.5 },
        { lon: 8.31, lat: 61.5 },
      ]),
    ).toEqual([
      [8.3, 61.5],
      [8.31, 61.5],
    ]);

    const coords = Array.from({ length: 100_000 }, (_, i) => ({ lon: 5 + i * 1e-5, lat: 60 }));
    const display = displayCoordinates(coords, 1000);
    expect(display.length).toBeLessThanOrEqual(1001);
    expect(display[display.length - 1]).toEqual([coords[coords.length - 1]!.lon, 60]);

    expect(displayCoordinates([])).toEqual([]);
  });
});

describe('routeBounds / checkSupported', () => {
  it('computes the bounding box and reports how many points fall outside the supported area', () => {
    expect(
      routeBounds([
        { lon: 8, lat: 61 },
        { lon: 9, lat: 60 },
      ]),
    ).toEqual({ minLon: 8, minLat: 60, maxLon: 9, maxLat: 61 });
    expect(routeBounds([])).toBeNull();

    expect(checkSupported([{ lon: 8.3, lat: 61.5 }]).ok).toBe(true);
    const check = checkSupported([
      { lon: 8.3, lat: 61.5 },
      { lon: -3.7, lat: 58.6 }, // Scotland
      { lon: 2.35, lat: 48.85 }, // Paris
    ]);
    expect(check.ok).toBe(false);
    expect(check.outsidePoints).toBe(2);
  });
});
