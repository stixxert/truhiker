/**
 * Route model: from a parsed GPX document to the geometry the map and the
 * profile both use.
 *
 * The route is resampled at (approximately) 25 m, matching the CLI and the
 * DEM's 10 m pixels — fine enough that a 50 m switchback is preserved, coarse
 * enough that a 3,000 km route is ~60,000 samples and not 8 million. Very long
 * routes get a coarser spacing automatically so the sample count stays bounded.
 */

import { cumulativeDistances, pathLength, resample, type LonLat } from '../core/geo';
import type { GpxDocument, GpxTrack } from '../core/gpx';

/** Preferred sample spacing, metres. */
export const SAMPLE_SPACING_M = 25;
/** Hard cap on resampled points (a 3,000 km route lands at ~60k at 50 m). */
export const MAX_SAMPLES = 60_000;
/** Cap on points sent to the map as GeoJSON, to keep GL buffers modest. */
const MAX_DISPLAY_POINTS = 25_000;

/**
 * How the route got here. `demo` was removed with the bundled sample route (D26):
 * a saved trip that still carries it is mapped to `file` when it is read.
 */
export type RouteOrigin = 'file' | 'link';

export interface Route {
  readonly name: string;
  readonly points: readonly LonLat[];
  readonly distances: readonly number[];
  readonly distanceM: number;
  readonly origin: RouteOrigin;
  readonly fileName?: string;
  /** Original GPX text, when available, for the shareable URL hash. */
  readonly gpxText?: string;
}

/**
 * Norway / mainland bounds with the live elevation service and the basemap with
 * real coverage. Outside this box the app still draws the route but refuses to
 * invent elevation numbers.
 */
const SUPPORTED_BOUNDS = {
  minLon: 2,
  minLat: 57,
  maxLon: 32,
  maxLat: 72.5,
} as const;

interface RouteInput {
  name?: string;
  coords: readonly LonLat[];
  origin: RouteOrigin;
  fileName?: string;
  gpxText?: string;
}

/** First usable track, else the first usable route, else null. */
export function pickTrack(document: GpxDocument): GpxTrack | null {
  const candidates = [...document.tracks, ...document.routes];
  for (const track of candidates) {
    if (track.points.length >= 2) return track;
  }
  return null;
}

/**
 * Build a resampled route. Throws if there are fewer than two distinct points —
 * a one-point route has no distance and no profile, and inventing one would be
 * worse than refusing.
 */
export function buildRoute(input: RouteInput): Route {
  const coords = input.coords.filter(
    (point) => Number.isFinite(point.lon) && Number.isFinite(point.lat),
  );
  if (coords.length < 2) {
    throw new Error('route needs at least two valid points');
  }

  const lengthEstimate = pathLength(coords);
  if (!(lengthEstimate > 0)) {
    throw new Error('route has zero length');
  }
  const spacing = Math.max(SAMPLE_SPACING_M, lengthEstimate / MAX_SAMPLES);
  const points = resample(coords, spacing);
  if (points.length < 2) throw new Error('route has zero length');

  const distances = cumulativeDistances(points);
  return {
    name: input.name?.trim() || '',
    points,
    distances,
    distanceM: distances[distances.length - 1],
    origin: input.origin,
    fileName: input.fileName,
    gpxText: input.gpxText,
  };
}

/** Coordinates ready for a GeoJSON LineString, decimated for the GPU. */
export function displayCoordinates(
  points: readonly LonLat[],
  maxPoints = MAX_DISPLAY_POINTS,
): [number, number][] {
  if (points.length === 0) return [];
  if (points.length <= maxPoints) return points.map((p) => [p.lon, p.lat]);
  const stride = Math.ceil(points.length / maxPoints);
  const out: [number, number][] = [];
  for (let i = 0; i < points.length; i += stride) out.push([points[i].lon, points[i].lat]);
  const last = points[points.length - 1];
  const tail = out[out.length - 1];
  if (tail[0] !== last.lon || tail[1] !== last.lat) out.push([last.lon, last.lat]);
  return out;
}

export interface Bounds {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export function routeBounds(points: readonly LonLat[]): Bounds | null {
  if (points.length === 0) return null;
  let minLon = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    if (point.lon < minLon) minLon = point.lon;
    if (point.lon > maxLon) maxLon = point.lon;
    if (point.lat < minLat) minLat = point.lat;
    if (point.lat > maxLat) maxLat = point.lat;
  }
  return { minLon, minLat, maxLon, maxLat };
}

interface SupportCheck {
  ok: boolean;
  /** Number of points outside the supported area; 0 when ok. */
  outsidePoints: number;
}

/** Whether every point lies inside the area the elevation service covers. */
export function checkSupported(points: readonly LonLat[]): SupportCheck {
  let outsidePoints = 0;
  for (const point of points) {
    const inside =
      point.lon >= SUPPORTED_BOUNDS.minLon &&
      point.lon <= SUPPORTED_BOUNDS.maxLon &&
      point.lat >= SUPPORTED_BOUNDS.minLat &&
      point.lat <= SUPPORTED_BOUNDS.maxLat;
    if (!inside) outsidePoints++;
  }
  return { ok: outsidePoints === 0, outsidePoints };
}
