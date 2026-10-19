/**
 * Corridor maths — how far a point is from a polyline, and how far along it.
 *
 * Everything here is **metric**. A point is never compared to the route in
 * degrees: latitude and longitude are scaled by 111,132 m/deg and
 * 111,320·cos(lat) m/deg respectively, exactly the local-equirectangular
 * approximation used by `projectOntoRoute()` in `src/plan/resupply.ts` (at
 * Norwegian latitudes the error is well under 0.1 %, far below the precision of
 * an OSM shop position). `test/resupply/shops.test.ts` asserts that the two
 * implementations agree, so a change in one that is not mirrored in the other
 * fails.
 *
 * Why not reuse `projectOntoRoute()` directly: it scans every segment for every
 * point, so the bundled 8,571 POIs against a 5,000-point polyline would be ~43 M
 * segment tests per query. `RouteCorridor` indexes segments by latitude in 0.05°
 * bands and only tests segments that can possibly be within the requested
 * radius; the projection itself is the same formula.
 */

import { cumulativeDistances, haversine, type LonLat } from '../core/geo';

/** Metres per degree of latitude (mean). */
export const M_PER_DEG_LAT = 111_132;
/** Metres per degree of longitude at the equator. */
export const M_PER_DEG_LON = 111_320;

const DEG = Math.PI / 180;
/** Latitude bucket height, ≈5.5 km. */
const BUCKET_DEG = 0.05;
/** Segments spanning more buckets than this are kept in `wide` and always tested. */
const MAX_BUCKETS_PER_SEGMENT = 4;
/** Above this radius the bucket index earns nothing; scan every segment. */
const MAX_INDEXED_RADIUS_M = 100_000;

export interface CorridorProjection {
  /** Distance from the start of the polyline to the nearest point on it, metres. */
  readonly alongM: number;
  /** Perpendicular distance from the point to the polyline, metres. */
  readonly detourM: number;
}

/**
 * A polyline prepared for corridor queries.
 *
 * `projectWithin()` is exact for every point within `radiusM` of the polyline
 * and returns `null` beyond it. `project()` is exact for any point, at the cost
 * of a full segment scan.
 */
export class RouteCorridor {
  readonly coords: readonly LonLat[];
  /** Cumulative haversine distance to each vertex; `[0]` is 0. */
  readonly cum: readonly number[];
  /** Total polyline length in metres. */
  readonly lengthM: number;

  /** Segment geometry, flattened for speed. */
  private readonly segCount: number;
  private readonly aLat: Float64Array;
  private readonly aLon: Float64Array;
  private readonly bLat: Float64Array;
  private readonly bLon: Float64Array;

  private readonly buckets = new Map<number, number[]>();
  private readonly wide: number[] = [];

  constructor(coords: readonly LonLat[]) {
    this.coords = coords.map((point) => ({ lon: point.lon, lat: point.lat }));
    this.cum = cumulativeDistances(this.coords);
    this.lengthM = this.cum.length > 0 ? this.cum[this.cum.length - 1] : 0;

    this.segCount = Math.max(0, this.coords.length - 1);
    this.aLat = new Float64Array(this.segCount);
    this.aLon = new Float64Array(this.segCount);
    this.bLat = new Float64Array(this.segCount);
    this.bLon = new Float64Array(this.segCount);

    for (let i = 0; i < this.segCount; i += 1) {
      const a = this.coords[i];
      const b = this.coords[i + 1];
      this.aLat[i] = a.lat;
      this.aLon[i] = a.lon;
      this.bLat[i] = b.lat;
      this.bLon[i] = b.lon;

      const first = Math.floor(Math.min(a.lat, b.lat) / BUCKET_DEG);
      const last = Math.floor(Math.max(a.lat, b.lat) / BUCKET_DEG);
      if (last - first + 1 > MAX_BUCKETS_PER_SEGMENT) {
        this.wide.push(i);
        continue;
      }
      for (let bucket = first; bucket <= last; bucket += 1) {
        const list = this.buckets.get(bucket);
        if (list) list.push(i);
        else this.buckets.set(bucket, [i]);
      }
    }
  }

