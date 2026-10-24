import { describe, expect, it } from 'vitest';

import {
  MAX_LONGITUDE_OFFSET_DEG,
  UTM33_MAX_LON,
  UTM33_MIN_LON,
  ZONE33_CENTRAL_MERIDIAN_DEG,
  cumulativeDistances,
  fromUtm33,
  haversine,
  isInUtm33Window,
  pathLength,
  resample,
  toUtm33,
  type LonLat,
} from '../src/core/geo';

// Reference values computed independently with PROJ/pyproj
// (`Transformer.from_crs('EPSG:4326', 'EPSG:25833', always_xy=True)`).
// They lock the hand-written Karney/Krüger series to the real EPSG:25833
// definition (GRS80, k0=0.9996, false easting 500000, central meridian 15°E).
const PROJ_REFERENCE: ReadonlyArray<readonly [number, number, number, number]> = [
  [8.3124, 61.6363, 145995.812149, 6851874.314563], // Galdhøpiggen
  [5.3221, 60.3913, -32117.390649, 6734201.591538], // Bergen
  [10.7522, 59.9139, 262560.482181, 6649443.583973], // Oslo
  [18.9553, 69.6492, 653421.187635, 7731721.082897], // Tromsø
  [23.7, 70.66, 820600.0875, 7862498.298384], // Alta (8.7° from CM)
  [4.9, 61.4, -37861.960363, 6849122.694715], // Florø (-10.1° from CM)
  [12.5, 65.0, 382132.391818, 7210785.629396],
  [26.0, 70.5, 907847.932599, 7858677.526338],
];

describe('projection, distance and resampling', () => {
  it('matches PROJ for every reference point and round-trips', () => {
    for (const [lon, lat, easting, northing] of PROJ_REFERENCE) {
      const utm = toUtm33({ lon, lat });
      expect(utm.x, `easting ${lon},${lat}`).toBeCloseTo(easting, 2); // 1 cm
      expect(utm.y, `northing ${lon},${lat}`).toBeCloseTo(northing, 2);

      const back = fromUtm33(utm);
      expect(back.lon).toBeCloseTo(lon, 9);
      expect(back.lat).toBeCloseTo(lat, 9);
    }
  });

  it('is consistent with the service metadata, refuses out-of-domain input, and measures distance honestly', () => {
    // On the central meridian, x is the false easting (within the TM scale).
    const utm = toUtm33({ lon: 15, lat: 61 });
    expect(utm.x).toBeCloseTo(500000, 6);
    // k0 = 0.9996 along the central meridian, so the northing is slightly
    // less than the meridian arc.
    expect(utm.y).toBeGreaterThan(6_700_000);
    expect(utm.y).toBeLessThan(6_800_000);

    expect(() => toUtm33({ lon: 28.5, lat: 60 })).toThrow(/central meridian/);
    expect(() => toUtm33({ lon: -179, lat: 60 })).toThrow(/central meridian/);
    expect(() => toUtm33({ lon: 8.3, lat: 85 })).toThrow(/outside the UTM domain/);
    expect(() => toUtm33({ lon: Number.NaN, lat: 60 })).toThrow(RangeError);
    expect(() => fromUtm33({ x: Number.POSITIVE_INFINITY, y: 0 })).toThrow(RangeError);

    // Haversine matches the WGS84 geodesic within 0.5 %, is zero for identical
    // points, symmetric, and accumulates along a polyline.
    // pyproj.Geod(ellps='WGS84').inv(...) = 306.165 km
    const d = haversine({ lon: 10.7522, lat: 59.9139 }, { lon: 5.3221, lat: 60.3913 });
    expect(d / 1000).toBeGreaterThan(306.165 * 0.995);
    expect(d / 1000).toBeLessThan(306.165 * 1.005);

    const a: LonLat = { lon: 8.3124, lat: 61.6363 };
    const b: LonLat = { lon: 10.7522, lat: 59.9139 };
    expect(haversine(a, a)).toBe(0);
    expect(haversine(a, b)).toBeCloseTo(haversine(b, a), 9);

    const coords: LonLat[] = [
      { lon: 8.0, lat: 61.0 },
      { lon: 8.01, lat: 61.0 },
      { lon: 8.02, lat: 61.0 },
    ];
    const cum = cumulativeDistances(coords);
    expect(cum[0]).toBe(0);
    expect(cum[1]).toBeGreaterThan(0);
    expect(cum[2]).toBeCloseTo(2 * cum[1], 6);
    expect(pathLength(coords)).toBeCloseTo(cum[2], 9);
  });
});

