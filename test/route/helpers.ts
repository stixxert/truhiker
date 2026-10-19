/**
 * Shared fixtures for the route-editing tests.
 *
 * Everything here is synthetic and offline: no DEM, no WFS, no GPX parsing.
 * Geometry is placed around 61.5°N / 8.3°E (Jotunheimen) because metre/degree
 * conversions there are the ones the rest of the project uses.
 */

import type { RoutePoint, Trip, UserProfile } from '../../src/contracts';
import { METRES_PER_DEG_LAT, SnapIndex, type TurruteAttributes, type TurruteLine } from '../../src/snap';
import { tripFromPoints } from '../../src/route';

export const PROFILE: UserProfile = {
  massKg: 78,
  heightCm: 181,
  ageYears: 41,
  sex: 'male',
  packBaseKg: 9,
  dailyKm: 20,
  dailyHours: 8,
  support: 'mail-drops',
};

const ATTRIBUTES: TurruteAttributes = {
  lokalId: 'test',
  rutenavn: 'Ukjent',
  rutenummer: 'jot15',
  vedlikeholdsansvarlig: 'DNT',
  gradering: '',
  merking: 'JA',
  ruteFolger: 'ST',
  underlagstype: '',
  sesong: '',
  oppdateringsdato: '2026-09-02T11:00:35',
};

/** A monotonic clock, so `updatedAt` assertions are deterministic. */
export function fixedClock(startIso = '2024-06-01T00:00:00.000Z', stepMs = 1000): () => Date {
  let t = Date.parse(startIso);
  return () => {
    const date = new Date(t);
    t += stepMs;
    return date;
  };
}

/** Recursively `Object.freeze`. Assigning through a frozen object throws. */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** `metres` of latitude, as degrees (spherical mean radius). */
export function metresToLat(metres: number): number {
  return metres / METRES_PER_DEG_LAT;
}

/** `metres` of longitude at a latitude, as degrees. */
export function metresToLon(metres: number, atLat: number): number {
  return metres / (METRES_PER_DEG_LAT * Math.cos((atLat * Math.PI) / 180));
}

export function line(id: string, coords: TurruteLine['coords']): TurruteLine {
  return {
    id,
    lokalId: id,
    attributes: { ...ATTRIBUTES, lokalId: id },
    coords,
    srsName: 'urn:ogc:def:crs:EPSG::4258',
  };
}

/** A SnapIndex with a 0.001° grid (≈111 m), fine enough for synthetic trails. */
export function snapIndexOf(...lines: TurruteLine[]): SnapIndex {
  const index = new SnapIndex({ gridCellDeg: 0.001 });
  index.addLines(lines);
  return index;
}

/** Straight line of `count` points from lon `fromLon` to `toLon` at `lat`. */
export function straightPoints(
  fromLon: number,
  toLon: number,
  lat: number,
  count: number,
  elevation?: (index: number) => number | undefined,
): RoutePoint[] {
  const points: RoutePoint[] = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / (count - 1);
    const ele = elevation ? elevation(i) : undefined;
    const point: RoutePoint = { lon: fromLon + (toLon - fromLon) * t, lat };
    if (ele !== undefined) {
      (point as { ele?: number; eleSource?: 'gpx' | 'dem' | 'none' }).ele = ele;
      (point as { eleSource?: 'gpx' | 'dem' | 'none' }).eleSource = 'gpx';
    }
    points.push(point);
  }
  return points;
}

export interface TestTripOptions {
  name?: string;
  legId?: string;
  tripId?: string;
  provenance?: Trip['legs'][number]['provenance'];
  now?: () => Date;
}

/** A one-leg trip built through the public constructor. */
export function makeTrip(points: readonly RoutePoint[], options: TestTripOptions = {}): Trip {
  return tripFromPoints(points, options.name ?? 'Jotunheimen', PROFILE, {
    id: options.tripId ?? 'trip-1',
    legId: options.legId ?? 'leg-1',
    provenance: options.provenance,
    now: options.now ?? fixedClock(),
  });
}
