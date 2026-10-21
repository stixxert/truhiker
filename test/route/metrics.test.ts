import { describe, expect, it } from 'vitest';

import type { Leg, RoutePoint, Trip } from '../../src/contracts';
import {
  PLACEHOLDER_POINT,
  RouteEditError,
  createEditor,
  emptyLeg,
  recomputeLeg,
  tripDistanceM,
  tripFromPoints,
} from '../../src/route';
import { PROFILE, deepFreeze, fixedClock, makeTrip, metresToLat, straightPoints } from './helpers';

function legOf(points: readonly RoutePoint[]): Leg {
  return { id: 'leg-x', points, provenance: [], distanceM: null, ascentM: null, descentM: null };
}

describe('tripFromPoints', () => {
  it('builds a schemaVersion-1 trip with one leg and computed metrics, honouring caller provenance', () => {
    const points = straightPoints(8.3, 8.34, 61.5, 5, (i) => 1000 + i * 25);
    const trip = tripFromPoints(points, 'Jotunheimen', PROFILE, {
      now: fixedClock('2024-06-01T10:00:00.000Z'),
    });

    expect(trip.schemaVersion).toBe(1);
    expect(trip.createdAt).toBe('2024-06-01T10:00:00.000Z');
    expect(trip.updatedAt).toBe(trip.createdAt);
    expect(trip.id).toMatch(/^trip-/);
    expect(trip.legs).toHaveLength(1);
    expect(trip.legs[0].id).toMatch(/^leg-/);
    expect(trip.legs[0].name).toBe('Jotunheimen');
    expect(trip.legs[0].provenance).toEqual([{ kind: 'drawn' }]);
    expect(trip.legs[0].distanceM).toBeGreaterThan(2000);
    expect(trip.legs[0].ascentM).toBe(100);
    expect(trip.legs[0].descentM).toBe(0);
    expect(trip.profile).toBe(PROFILE);

    // Imports must not be mislabelled as drawn.
    const imported = tripFromPoints(straightPoints(8.3, 8.31, 61.5, 2), 'GPX', PROFILE, {
      provenance: [{ kind: 'gpx-upload', label: 'a.gpx' }],
      now: fixedClock(),
    });
    expect(imported.legs[0].provenance).toEqual([{ kind: 'gpx-upload', label: 'a.gpx' }]);
  });

  it('refuses fewer than two points and non-finite coordinates', () => {
    expect(() => tripFromPoints([{ lon: 8.3, lat: 61.5 }], 'X', PROFILE)).toThrow(RouteEditError);
    expect(() => tripFromPoints([], 'X', PROFILE)).toThrow(/at least two points/);
    expect(() =>
      tripFromPoints(
        [
          { lon: 8.3, lat: 61.5 },
          { lon: Number.NaN, lat: 61.5 },
        ],
        'X',
        PROFILE,
      ),
    ).toThrow(/finite/);
  });
});

describe('emptyLeg', () => {
  it('is a two-point placeholder at null island, keeping the leg invariant', () => {
    const leg = emptyLeg();
    expect(leg.points).toHaveLength(2);
    expect(leg.points[0]).toEqual(PLACEHOLDER_POINT);
    expect(leg.points[1]).toEqual(PLACEHOLDER_POINT);
    // Not near Norway: an un-drawn leg must never look like a real coordinate.
    expect(PLACEHOLDER_POINT.lon).toBe(0);
    expect(PLACEHOLDER_POINT.lat).toBe(0);
    expect(leg.distanceM).toBe(0);
    expect(leg.ascentM).toBeNull();
    expect(leg.descentM).toBeNull();
    expect(leg.provenance).toEqual([]);
    expect(leg.id).toMatch(/^leg-/);
    expect(leg.name).toBeUndefined();
    expect(emptyLeg('Dag 2').name).toBe('Dag 2');
    expect(emptyLeg().id).not.toBe(leg.id);
  });

  it('can be replaced wholesale by a drawn route, and recomputeLeg does not mutate its input', () => {
    const placeholder = emptyLeg('Dag 1');
    const trip: Trip = {
      schemaVersion: 1,
      id: 'trip-1',
      name: 'Ny tur',
      createdAt: '2024-06-01T00:00:00.000Z',
      updatedAt: '2024-06-01T00:00:00.000Z',
      legs: [placeholder],
      profile: PROFILE,
    };
    const editor = createEditor(trip, { now: fixedClock() });
    const drawn = straightPoints(8.3, 8.34, 61.5, 3, (i) => 1200 + i * 10);
    const next = editor.apply({
      type: 'replace-span',
      legId: placeholder.id,
      from: 0,
      to: 1,
      points: drawn,
      snapped: true,
    });
    expect(next.legs[0].id).toBe(placeholder.id);
    // `snapped: true` marks **every** vertex the command placed, not just the leg:
    // a leg-level marker alone claimed a whole leg was on a trail when one corner
    // was. The drawn geometry is otherwise untouched, and elevation is preserved.
    expect(next.legs[0].points).toEqual(drawn.map((point) => ({ ...point, snapped: true })));
    expect(next.legs[0].distanceM as number).toBeGreaterThan(0);

    const leg = deepFreeze(makeTrip(straightPoints(8.3, 8.34, 61.5, 5, (i) => 1000 + i * 20)).legs[0]);
    const again = recomputeLeg(leg);
    expect(again).not.toBe(leg);
    expect(again).toEqual(leg);
  });
});

