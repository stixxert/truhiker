import { describe, expect, it } from 'vitest';

import { haversine, type LonLat } from '../../src/core/geo';
import {
  DEFAULT_SNAP_RADIUS_M,
  DEFAULT_STICKY_RADIUS_M,
  METRES_PER_DEG_LAT,
  SnapIndex,
  SnapTracker,
  localDistanceM,
  type TurruteAttributes,
  type TurruteLine,
} from '../../src/snap/index';
import { trailLinesToGeoJson } from '../../src/snap/overlay';

const ATTRIBUTES: TurruteAttributes = {
  lokalId: 'test',
  rutenavn: 'Ukjent',
  rutenummer: 'jot15',
  vedlikeholdsansvarlig: 'DNT | DNT Oslo og omegn',
  gradering: '',
  merking: 'JA',
  ruteFolger: 'ST',
  underlagstype: '',
  sesong: '',
  oppdateringsdato: '2026-09-02T11:00:35',
};

function line(id: string, coords: LonLat[], attributes: Partial<TurruteAttributes> = {}): TurruteLine {
  return {
    id,
    lokalId: attributes.lokalId ?? id,
    attributes: { ...ATTRIBUTES, lokalId: attributes.lokalId ?? id, ...attributes },
    coords,
    srsName: 'urn:ogc:def:crs:EPSG::4258',
  };
}

/** Point `metres` north of a coordinate (short distances only). */
function northOf(point: LonLat, metres: number): LonLat {
  return { lon: point.lon, lat: point.lat + metres / METRES_PER_DEG_LAT };
}

const EAST_WEST: TurruteLine = line('east-west', [
  { lon: 8.0, lat: 61.5 },
  { lon: 8.01, lat: 61.5 },
]);

describe('SnapIndex.snap', () => {
  it('snaps a point 30 m away to the nearest segment with full detail, and returns null out of range or when empty', () => {
    // The local metric plane agrees with haversine at 61.5°N within 1 %.
    const a: LonLat = { lon: 8.0, lat: 61.5 };
    const b: LonLat = { lon: 8.01, lat: 61.51 };
    const ratio = localDistanceM(a, b) / haversine(a, b);
    expect(ratio).toBeGreaterThan(0.99);
    expect(ratio).toBeLessThan(1.01);
    expect(localDistanceM(a, a)).toBe(0);
    expect(localDistanceM(a, { lon: 8.4, lat: 61.5 })).toBeCloseTo(
      localDistanceM({ lon: 8.4, lat: 61.5 }, a),
      9,
    );

    const index = new SnapIndex();
    index.addLines([EAST_WEST]);
    const result = index.snap(northOf({ lon: 8.005, lat: 61.5 }, 30), {
      radiusM: DEFAULT_SNAP_RADIUS_M,
    });
    expect(result).not.toBeNull();
    expect(result?.lineId).toBe('east-west');
    expect(result?.distanceM).toBeCloseTo(30, 6);
    expect(result?.snappedPoint.lon).toBeCloseTo(8.005, 9);
    expect(result?.snappedPoint.lat).toBeCloseTo(61.5, 9);
    expect(result?.t).toBeCloseTo(0.5, 6);
    expect(result?.bearing).toBeCloseTo(90, 6); // heading east
    expect(result?.segmentIndex).toBe(0);
    expect(result?.attributes.rutenummer).toBe('jot15');

    expect(index.snap(northOf({ lon: 8.005, lat: 61.5 }, 200))).toBeNull();
    expect(new SnapIndex().snap({ lon: 8.0, lat: 61.5 })).toBeNull();
  });

  it('ignores lines with fewer than two usable coordinates and deduplicates by id', () => {
    const index = new SnapIndex();
    index.addLines([
      line('single', [{ lon: 8.0, lat: 61.5 }]),
      line('with-nan', [
        { lon: 8.0, lat: 61.5 },
        { lon: Number.NaN, lat: 61.5 },
      ]),
    ]);
    expect(index.lineCount).toBe(0);
    expect(index.segmentCount).toBe(0);
    expect(index.snap({ lon: 8.0, lat: 61.5 })).toBeNull();

    // Overlapping prefetch cells add the same line twice; it must count once.
    const deduped = new SnapIndex();
    expect(deduped.addLines([EAST_WEST])).toBe(1);
    expect(deduped.addLines([EAST_WEST])).toBe(0);
    expect(deduped.lineCount).toBe(1);
    expect(deduped.segmentCount).toBe(1);
    expect(deduped.hasLine('east-west')).toBe(true);

    // What the map draws is exactly what the index holds (the overlay layer and
    // the pointer use one dataset, so the picture cannot promise a path that
    // snapping will not take).
    const drawn = trailLinesToGeoJson([
      EAST_WEST,
      line('no-name', [{ lon: 8, lat: 61.5 }, { lon: 8.001, lat: 61.501 }]),
      line('marked', [{ lon: 8, lat: 61.6 }, { lon: 8.001, lat: 61.601 }], { merking: 'NEI' }),
      line('one-point', [{ lon: 8, lat: 61.7 }]),
    ]);
    expect(drawn.features).toHaveLength(3);
    // The index has coords to draw; placeholder names are not names (D7).
    expect(drawn.features[0].properties.id).toBe('east-west');
    expect(drawn.features[0].properties.name).toBeNull();
    expect(drawn.features[0].properties.marked).toBe(true);
    expect(drawn.features[1].properties.name).toBeNull();
    expect(drawn.features[2].properties.marked).toBe(false);
    expect(drawn.features[0].geometry.coordinates).toEqual(
      EAST_WEST.coords.map((point) => [point.lon, point.lat]),
    );
  });

  it('respects a configurable radius, validates its options and finds segments in neighbouring grid cells', () => {
    const index = new SnapIndex();
    index.addLines([EAST_WEST]);
    const point = northOf({ lon: 8.005, lat: 61.5 }, 30);
    expect(index.snap(point, { radiusM: 20 })).toBeNull();
    expect(index.snap(point, { radiusM: 20, stickyRadiusM: 20 })).toBeNull();
    expect(() => index.snap(point, { radiusM: 0 })).toThrow(RangeError);
    expect(() => index.snap(point, { radiusM: 100, stickyRadiusM: 50 })).toThrow(/hysteresis/);
    // The dock offers 20–300 m, so anything above the fixed 120 m default used to
    // throw instead of snapping. Hysteresis is now derived from the radius (1.5 ×,
    // per D5), which keeps the wide settings usable.
    for (const radius of [125, 200, 300]) {
      expect(index.snap(northOf({ lon: 8.005, lat: 61.5 }, radius * 0.5), { radiusM: radius })?.lineId).toBe(
        EAST_WEST.id,
      );
    }
    expect(() => index.snap({ lon: Number.NaN, lat: 61.5 })).toThrow(RangeError);
    expect(() => new SnapIndex({ gridCellDeg: 0 })).toThrow(RangeError);
    expect(() => new SnapIndex({ gridCellDeg: 2 })).toThrow(RangeError);

    // A segment that crosses a cell boundary must still be found from the
    // other side of that boundary.
    const crossing = new SnapIndex({ gridCellDeg: 0.02 });
    crossing.addLines([
      line('crossing', [
        { lon: 8.019, lat: 61.5 },
        { lon: 8.021, lat: 61.5 },
      ]),
    ]);
    expect(crossing.cellCount).toBeGreaterThanOrEqual(2);
    expect(crossing.snap({ lon: 8.02, lat: 61.5001 }, { radiusM: 75 })?.lineId).toBe('crossing');
  });
});