describe('the supported longitude window is the projection window', () => {
  it('projects every longitude in the supported range without throwing, both edges included', () => {
    // `checkSupported` in src/lib/route.ts takes its longitude edges from these
    // constants, and `toUtm33` refuses with the same comparison. This sweep is
    // what makes that one statement rather than two that can drift: before the
    // edges were shared, Kirkenes (30.05°E) passed the check and then threw a
    // central-meridian error inside the DEM worker.
    expect(UTM33_MIN_LON).toBe(ZONE33_CENTRAL_MERIDIAN_DEG - MAX_LONGITUDE_OFFSET_DEG);
    expect(UTM33_MAX_LON).toBe(ZONE33_CENTRAL_MERIDIAN_DEG + MAX_LONGITUDE_OFFSET_DEG);

    for (let lon = UTM33_MIN_LON; lon <= UTM33_MAX_LON + 1e-9; lon += 0.5) {
      for (let lat = 57; lat <= 72.5 + 1e-9; lat += 1) {
        const point = { lon: Math.min(lon, UTM33_MAX_LON), lat };
        expect(isInUtm33Window(point), `window ${lon},${lat}`).toBe(true);
        expect(() => toUtm33(point), `project ${lon},${lat}`).not.toThrow();
      }
    }

    // The edges themselves, exactly.
    expect(() => toUtm33({ lon: UTM33_MIN_LON, lat: 69.7 })).not.toThrow();
    expect(() => toUtm33({ lon: UTM33_MAX_LON, lat: 69.7 })).not.toThrow();
    expect(UTM33_MIN_LON).toBe(3);
    expect(UTM33_MAX_LON).toBe(27);

    // Just outside: inside Norway, outside the model. A clean `false`, not junk.
    expect(isInUtm33Window({ lon: 30.05, lat: 69.7 })).toBe(false);
    expect(() => toUtm33({ lon: 30.05, lat: 69.7 })).toThrow(/central meridian/);
    expect(isInUtm33Window({ lon: 2.9, lat: 58.6 })).toBe(false);
    expect(isInUtm33Window({ lon: Number.NaN, lat: 60 })).toBe(false);
  });
});

describe('resample (part of the projection/distance story)', () => {
  it('honours the requested spacing on a straight line and preserves length on a curved route', () => {
    const coords: LonLat[] = [
      { lon: 8.0, lat: 61.0 },
      { lon: 8.2, lat: 61.0 },
    ];
    const originalLength = pathLength(coords);
    const resampled = resample(coords, 250);
    expect(resampled[0]).toEqual(coords[0]);
    const cum = cumulativeDistances(resampled);
    for (let i = 1; i < cum.length - 1; i++) {
      expect(cum[i] - cum[i - 1]).toBeCloseTo(250, 3); // within 1 mm
    }
    expect(cum[cum.length - 1]).toBeCloseTo(originalLength, 1); // within 5 cm over 10 km

    // A smooth arc, sampled coarsely, typical of a GPX track.
    const arc: LonLat[] = [];
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      arc.push({ lon: 8 + t * 0.4, lat: 61 + Math.sin(t * Math.PI) * 0.15 });
    }
    const arcLength = pathLength(arc);
    const smoothed = resample(arc, 100);
    const smoothedLength = pathLength(smoothed);
    expect(smoothedLength).toBeGreaterThan(arcLength * 0.99);
    expect(smoothedLength).toBeLessThan(arcLength * 1.01);
    expect(smoothed.length).toBe(Math.ceil(arcLength / 100) + 1);
    // Individual intervals that straddle a GPX vertex are slightly shorter:
    // the resampled points lie on the path, but the chord cuts the corner.
    const meanSpacing = smoothedLength / (smoothed.length - 1);
    expect(meanSpacing).toBeGreaterThan(99);
    expect(meanSpacing).toBeLessThan(101);
  });

  it('includes the exact end point even off the spacing grid, and handles degenerate input', () => {
    const last = resample(
      [
        { lon: 8.0, lat: 61.0 },
        { lon: 8.1, lat: 61.0 },
      ],
      333,
    ).pop()!;
    expect(last.lon).toBeCloseTo(8.1, 12);
    expect(last.lat).toBeCloseTo(61.0, 12);

    expect(resample([], 100)).toEqual([]);
    expect(resample([{ lon: 8, lat: 61 }], 100)).toEqual([{ lon: 8, lat: 61 }]);
    expect(
      resample(
        [
          { lon: 8, lat: 61 },
          { lon: 8, lat: 61 },
        ],
        100,
      ),
    ).toEqual([{ lon: 8, lat: 61 }]);
    expect(() =>
      resample(
        [
          { lon: 8, lat: 61 },
          { lon: 8.1, lat: 61 },
        ],
        0,
      ),
    ).toThrow(RangeError);
  });
});
