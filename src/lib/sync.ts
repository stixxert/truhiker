/**
 * Profile ↔ map sync maths.
 *
 * Two directions, both pure so they can be tested without a map:
 *
 *  - **map → profile**: the cursor follows the camera. We take the route point
 *    closest to the map centre, measured in Web-Mercator pixels at the current
 *    zoom, and return its distance along the route.
 *  - **profile → map**: hovering the chart asks for the lon/lat at a distance
 *    along the route, which becomes a marker on the map.
 *
 * The map-centre test ignores bearing and pitch: the camera centre is the same
 * ground point at any pitch, and bearing only rotates the view around it. That
 * is exactly the behaviour we want for "which part of the route am I looking
 * at", and it avoids projecting tens of thousands of points per frame.
 */

import type { LonLat } from '../core/geo';

export interface RouteGeometry {
  readonly points: readonly LonLat[];
  /** Cumulative distance for each point, metres. */
  readonly distances: readonly number[];
}

interface NearestRoutePoint {
  index: number;
  distanceM: number;
  /** Distance from the query point in screen pixels at the supplied zoom. */
  screenPx: number;
}

/** MapLibre's world size at zoom 0, in CSS pixels. */
export const TILE_SIZE = 512;

/** Clamp a latitude to the Web-Mercator domain. */
function clampLat(lat: number): number {
  return Math.min(85.051129, Math.max(-85.051129, lat));
}

/**
 * Normalised Web-Mercator coordinates in [0, 1]. x is longitude, y increases
 * southwards. This is the projection MapLibre uses internally, so converting
 * back with `TILE_SIZE * 2 ** zoom` gives screen pixels at the equator scale.
 */
export function lonLatToMercator(lon: number, lat: number): { x: number; y: number } {
  const x = (lon + 180) / 360;
  const sin = Math.sin((clampLat(lat) * Math.PI) / 180);
  const y = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
  return { x, y };
}

/** Pixels per normalised Mercator unit at a zoom level. */
export function mercatorScale(zoom: number): number {
  return TILE_SIZE * 2 ** zoom;
}

/**
 * Route point nearest to `centre`, using screen-pixel distance at `zoom`.
 *
 * A coarse pass (at most `maxSamples` candidates) finds the approximate winner
 * and a local refinement scans the full resolution around it, so the result is
 * exact while staying O(sqrt(n)) for long routes.
 */
export function nearestRoutePoint(
  geometry: RouteGeometry,
  centre: LonLat,
  zoom: number,
  maxSamples = 512,
): NearestRoutePoint | null {
  const { points, distances } = geometry;
  const n = points.length;
  if (n === 0) return null;

  const scale = mercatorScale(zoom);
  const target = lonLatToMercator(centre.lon, centre.lat);

  const squared = (index: number): number => {
    const p = lonLatToMercator(points[index].lon, points[index].lat);
    const dx = (p.x - target.x) * scale;
    const dy = (p.y - target.y) * scale;
    return dx * dx + dy * dy;
  };

  const stride = Math.max(1, Math.ceil(n / Math.max(2, maxSamples)));
  let bestIndex = 0;
  let bestSquared = Number.POSITIVE_INFINITY;
  for (let i = 0; i < n; i += stride) {
    const d2 = squared(i);
    if (d2 < bestSquared) {
      bestSquared = d2;
      bestIndex = i;
    }
  }
  // Always consider the final point: a stride that does not divide n would
  // otherwise miss the route end (which matters for "where am I" precision).
  const lastSquared = squared(n - 1);
  if (lastSquared < bestSquared) {
    bestSquared = lastSquared;
    bestIndex = n - 1;
  }

  const from = Math.max(0, bestIndex - stride);
  const to = Math.min(n - 1, bestIndex + stride);
  for (let i = from; i <= to; i++) {
    const d2 = squared(i);
    if (d2 < bestSquared) {
      bestSquared = d2;
      bestIndex = i;
    }
  }

  return {
    index: bestIndex,
    distanceM: distances[bestIndex],
    screenPx: Math.sqrt(bestSquared),
  };
}

/** Interpolated lon/lat at a distance along the route, clamped to its ends. */
export function pointAtDistance(geometry: RouteGeometry, distance: number): LonLat | null {
  const { points, distances } = geometry;
  const n = points.length;
  if (n === 0) return null;
  if (n === 1 || distance <= distances[0]) return { ...points[0] };
  if (distance >= distances[n - 1]) return { ...points[n - 1] };

  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (distances[mid] <= distance) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  const span = distances[hi] - distances[lo];
  if (!(span > 0)) return { ...a };
  const t = (distance - distances[lo]) / span;
  return { lon: a.lon + (b.lon - a.lon) * t, lat: a.lat + (b.lat - a.lat) * t };
}

/** Distance along the route to clamp an arbitrary distance into range. */
export function clampDistance(geometry: RouteGeometry, distance: number): number {
  const n = geometry.distances.length;
  if (n === 0) return 0;
  return Math.min(geometry.distances[n - 1], Math.max(0, distance));
}