describe('recomputeLeg', () => {
  it('measures distance with haversine and counts climb through the hysteresis machine', () => {
    const distance = recomputeLeg(
      legOf([
        { lon: 8.3, lat: 61.5 },
        { lon: 8.3, lat: 61.5 + metresToLat(1000) },
      ]),
    );
    expect(distance.distanceM).toBeCloseTo(1000, 0);

    // Sparse human vertices: 100 → 120 → 100 is 20 m up and 20 m down.
    const climb = recomputeLeg(
      legOf([
        { lon: 8.3, lat: 61.5, ele: 100 },
        { lon: 8.31, lat: 61.5, ele: 120 },
        { lon: 8.32, lat: 61.5, ele: 100 },
      ]),
    );
    expect(climb.ascentM).toBe(20);
    expect(climb.descentM).toBe(20);

    // A real 0 m elevation, and stale stored metrics are recomputed, not trusted.
    const seaLevel = recomputeLeg(
      legOf([
        { lon: 8.3, lat: 61.5, ele: 0 },
        { lon: 8.31, lat: 61.5, ele: 40 },
      ]),
    );
    expect(seaLevel.ascentM).toBe(40);
    const lying: Leg = { ...seaLevel, distanceM: 1, ascentM: 2, descentM: 3 };
    expect(recomputeLeg(lying)).toMatchObject({ distanceM: seaLevel.distanceM, ascentM: 40 });
  });

  it('returns null ascent/descent when any elevation is missing — never 0 — and tripDistanceM sums or refuses', () => {
    const missing = [
      [
        { lon: 8.3, lat: 61.5, ele: 100 },
        { lon: 8.31, lat: 61.5 },
        { lon: 8.32, lat: 61.5, ele: 140 },
      ],
      [
        { lon: 8.3, lat: 61.5, ele: 100 },
        { lon: 8.31, lat: 61.5, eleSource: 'none' as const },
      ],
      [
        { lon: 8.3, lat: 61.5, ele: 100 },
        { lon: 8.31, lat: 61.5, ele: Number.NaN },
      ],
    ];
    for (const points of missing) {
      const leg = recomputeLeg(legOf(points));
      expect(leg.ascentM).toBeNull();
      expect(leg.descentM).toBeNull();
    }
    expect(recomputeLeg(legOf([])).distanceM).toBeNull();

    const a = makeTrip(straightPoints(8.3, 8.31, 61.5, 2));
    const legA = a.legs[0];
    const legB = recomputeLeg({ ...legA, id: 'leg-2', points: straightPoints(8.31, 8.33, 61.5, 2) });
    const trip: Trip = { ...a, legs: [legA, legB] };
    expect(tripDistanceM({ ...trip, legs: [legA] })).toBeCloseTo(legA.distanceM as number, 6);
    expect(tripDistanceM(trip)).toBeCloseTo((legA.distanceM as number) + (legB.distanceM as number), 6);
    expect(tripDistanceM({ ...trip, legs: [] })).toBeNull();
    expect(tripDistanceM({ ...trip, legs: [{ ...legA, distanceM: null }] })).toBeNull();
  });
});