describe('hysteresis', () => {
  // Two parallel east–west trails 167 m apart (~0.0015° latitude).
  const SOUTH = line('south', [
    { lon: 8.0, lat: 61.5 },
    { lon: 8.01, lat: 61.5 },
  ]);
  const NORTH = line('north', [
    { lon: 8.0, lat: 61.5015 },
    { lon: 8.01, lat: 61.5015 },
  ]);

  function index(): SnapIndex {
    const idx = new SnapIndex();
    idx.addLines([SOUTH, NORTH]);
    return idx;
  }

  it('picks the nearest line without a current one, keeps a sticky line inside the band and releases it outside', () => {
    // No current line: NORTH wins.
    const nearest = index().snap(northOf({ lon: 8.005, lat: 61.5 }, 100));
    expect(nearest?.lineId).toBe('north');
    expect(nearest?.distanceM).toBeCloseTo(66.8, 1);

    const sticky = index().snap(northOf({ lon: 8.005, lat: 61.5 }, 100), {
      currentLineId: 'south',
      radiusM: DEFAULT_SNAP_RADIUS_M, // 75
      stickyRadiusM: DEFAULT_STICKY_RADIUS_M, // 120
    });
    expect(sticky?.lineId).toBe('south');
    expect(sticky?.distanceM).toBeCloseTo(100, 6);

    // 130 m from SOUTH: past the sticky radius, so NORTH (36.8 m away) wins.
    const released = index().snap(northOf({ lon: 8.005, lat: 61.5 }, 130), {
      currentLineId: 'south',
      radiusM: 75,
      stickyRadiusM: 120,
    });
    expect(released?.lineId).toBe('north');
    expect(released?.distanceM).toBeCloseTo(36.8, 1);

    const probe = (metres: number): string | null =>
      index().snap(northOf({ lon: 8.005, lat: 61.5 }, metres), {
        currentLineId: 'south',
        radiusM: 75,
        stickyRadiusM: 120,
      })?.lineId ?? null;
    expect(probe(119)).toBe('south');
    // 125 m from SOUTH is outside the sticky band; NORTH (41.8 m) wins.
    expect(probe(125)).toBe('north');
  });
});

describe('SnapTracker', () => {
  it('remembers the current line, switches when it is released, resets, and clears when nothing is in range', () => {
    const idx = new SnapIndex();
    idx.addLines([
      line('south', [
        { lon: 8.0, lat: 61.5 },
        { lon: 8.01, lat: 61.5 },
      ]),
      line('north', [
        { lon: 8.0, lat: 61.5015 },
        { lon: 8.01, lat: 61.5015 },
      ]),
    ]);
    const tracker = new SnapTracker(idx);

    expect(tracker.snap(northOf({ lon: 8.005, lat: 61.5 }, 10))?.lineId).toBe('south');
    expect(tracker.lineId).toBe('south');
    // 100 m north: still sticky to SOUTH although NORTH is closer.
    expect(tracker.snap(northOf({ lon: 8.005, lat: 61.5 }, 100))?.lineId).toBe('south');
    expect(tracker.lineId).toBe('south');
    // 130 m north: outside the sticky band, switch to NORTH.
    expect(tracker.snap(northOf({ lon: 8.005, lat: 61.5 }, 130))?.lineId).toBe('north');
    expect(tracker.lineId).toBe('north');

    tracker.reset();
    expect(tracker.lineId).toBeNull();

    const single = new SnapIndex();
    single.addLines([EAST_WEST]);
    const one = new SnapTracker(single);
    expect(one.snap(northOf({ lon: 8.005, lat: 61.5 }, 30))?.lineId).toBe('east-west');
    expect(one.snap(northOf({ lon: 8.005, lat: 61.5 }, 500))).toBeNull();
    expect(one.lineId).toBeNull();
  });
});
