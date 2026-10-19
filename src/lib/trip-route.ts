/**
 * Flattening a trip into the geometry the map, the profile and the editor use.
 *
 * A `Trip` is a list of legs; every other view of the route is a single
 * polyline. This module is the one place that conversion happens, so the map
 * overlay, the vertex handles and the elevation pipeline cannot disagree about
 * which point index belongs to which leg.
 *
 * Indices here are global indices into the flattened point array. Each span
 * records its own `startIndex`/`endIndex` (inclusive) so a global index can be
 * mapped back to `{ legId, index }` without scanning.
 */

import { cumulativeDistances } from '../core/geo';
import type { Leg, RoutePoint, Trip } from '../contracts';

export interface TripLegSpan {
  readonly legId: string;
  readonly name?: string;
  /** First global index (inclusive). */
  readonly startIndex: number;
  /** Last global index (inclusive). */
  readonly endIndex: number;
  readonly pointCount: number;
  /** Metres, as recorded on the leg; `null` when the geometry is too short. */
  readonly distanceM: number | null;
}

export interface FlatTrip {
  readonly points: readonly RoutePoint[];
  /** Cumulative distance at each point, metres. */
  readonly distances: readonly number[];
  readonly distanceM: number;
  readonly spans: readonly TripLegSpan[];
}

/** Flatten every leg into one polyline, keeping leg spans for the UI. */
export function flattenTrip(trip: Trip | null): FlatTrip {
  const points: RoutePoint[] = [];
  const spans: TripLegSpan[] = [];
  if (trip) {
    for (const leg of trip.legs) {
      if (leg.points.length === 0) continue;
      const startIndex = points.length;
      for (const point of leg.points) points.push(point);
      spans.push({
        legId: leg.id,
        name: leg.name,
        startIndex,
        endIndex: points.length - 1,
        pointCount: leg.points.length,
        distanceM: leg.distanceM,
      });
    }
  }
  const distances = points.length >= 2 ? cumulativeDistances(points) : points.map(() => 0);
  return {
    points,
    distances,
    distanceM: distances.length > 0 ? distances[distances.length - 1] : 0,
    spans,
  };
}

/** The span containing a global point index, or `null`. */
export function spanAt(flat: FlatTrip, globalIndex: number): TripLegSpan | null {
  for (const span of flat.spans) {
    if (globalIndex >= span.startIndex && globalIndex <= span.endIndex) return span;
  }
  return null;
}

/** Map a global point index to `{ legId, index }`. */
export function localIndex(
  flat: FlatTrip,
  globalIndex: number,
): { legId: string; index: number } | null {
  const span = spanAt(flat, globalIndex);
  if (!span) return null;
  return { legId: span.legId, index: globalIndex - span.startIndex };
}

/** Global index for a leg-local index, or `null` when the leg is unknown. */
export function globalIndex(flat: FlatTrip, legId: string, index: number): number | null {
  const span = flat.spans.find((candidate) => candidate.legId === legId);
  if (!span) return null;
  const global = span.startIndex + index;
  return global >= span.startIndex && global <= span.endIndex ? global : null;
}

/** Leg by id from the trip, or `undefined`. */
export function findLeg(trip: Trip | null, legId: string | null): Leg | undefined {
  if (!trip || !legId) return undefined;
  return trip.legs.find((leg) => leg.id === legId);
}

/**
 * A leg created by `emptyLeg()` has placeholder geometry: all points share one
 * coordinate. Drawing replaces it rather than appending to it, which is why this
 * check exists.
 */
export function isPlaceholderLeg(leg: Leg | undefined): boolean {
  if (!leg || leg.points.length === 0) return true;
  const first = leg.points[0];
  return leg.points.every((point) => point.lon === first.lon && point.lat === first.lat);
}

/** Total leg count and distance for a summary line. */
export function tripSummaryNumbers(trip: Trip | null): {
  legCount: number;
  pointCount: number;
  distanceM: number;
} {
  const flat = flattenTrip(trip);
  return {
    legCount: trip?.legs.length ?? 0,
    pointCount: flat.points.length,
    distanceM: flat.distanceM,
  };
}
