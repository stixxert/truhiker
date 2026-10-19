/**
 * Acceptance: a 3,000 km walk — ~100 000 points, several megabytes — survives a
 * save and a reload.
 *
 * This is the trip localStorage could not hold. The old store refused anything
 * over 1.5 MB, and a 3,000 km trace with elevation and provenance is 5–10 MB.
 * The assertions that matter are therefore:
 *
 *  - the trip really is that big (`byteSize > 1_500_000`, the old ceiling);
 *  - the geometry, the elevation source and the provenance come back
 *    **deep-equal**, not simplified, not rounded;
 *  - listing it does not require reading the body.
 *
 * No wall-clock assertion: the timings are logged for `docs/12-storage.md` only,
 * because a time budget in a test is a flake with a delay (docs/11 §2.3).
 */
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import { pathLength } from '../../src/core/geo';
import type { RoutePoint, Trip } from '../../src/contracts';
import { MAX_TRIP_BYTES, byteSize, createTripStorage, defaultProfile, emptyTrip } from '../../src/store';
import { memoryStorage } from '../../src/store';

const POINTS = 100_000;
const LEGS = 2;
const TARGET_M = 3_000_000; // 3,000 km

/**
 * A 3,000 km northbound walk in two legs, one point every ~30 m, with
 * elevations from a DEM sample so the `ele`/`eleSource` round-trip is real.
 */
function longWalk(): { trip: Trip; points: RoutePoint[] } {
  const perLeg = POINTS / LEGS;
  const points: RoutePoint[] = [];
  const total = POINTS;
  for (let index = 0; index < total; index += 1) {
    const t = index / (total - 1);
    // 3,000 km of latitude at ~111.32 km per degree, with a gentle wander.
    const lat = 58.4 + t * (TARGET_M / 111_320);
    const lon = 8.0 + Math.sin(t * Math.PI * 3) * 0.35;
    const ele = Number((350 + 900 * Math.sin(t * Math.PI * 2.5) + 120 * Math.cos(t * 41)).toFixed(1));
    points.push({ lon, lat, ele, eleSource: 'dem' });
  }

  const base = emptyTrip('Fjellruta på langs', defaultProfile());
  const legs = Array.from({ length: LEGS }, (_, legIndex) => {
    const slice = points.slice(legIndex * perLeg, (legIndex + 1) * perLeg);
    return {
      id: `leg-${legIndex + 1}`,
      name: `Etappe ${legIndex + 1}`,
      points: slice,
      provenance: [
        {
          kind: legIndex === 0 ? ('turrutebasen' as const) : ('gpx-upload' as const),
          label: `etappe ${legIndex + 1}`,
          url: 'https://ut.no/rute',
          licence: 'CC BY 4.0 ©Kartverket',
          fetchedAt: '2026-10-19T10:00:00.000Z',
          modified: false,
        },
      ],
      distanceM: pathLength(slice),
      ascentM: 12_345.6,
      descentM: 11_222.2,
    };
  });

  return {
    trip: {
      ...base,
      id: 'long-walk',
      name: 'Fjellruta på langs',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-10-19T10:00:00.000Z',
      legs,
      notes: 'Vanndepot ved hver hytte.',
    },
    points,
  };
}

describe('acceptance: a 3,000 km trip on IndexedDB', () => {
  it('saves and reloads ~100 000 points deep-equal, at a size the old 1.5 MB cap refused', async () => {
    const { trip, points } = longWalk();
    expect(points).toHaveLength(POINTS);

    // The claim in the task: a 3,000 km walk. Within 1 % of it.
    const distance = trip.legs.reduce((sum, leg) => sum + (leg.distanceM ?? 0), 0);
    expect(distance).toBeGreaterThan(TARGET_M * 0.99);
    expect(distance).toBeLessThan(TARGET_M * 1.01);

    const bytes = byteSize(JSON.stringify(trip));
    expect(bytes).toBeGreaterThan(1_500_000);
    expect(bytes).toBeGreaterThan(MAX_TRIP_BYTES);

    const store = await createTripStorage({
      factory: new IDBFactory(),
      storage: memoryStorage(),
      // A browser-like quota, so this is the real IndexedDB path.
      estimate: async () => ({ usage: bytes, quota: 8_000_000_000 }),
    });
    expect(store.backend).toBe('indexeddb');

    const saveStart = performance.now();
    await store.save(trip);
    const saveMs = performance.now() - saveStart;

    const loadStart = performance.now();
    const loaded = await store.load(trip.id);
    const loadMs = performance.now() - loadStart;

    // Timings, not assertions: they are quoted in docs/12-storage.md.
    console.log(
      `large trip: ${(bytes / 1_000_000).toFixed(2)} MB, ${POINTS} points — ` +
        `save ${saveMs.toFixed(0)} ms, load ${loadMs.toFixed(0)} ms`,
    );

    expect(loaded).not.toBeNull();
    expect(loaded!.legs).toStrictEqual(trip.legs);
    expect(loaded!.profile).toStrictEqual(trip.profile);
    expect(loaded!.notes).toBe(trip.notes);
    expect(loaded!.updatedAt).toBe(trip.updatedAt);
    // Provenance and the elevation source are part of the payload, unrounded.
    expect(loaded!.legs[0]!.provenance[0]!.licence).toBe('CC BY 4.0 ©Kartverket');
    expect(loaded!.legs[1]!.points[0]!.eleSource).toBe('dem');
    expect(loaded!.legs[1]!.points.at(-1)!.ele).toBe(points.at(-1)!.ele);

    // Listing it reads the summary only, and still states the size.
    const [summary] = await store.list();
    expect(summary!.id).toBe(trip.id);
    expect(summary!.legCount).toBe(LEGS);
    expect(summary!.byteSize).toBe(bytes);
    expect(summary!.distanceM).toBeCloseTo(distance, 3);

    await store.remove(trip.id);
    expect(await store.load(trip.id)).toBeNull();
  });
});
