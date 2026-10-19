/**
 * Leg and trip metrics.
 *
 * `recomputeLeg` is the only place that turns geometry into numbers, so a leg's
 * `distanceM`/`ascentM`/`descentM` can never disagree with its points.
 *
 * Distance is haversine on the mean sphere (`src/core/geo`), i.e. the same
 * measure everything else in the project uses.
 *
 * Ascent/descent reuse the **hysteresis** state machine from
 * `src/core/profile.ts` (`elevationGainLoss`) and nothing else. Two deliberate
 * differences from `buildProfile`'s pipeline:
 *
 *  - No gap filling. If any point lacks an elevation there is nothing to fill
 *    from, and the honest answer is `null` — never `0`.
 *  - No median filter. `buildProfile` filters because DEM samples sit 10 m
 *    apart and single-pixel spikes are noise; edit vertices are sparse, chosen
 *    by a human, and a lone summit waypoint *is* the signal. Filtering it out
 *    would under-report climbing.
 *
 * Because of that, `ascentM` here is a per-vertex figure and is not guaranteed
 * to equal the resampled profile's number for the same leg. The profile panel is
 * the authoritative figure; this one is the leg-level summary used for listing
 * and ordering.
 */

import type { Leg, Trip } from '../contracts';
import { pathLength } from '../core/geo';
import { elevationGainLoss } from '../core/profile';

/** True when the point carries a usable elevation. `0` is a real value. */
export function hasElevation(point: { readonly ele?: number }): point is { readonly ele: number } {
  return typeof point.ele === 'number' && Number.isFinite(point.ele);
}

/**
 * Recompute `distanceM`, `ascentM` and `descentM` from `leg.points`.
 *
 * - `distanceM` is `null` for fewer than two points (nothing to measure).
 * - `ascentM`/`descentM` are `null` if **any** point lacks a finite `ele`.
 *   A leg with two points and no elevations has a distance and an unknown
 *   climb; rendering 0 m of climbing there would be a lie.
 */
export function recomputeLeg(leg: Leg): Leg {
  const points = leg.points;
  const distanceM = points.length < 2 ? null : pathLength(points);

  let ascentM: number | null = null;
  let descentM: number | null = null;
  if (points.length >= 2 && points.every(hasElevation)) {
    const { ascentM: gain, descentM: loss } = elevationGainLoss(points.map((point) => point.ele as number));
    ascentM = gain;
    descentM = loss;
  }

  return { ...leg, distanceM, ascentM, descentM };
}

/**
 * Total trip distance.
 *
 * `null` when the trip has no legs, or when any leg's distance is unknown: a
 * partial sum presented as a total is the "unknown rendered as a number"
 * failure the project forbids. Legs always have a distance in practice (they
 * always have ≥2 points), so this is a guard rather than a common path.
 */
export function tripDistanceM(trip: Trip): number | null {
  if (trip.legs.length === 0) return null;
  let total = 0;
  for (const leg of trip.legs) {
    if (leg.distanceM === null) return null;
    total += leg.distanceM;
  }
  return total;
}
