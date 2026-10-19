import { describe, expect, it } from 'vitest';

import type { RoutePoint, Trip } from '../../src/contracts';
import { RouteEditError, rerouteSpan } from '../../src/route';
import type { RerouteOptions } from '../../src/route';
import type { SnapIndex } from '../../src/snap';
import { fixedClock, line, makeTrip, metresToLat, snapIndexOf, straightPoints } from './helpers';

const TRAIL_LAT = 61.5;
/** 30 m south of the trail: inside the default 75 m radius, nowhere near it exactly. */
const OFFSET_LAT = TRAIL_LAT - metresToLat(30);

/** A straight west→east trail at 61.5°N with a vertex every 0.01° (~530 m). */
function eastWestTrail(id: string, fromLon: number, toLon: number, step = 0.01): ReturnType<typeof line> {
  const coords = [];
  const count = Math.round((toLon - fromLon) / step);
  for (let i = 0; i <= count; i++) coords.push({ lon: fromLon + i * step, lat: TRAIL_LAT });
  return line(id, coords);
}

/** A route point offset south of the trail. */
function southOf(lon: number, metres = 30): RoutePoint {
  return { lon, lat: TRAIL_LAT - metresToLat(metres) };
}

function reroute(
  trip: Trip,
  from: number,
  to: number,
  opts: Partial<RerouteOptions> & { snapIndex: SnapIndex },
): Trip {
  return rerouteSpan(trip, 'leg-1', from, to, { now: fixedClock(), ...opts });
}

function labels(trip: Trip): string[] {
  return trip.legs[0].provenance.map((entry) => entry.label ?? entry.kind);
}

/** Every point lies on the trail: lat matches and lon is within range. */
function expectOnTrail(points: readonly RoutePoint[], minLon: number, maxLon: number): void {
  for (const point of points) {
    expect(point.lat).toBeCloseTo(TRAIL_LAT, 9);
    expect(point.lon).toBeGreaterThanOrEqual(minLon - 1e-9);
    expect(point.lon).toBeLessThanOrEqual(maxLon + 1e-9);
  }
}