  /**
   * Nearest point on the polyline, if it is within `radiusM`.
   *
   * Throws on an empty polyline — an empty route has no corridor, and returning
   * a zero distance would silently claim every POI is "on the route".
   */
  projectWithin(point: LonLat, radiusM: number): CorridorProjection | null {
    if (this.coords.length === 0) {
      throw new Error('cannot project onto an empty route');
    }
    if (!Number.isFinite(point.lon) || !Number.isFinite(point.lat)) {
      throw new RangeError(`cannot project a non-finite point: ${String(point)}`);
    }
    if (!(radiusM >= 0) || Number.isNaN(radiusM)) {
      throw new RangeError(`invalid corridor radius: ${radiusM}`);
    }

    if (this.coords.length === 1) {
      const detour = haversine(this.coords[0], point);
      return detour <= radiusM ? { alongM: 0, detourM: detour } : null;
    }

    const best = this.scan(this.candidateSegments(point, radiusM), point);
    return best.detourM <= radiusM ? best : null;
  }

  /** Nearest point on the polyline, for any distance. */
  project(point: LonLat): CorridorProjection {
    if (this.coords.length === 0) {
      throw new Error('cannot project onto an empty route');
    }
    if (this.coords.length === 1) {
      return { alongM: 0, detourM: haversine(this.coords[0], point) };
    }
    const indices: number[] = [];
    for (let i = 0; i < this.segCount; i += 1) indices.push(i);
    return this.scan(indices, point);
  }

  private candidateSegments(point: LonLat, radiusM: number): Iterable<number> {
    if (!Number.isFinite(radiusM) || radiusM > MAX_INDEXED_RADIUS_M) {
      const all: number[] = [];
      for (let i = 0; i < this.segCount; i += 1) all.push(i);
      return all;
    }
    // A segment whose latitude range is more than `radiusM` away can never be
    // within the radius, so only buckets overlapping the band are inspected.
    const padLat = radiusM / M_PER_DEG_LAT;
    const first = Math.floor((point.lat - padLat) / BUCKET_DEG);
    const last = Math.floor((point.lat + padLat) / BUCKET_DEG);
    const out: number[] = [...this.wide];
    for (let bucket = first; bucket <= last; bucket += 1) {
      const list = this.buckets.get(bucket);
      if (list) out.push(...list);
    }
    return out;
  }

  private scan(indices: Iterable<number>, point: LonLat): CorridorProjection {
    let bestDetour = Number.POSITIVE_INFINITY;
    let bestAlong = 0;
    for (const i of indices) {
      const aLat = this.aLat[i];
      const aLon = this.aLon[i];
      const meanLat = ((aLat + this.bLat[i]) / 2) * DEG;
      const mPerDegLon = M_PER_DEG_LON * Math.cos(meanLat);
      const bx = (this.bLon[i] - aLon) * mPerDegLon;
      const by = (this.bLat[i] - aLat) * M_PER_DEG_LAT;
      const px = (point.lon - aLon) * mPerDegLon;
      const py = (point.lat - aLat) * M_PER_DEG_LAT;
      const lengthSq = bx * bx + by * by;
      const t = lengthSq > 0 ? Math.max(0, Math.min(1, (px * bx + py * by) / lengthSq)) : 0;
      const dx = px - t * bx;
      const dy = py - t * by;
      const detour = Math.hypot(dx, dy);
      if (detour < bestDetour) {
        bestDetour = detour;
        bestAlong = this.cum[i] + t * (this.cum[i + 1] - this.cum[i]);
      }
    }
    return { alongM: bestAlong, detourM: bestDetour };
  }
}

/** Longitude padding, in degrees, for `radiusM` at `lat` (clamped near the poles). */
export function lonPadDeg(radiusM: number, lat: number): number {
  const cosine = Math.max(1e-6, Math.cos(lat * DEG));
  return radiusM / (M_PER_DEG_LON * cosine);
}
