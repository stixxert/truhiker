/**
 * Point validation and normalisation.
 *
 * Two jobs:
 *
 * 1. Reject garbage loudly. The editor is the only place that decides geometry,
 *    so a NaN longitude must fail here rather than surface as an empty map
 *    later.
 * 2. Normalise the shape. A `RoutePoint` with `ele: undefined` and one without
 *    the key are the same point; emitting the key anyway would make
 *    `toStrictEqual` comparisons and JSON round-trips annoying for no gain.
 *
 * Elevation is copied verbatim, including `0` (a real value at sea level) and
 * including its `eleSource`. Nothing here samples or invents elevation.
 */

import type { ElevationSource, RoutePoint } from '../contracts';
import { RouteEditError } from './errors';

const ELEVATION_SOURCES: readonly ElevationSource[] = ['gpx', 'dem', 'none'];

export function copyPoint(point: RoutePoint): RoutePoint {
  const out: { lon: number; lat: number; ele?: number; eleSource?: ElevationSource } = {
    lon: point.lon,
    lat: point.lat,
  };
  if (point.ele !== undefined) out.ele = point.ele;
  if (point.eleSource !== undefined) out.eleSource = point.eleSource;
  return out;
}

/**
 * Validate a point and return a normalised copy. Throws
 * `RouteEditError('invalid-point')` for non-finite coordinates, latitudes beyond
 * ±90°, or a non-numeric `ele`.
 */
export function assertRoutePoint(point: RoutePoint, what: string): RoutePoint {
  if (!point || typeof point !== 'object') {
    throw new RouteEditError('invalid-point', `${what}: expected a point, got ${String(point)}`);
  }
  if (!Number.isFinite(point.lon) || !Number.isFinite(point.lat)) {
    throw new RouteEditError(
      'invalid-point',
      `${what}: lon/lat must be finite numbers, got ${JSON.stringify(point)}`,
    );
  }
  if (Math.abs(point.lat) > 90 || Math.abs(point.lon) > 180) {
    throw new RouteEditError(
      'invalid-point',
      `${what}: lon ${point.lon} / lat ${point.lat} is outside ±180 / ±90`,
    );
  }
  if (point.ele !== undefined && (typeof point.ele !== 'number' || !Number.isFinite(point.ele))) {
    throw new RouteEditError(
      'invalid-point',
      `${what}: ele must be a finite number or absent, got ${JSON.stringify(point.ele)}`,
    );
  }
  if (point.eleSource !== undefined && !ELEVATION_SOURCES.includes(point.eleSource)) {
    throw new RouteEditError(
      'invalid-point',
      `${what}: eleSource must be one of ${ELEVATION_SOURCES.join('/')}, got ${String(point.eleSource)}`,
    );
  }
  return copyPoint(point);
}