describe('rerouteSpan — snapping onto one trail', () => {
  it('replaces a straight cut 30 m from the trail with vertices on the trail, in the direction of travel', () => {
    const index = snapIndexOf(eastWestTrail('trail-a', 8.3, 8.34));

    // Forwards: 8.305 → 8.335.
    const start = makeTrip([southOf(8.305), southOf(8.335)]);
    const forward = reroute(start, 0, 1, { snapIndex: index });
    const points = forward.legs[0].points;
    expect(points.length).toBeGreaterThanOrEqual(2);
    expectOnTrail(points, 8.3, 8.34);
    expect(points[0].lon).toBeCloseTo(8.305, 6);
    expect(points[points.length - 1].lon).toBeCloseTo(8.335, 6);
    for (let i = 1; i < points.length; i++) expect(points[i].lon).toBeGreaterThan(points[i - 1].lon);
    expect(forward.legs[0].distanceM as number).toBeGreaterThan(1500);
    expect(labels(forward)).toContain('snapped');
    expect(Date.parse(forward.updatedAt)).toBeGreaterThan(Date.parse(start.updatedAt));

    // Backwards: the trail is walked in the route's direction, not digitisation order.
    const backward = reroute(makeTrip([southOf(8.335), southOf(8.305)]), 0, 1, { snapIndex: index });
    const reversed = backward.legs[0].points;
    expect(reversed.length).toBeGreaterThanOrEqual(2);
    expect(reversed[0].lon).toBeCloseTo(8.335, 6);
    expect(reversed[reversed.length - 1].lon).toBeCloseTo(8.305, 6);
    for (let i = 1; i < reversed.length; i++) expect(reversed[i].lon).toBeLessThan(reversed[i - 1].lon);
  });

  it('keeps the elevation of snapped vertices and interpolates the inserted ones', () => {
    const trip = makeTrip([
      { lon: 8.305, lat: OFFSET_LAT, ele: 1000, eleSource: 'gpx' },
      { lon: 8.315, lat: OFFSET_LAT, ele: 1200, eleSource: 'gpx' },
      { lon: 8.325, lat: OFFSET_LAT, ele: 1400, eleSource: 'gpx' },
    ]);
    const points = reroute(trip, 0, 2, {
      snapIndex: snapIndexOf(eastWestTrail('trail-a', 8.3, 8.34)),
    }).legs[0].points;

    expect(points[0].ele).toBe(1000);
    expect(points[points.length - 1].ele).toBe(1400);
    for (let i = 1; i < points.length - 1; i++) {
      const ele = points[i].ele as number;
      expect(ele).toBeGreaterThan(1000);
      expect(ele).toBeLessThan(1400);
      expect(points[i].eleSource).toBe('gpx');
    }
    expectOnTrail(points, 8.3, 8.34);
  });

  it('leaves vertices outside the span untouched and does not touch other legs', () => {
    const points = [{ lon: 8.2, lat: 61.4 }, southOf(8.305), southOf(8.335), { lon: 8.5, lat: 61.4 }];
    const trip = makeTrip(points);
    const twoLegs: Trip = {
      ...trip,
      legs: [trip.legs[0], { ...trip.legs[0], id: 'leg-2', points: straightPoints(9.0, 9.02, 62.0, 3) }],
    };
    const out = reroute(twoLegs, 1, 2, { snapIndex: snapIndexOf(eastWestTrail('trail-a', 8.3, 8.34)) });

    expect(out.legs[0].points[0]).toEqual(points[0]);
    expect(out.legs[0].points[out.legs[0].points.length - 1]).toEqual(points[3]);
    expect(out.legs[0].points.length).toBeGreaterThanOrEqual(4);
    expect(out.legs[1]).toBe(twoLegs.legs[1]);
  });

  it('moves a lone snapped vertex without inventing a stretch, and records the off-trail gap', () => {
    const points = [
      { lon: 8.2, lat: OFFSET_LAT },
      { ...southOf(8.305), ele: 777, eleSource: 'dem' as const },
      { lon: 8.6, lat: OFFSET_LAT },
    ];
    const out = reroute(makeTrip(points), 0, 2, {
      snapIndex: snapIndexOf(eastWestTrail('trail-a', 8.3, 8.34)),
    });

    const routed = out.legs[0].points;
    expect(routed).toHaveLength(3);
    expect(routed[0]).toEqual(points[0]);
    expect(routed[2]).toEqual(points[2]);
    expect(routed[1].lon).toBeCloseTo(8.305, 6);
    expect(routed[1].lat).toBeCloseTo(TRAIL_LAT, 9);
    expect(routed[1].ele).toBe(777);
    expect(routed[1].eleSource).toBe('dem');
    expect(labels(out)).toContain('off-trail gap');
  });
});

describe('rerouteSpan — off-trail behaviour', () => {
  it('leaves the geometry unchanged and marks the span off-trail when nothing is in range', () => {
    const trip = makeTrip([southOf(8.305, 500), southOf(8.335, 500)]);
    const before = structuredClone(trip);
    const out = reroute(trip, 0, 1, { snapIndex: snapIndexOf(eastWestTrail('trail-a', 8.3, 8.34)) });

    expect(out.legs[0].points).toEqual(before.legs[0].points);
    expect(out.legs[0].distanceM).toBe(before.legs[0].distanceM);
    expect(labels(out)[labels(out).length - 1]).toBe('off-trail');
    expect(out.legs[0].provenance.some((entry) => entry.kind === 'snapped')).toBe(false);
    expect(out.updatedAt).not.toBe(trip.updatedAt);

    // A tighter radius means the same geometry is out of reach.
    const tight = reroute(makeTrip([southOf(8.305), southOf(8.335)]), 0, 1, {
      snapIndex: snapIndexOf(eastWestTrail('trail-a', 8.3, 8.34)),
      radiusM: 10,
    });
    expect(tight.legs[0].points).toEqual(makeTrip([southOf(8.305), southOf(8.335)]).legs[0].points);
    expect(labels(tight)).toContain('off-trail');
  });

  it('never bridges two disconnected trails', () => {
    // A span drawn across both trails: no vertex may be invented in the gap.
    const span = makeTrip([southOf(8.3005), southOf(8.3195), southOf(8.3405), southOf(8.3595)]);
    const index = snapIndexOf(
      eastWestTrail('trail-a', 8.3, 8.32),
      eastWestTrail('trail-b', 8.34, 8.36, 0.005),
    );
    const points = reroute(span, 0, 3, { snapIndex: index }).legs[0].points;
    expect(points.length).toBeGreaterThanOrEqual(4);
    for (const point of points) {
      const onA = point.lon <= 8.32 + 1e-9;
      const onB = point.lon >= 8.34 - 1e-9;
      expect(onA || onB).toBe(true);
      expect(point.lat).toBeCloseTo(TRAIL_LAT, 9);
    }
    expect(points.some((point) => point.lon > 8.32 + 1e-9 && point.lon < 8.34 - 1e-9)).toBe(false);

    // Far apart with a single vertex on each: each snaps to its own trail and
    // nothing is added between them.
    const far = reroute(makeTrip([southOf(8.3005), southOf(8.3605)]), 0, 1, {
      snapIndex: snapIndexOf(
        eastWestTrail('trail-a', 8.3, 8.32),
        eastWestTrail('trail-b', 8.36, 8.38, 0.005),
      ),
    }).legs[0].points;
    expect(far).toHaveLength(2);
    expect(far[0].lon).toBeCloseTo(8.3005, 6);
    expect(far[1].lon).toBeCloseTo(8.3605, 6);
  });
});

