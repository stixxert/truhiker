/**
 * Trip/leg constructors.
 *
 * These are the "start of life" paths: a new drawn route, a GPX import that is
 * already a flat point list, a fresh leg template. Everything after that goes
 * through the editor in `./editor.ts`.
 */

import type { Leg, Provenance, RoutePoint, Trip, UserProfile } from '../contracts';
import { RouteEditError } from './errors';
import { newId } from './ids';
import { recomputeLeg } from './metrics';
import { assertRoutePoint } from './points';

/**
 * The coordinate of a placeholder leg: 0°N 0°E ("null island").
 *
 * Deliberately nowhere near Norway, so a placeholder that leaks into a map or a
 * resupply search is obvious junk rather than a plausible-looking point in the
 * Atlantic.
 */
export const PLACEHOLDER_POINT: RoutePoint = Object.freeze({
  lon: 0,
  lat: 0,
  eleSource: 'none' as const,
});

/**
 * An empty leg: a *placeholder* that satisfies the two-point invariant.
 *
 * A leg with no points cannot exist inside a trip ("a leg always has ≥2 points
 * or it does not exist"), so an "empty" leg is two identical points at
 * `PLACEHOLDER_POINT` — zero length, no elevation, no provenance yet. Drawing
 * replaces the whole thing rather than appending to it: the UI detects it with
 * "all points share one coordinate" and issues `replace-span` over the full
 * leg. That is why the placeholder keeps a valid shape while being obviously
 * not a route.
 *
 * `distanceM` is `0` (there are two points, and the distance between them is
 * genuinely zero) while `ascentM`/`descentM` are `null` (there is no elevation
 * to measure). Nothing here is invented.
 */
export function emptyLeg(name?: string): Leg {
  const leg = recomputeLeg({
    id: newId('leg'),
    points: [PLACEHOLDER_POINT, PLACEHOLDER_POINT],
    provenance: [],
    distanceM: null,
    ascentM: null,
    descentM: null,
  });
  return name === undefined ? leg : { ...leg, name };
}

export interface TripFromPointsOptions {
  /** Trip id. Default: a fresh one. */
  id?: string;
  /** Leg id. Default: a fresh one. */
  legId?: string;
  /** Leg name. Default: the trip name. */
  legName?: string;
  /**
   * Provenance for the single leg. Default `[{kind:'drawn'}]` — the trip is
   * built from points the caller collected. A GPX importer should pass
   * `[{kind:'gpx-upload', …}]` so the origin is not mislabelled.
   */
  provenance?: readonly Provenance[];
  /** Clock for `createdAt`/`updatedAt`. Default `() => new Date()`. */
  now?: () => Date;
}

/**
 * Build a valid one-leg trip from a point list.
 *
 * Throws `RouteEditError('leg-too-short')` for fewer than two points: there is
 * no such thing as a one-point route, and inventing the second point would be
 * worse than refusing. Throws `RouteEditError('invalid-point')` for bad
 * coordinates.
 */
export function tripFromPoints(
  points: readonly RoutePoint[],
  name: string,
  profile: UserProfile,
  options: TripFromPointsOptions = {},
): Trip {
  if (!Array.isArray(points) || points.length < 2) {
    throw new RouteEditError(
      'leg-too-short',
      `tripFromPoints: a leg needs at least two points, got ${Array.isArray(points) ? points.length : 0}`,
    );
  }
  const normalised = points.map((point, index) =>
    assertRoutePoint(point, `tripFromPoints: points[${index}]`),
  );

  const clock = options.now ?? (() => new Date());
  const timestamp = clock().toISOString();
  const legName = options.legName ?? name;
  const leg = recomputeLeg({
    id: options.legId ?? newId('leg'),
    name: legName.trim() === '' ? undefined : legName,
    points: normalised,
    provenance: options.provenance ?? [{ kind: 'drawn' }],
    distanceM: null,
    ascentM: null,
    descentM: null,
  });

  return {
    schemaVersion: 1,
    id: options.id ?? newId('trip'),
    name,
    createdAt: timestamp,
    updatedAt: timestamp,
    legs: [leg],
    profile,
  };
}