describe('rerouteSpan — contracts', () => {
  const index = snapIndexOf(eastWestTrail('trail-a', 8.3, 8.34));

  it('rejects bad input, never mutates, is idempotent and follows a single-segment trail', () => {
    const trip = makeTrip([southOf(8.305), southOf(8.335)]);

    const unknown = (() => {
      try {
        rerouteSpan(trip, 'nope', 0, 1, { snapIndex: index });
      } catch (error) {
        return error;
      }
      throw new Error('expected a throw');
    })();
    expect(unknown).toBeInstanceOf(RouteEditError);
    expect((unknown as RouteEditError).code).toBe('unknown-leg');

    const codeOf = (fn: () => unknown): unknown => {
      try {
        fn();
      } catch (error) {
        return error;
      }
      throw new Error('expected a throw');
    };
    for (const [from, to] of [
      [-1, 1],
      [0, 2],
      [1, 0],
      [0.5, 1],
    ]) {
      expect((codeOf(() => rerouteSpan(trip, 'leg-1', from, to, { snapIndex: index })) as RouteEditError).code).toBe(
        'index-out-of-range',
      );
    }
    expect(
      (
        codeOf(() =>
          rerouteSpan(trip, 'leg-1', 0, 1, { snapIndex: undefined as unknown as SnapIndex }),
        ) as RouteEditError
      ).code,
    ).toBe('invalid-command');
    expect(() => rerouteSpan(trip, 'leg-1', 0, 1, { snapIndex: index, radiusM: 0 })).toThrow(RangeError);

    // Immutability and idempotence.
    const before = structuredClone(trip);
    const once = reroute(trip, 0, 1, { snapIndex: index });
    expect(once).not.toBe(trip);
    expect(structuredClone(trip)).toEqual(before);
    const twice = reroute(once, 0, once.legs[0].points.length - 1, { snapIndex: index });
    expect(twice.legs[0].points).toHaveLength(once.legs[0].points.length);
    twice.legs[0].points.forEach((point, i) => {
      expect(point.lon).toBeCloseTo(once.legs[0].points[i]!.lon, 9);
      expect(point.lat).toBeCloseTo(once.legs[0].points[i]!.lat, 9);
    });
    expect(twice.legs[0].distanceM as number).toBeCloseTo(once.legs[0].distanceM as number, 3);

    // A trail whose two vertices straddle the span still yields two points.
    const single = snapIndexOf(
      line('single-segment', [
        { lon: 8.3, lat: TRAIL_LAT },
        { lon: 8.4, lat: TRAIL_LAT },
      ]),
    );
    const short = reroute(makeTrip([southOf(8.32), southOf(8.34)]), 0, 1, { snapIndex: single }).legs[0]
      .points;
    expect(short).toHaveLength(2);
    expect(short[0].lon).toBeCloseTo(8.32, 6);
    expect(short[1].lon).toBeCloseTo(8.34, 6);
    for (const point of short) expect(point.lat).toBeCloseTo(TRAIL_LAT, 9);
  });
});
