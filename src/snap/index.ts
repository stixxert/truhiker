/**
 * Spatial index and nearest-segment snapping for Turrutebasen polylines.
 *
 * Design notes
 * ------------
 * - The index is a uniform grid in **degrees** (cell size ~0.02°, roughly
 *   1.1 km north–south at 61°N). Segments are inserted into every cell they
 *   pass through, so a lookup touches only a handful of cells.
 * - Distances are **never** computed in degree space. For each query the
 *   candidate segments are projected into a local equirectangular plane whose
 *   x-scale is `R·cos(query latitude)`, which is accurate to well under 1 %
 *   over the few hundred metres that matter for snapping. Norway spans
 *   58–71°N, where a degree of longitude is only 0.33–0.53 of a degree of
 *   latitude; raw degree distances would be biased by 2–3×.
 * - `snap()` returns `null` when nothing is within the radius. It never
 *   guesses a nearby trail.
 * - Hysteresis: if a `currentLineId` is supplied and that line is within
 *   `stickyRadiusM` (default 1.5 × the normal radius), it wins even when a
 *   parallel trail is closer. This stops the snapped point flickering between
 *   two trails that run a few metres apart.
 */

import { EARTH_RADIUS_M, type LonLat } from '../core/geo';
import type { TurruteAttributes, TurruteLine } from './wfs';

export type { LonLat, TurruteAttributes, TurruteLine };

const DEG = Math.PI / 180;

/** Default snap radius, metres. */
export const DEFAULT_SNAP_RADIUS_M = 75;
/** Default radius at which an existing snap is kept, metres (1.6 × 75). */
export const DEFAULT_STICKY_RADIUS_M = 120;
/** Default grid cell size in degrees (~1.1 km north–south at 61°N). */
const DEFAULT_GRID_CELL_DEG = 0.02;

// ---------------------------------------------------------------------------
// Local metric projection
// ---------------------------------------------------------------------------

/** Longitude scale factor at a latitude: metres per degree of longitude / R. */
function cosLat(lat: number): number {
  return Math.max(Math.cos(lat * DEG), 1e-6);
}

/**
 * Metres per degree of latitude on the mean sphere.
 * One degree of longitude is this times `cos(lat)`.
 */
export const METRES_PER_DEG_LAT = (EARTH_RADIUS_M * Math.PI) / 180;

/**
 * Distance between two lon/lat points in a local equirectangular plane scaled
 * at the pair's mean latitude, metres.
 *
 * This is the same quantity the snapper minimises. For points hundreds of
 * metres apart it agrees with the haversine formula to much better than 1 %.
 */
export function localDistanceM(a: LonLat, b: LonLat): number {
  const lat0 = ((a.lat + b.lat) / 2) * DEG;
  const dLat = (b.lat - a.lat) * DEG * EARTH_RADIUS_M;
  const dLon = (b.lon - a.lon) * DEG * EARTH_RADIUS_M * Math.cos(lat0);
  return Math.hypot(dLat, dLon);
}

interface LocalPoint {
  x: number;
  y: number;
}

/** Project a point relative to a query point into the local metric plane. */
function project(point: LonLat, origin: LonLat): LocalPoint {
  const scale = EARTH_RADIUS_M * DEG * cosLat(origin.lat);
  return {
    x: (point.lon - origin.lon) * scale,
    y: (point.lat - origin.lat) * DEG * EARTH_RADIUS_M,
  };
}

/** Invert `project` for a local-plane point. */
function unproject(local: LocalPoint, origin: LonLat): LonLat {
  const scale = EARTH_RADIUS_M * DEG * cosLat(origin.lat);
  return {
    lon: origin.lon + local.x / scale,
    lat: origin.lat + local.y / (DEG * EARTH_RADIUS_M),
  };
}

// ---------------------------------------------------------------------------
// Snapping types
// ---------------------------------------------------------------------------

interface SnapOptions {
  /** Maximum distance to consider a hit, metres. Default 75. */
  radiusM?: number;
  /**
   * Distance within which an existing snap on `currentLineId` is kept, metres.
   * Default 120 (1.6 × the default radius; the spec asks for at least 1.5 ×).
   * Must be >= `radiusM`.
   */
  stickyRadiusM?: number;
  /**
   * The line the caller is currently snapped to (from the previous call).
   * Enables hysteresis: that line is kept while within `stickyRadiusM`.
   */
  currentLineId?: string | null;
  /** Optional cap on candidate segments examined (diagnostics/perf). */
  maxCandidates?: number;
}

export interface SnapResult {
  /** Id of the line that was snapped to (`TurruteLine.id`). */
  lineId: string;
  lokalId: string;
  attributes: TurruteAttributes;
  /** Nearest point on the segment, lon/lat degrees. */
  snappedPoint: LonLat;
  /** Distance from the query point to `snappedPoint`, metres. */
  distanceM: number;
  /** Position along the matched segment, 0 at its start and 1 at its end. */
  t: number;
  /** Direction of the matched segment at the snapped point, degrees 0–360. */
  bearing: number;
  /** Index of the segment within the line's coordinate list. */
  segmentIndex: number;
}

interface SnapIndexOptions {
  /** Grid cell size in degrees. Default 0.02 (~1.1 km at 61°N). */
  gridCellDeg?: number;
}

// ---------------------------------------------------------------------------
// Uniform grid index
// ---------------------------------------------------------------------------

interface Segment {
  lineIndex: number;
  segmentIndex: number;
  /** Endpoint indices in the line's `coords` array. */
  start: LonLat;
  end: LonLat;
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

interface SegmentHit {
  lineIndex: number;
  segmentIndex: number;
  distanceM: number;
  t: number;
  bearing: number;
  snappedPoint: LonLat;
  lineId: string;
}

function cellKey(ix: number, iy: number): string {
  return `${ix},${iy}`;
}

/**
 * Floating-point-tolerant grid index (`8.02 / 0.02` is 400.99999999999994).
 * Both insertion and lookup use this, so boundary points stay consistent.
 */
function gridIndex(value: number, cellDeg: number): number {
  return Math.floor(value / cellDeg + 1e-9);
}

function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number, got ${value}`);
  }
}

function assertLonLat(point: LonLat, label: string): void {
  if (!Number.isFinite(point.lon) || !Number.isFinite(point.lat)) {
    throw new RangeError(`${label} must have finite lon/lat, got ${JSON.stringify(point)}`);
  }
  if (Math.abs(point.lat) > 90 || Math.abs(point.lon) > 180) {
    throw new RangeError(`${label} is outside lon ±180 / lat ±90: ${JSON.stringify(point)}`);
  }
}

/**
 * Uniform-grid spatial index over Turrutebasen polylines.
 *
 * Lines are deduplicated by id, so overlapping prefetch cells can be added
 * freely without inflating the index.
 */
export class SnapIndex {
  private readonly cellDeg: number;
  /** cell key → segment ids (indices into `segments`). */
  private readonly grid = new Map<string, number[]>();
  private readonly segments: Segment[] = [];
  private readonly lineList: TurruteLine[] = [];
  private readonly lineIndexById = new Map<string, number>();

  constructor(options: SnapIndexOptions = {}) {
    this.cellDeg = options.gridCellDeg ?? DEFAULT_GRID_CELL_DEG;
    assertPositiveFinite('SnapIndex gridCellDeg', this.cellDeg);
    if (this.cellDeg >= 1) {
      throw new RangeError(`SnapIndex gridCellDeg must be < 1° (got ${this.cellDeg})`);
    }
  }

  /** Number of indexed lines. */
  get lineCount(): number {
    return this.lineList.length;
  }

  /** Number of indexed segments. */
  get segmentCount(): number {
    return this.segments.length;
  }

  /** Number of occupied grid cells. */
  get cellCount(): number {
    return this.grid.size;
  }

  /** All indexed lines, in insertion order. */
  get lines(): readonly TurruteLine[] {
    return this.lineList;
  }

  hasLine(lineId: string): boolean {
    return this.lineIndexById.has(lineId);
  }

  getLine(lineId: string): TurruteLine | undefined {
    const index = this.lineIndexById.get(lineId);
    return index === undefined ? undefined : this.lineList[index];
  }

  /**
   * Add polylines. Lines with an id already indexed are skipped (a cache hit
   * and a prefetch of the same cell must not double the index). Lines with
   * fewer than two finite coordinates cannot be snapped to and are skipped.
   */
  addLines(lines: readonly TurruteLine[]): number {
    let added = 0;
    for (const line of lines) {
      if (this.lineIndexById.has(line.id)) continue;
      const coords = line.coords.filter(
        (point) =>
          Number.isFinite(point.lon) &&
          Number.isFinite(point.lat) &&
          Math.abs(point.lat) <= 90 &&
          Math.abs(point.lon) <= 180,
      );
      if (coords.length < 2) continue;

      this.lineIndexById.set(line.id, this.lineList.length);
      const lineIndex = this.lineList.length;
      this.lineList.push({ ...line, coords });
      added++;

      for (let i = 0; i + 1 < coords.length; i++) {
        this.addSegment(lineIndex, i, coords[i], coords[i + 1]);
      }
    }
    return added;
  }

  private addSegment(lineIndex: number, segmentIndex: number, start: LonLat, end: LonLat): void {
    // Exact duplicate consecutive coordinates are zero-length noise.
    if (start.lon === end.lon && start.lat === end.lat) return;

    const segment: Segment = {
      lineIndex,
      segmentIndex,
      start,
      end,
      minLon: Math.min(start.lon, end.lon),
      minLat: Math.min(start.lat, end.lat),
      maxLon: Math.max(start.lon, end.lon),
      maxLat: Math.max(start.lat, end.lat),
    };
    const id = this.segments.push(segment) - 1;

    // Insert along the segment in half-cell steps instead of into every cell
    // of its bounding box: a long diagonal segment would otherwise touch O(n²)
    // cells.
    const steps =
      Math.ceil(Math.max(segment.maxLon - segment.minLon, segment.maxLat - segment.minLat) / (this.cellDeg / 2)) + 1;
    const visited = new Set<string>();
    for (let step = 0; step <= steps; step++) {
      const t = steps === 0 ? 0 : step / steps;
      const lon = start.lon + (end.lon - start.lon) * t;
      const lat = start.lat + (end.lat - start.lat) * t;
      const ix = gridIndex(lon, this.cellDeg);
      const iy = gridIndex(lat, this.cellDeg);
      const key = cellKey(ix, iy);
      if (visited.has(key)) continue;
      visited.add(key);
      let bucket = this.grid.get(key);
      if (!bucket) {
        bucket = [];
        this.grid.set(key, bucket);
      }
      bucket.push(id);
    }
  }

  /** Candidate segment ids whose grid cells intersect a padded query box. */
  private candidates(origin: LonLat, radiusM: number): Set<number> {
    const dLat = radiusM / METRES_PER_DEG_LAT;
    const dLon = dLat / cosLat(origin.lat);
    const minIx = gridIndex(origin.lon - dLon, this.cellDeg);
    const maxIx = gridIndex(origin.lon + dLon, this.cellDeg);
    const minIy = gridIndex(origin.lat - dLat, this.cellDeg);
    const maxIy = gridIndex(origin.lat + dLat, this.cellDeg);

    const out = new Set<number>();
    for (let iy = minIy; iy <= maxIy; iy++) {
      for (let ix = minIx; ix <= maxIx; ix++) {
        const bucket = this.grid.get(cellKey(ix, iy));
        if (!bucket) continue;
        for (const segmentId of bucket) out.add(segmentId);
      }
    }
    return out;
  }

  /** Nearest point on one segment, measured in the local metric plane. */
  private hit(segmentId: number, origin: LonLat): SegmentHit {
    const segment = this.segments[segmentId];
    const a = project(segment.start, origin);
    const b = project(segment.end, origin);
    // `origin` projects to (0,0), so this is a point-to-segment distance.
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;

    let t = 0;
    if (lengthSquared > 0) {
      t = -(a.x * dx + a.y * dy) / lengthSquared;
      t = Math.min(1, Math.max(0, t));
    }
    const x = a.x + dx * t;
    const y = a.y + dy * t;
    const distanceM = Math.hypot(x, y);

    // Bearing of the segment (not of the offset from the query point),
    // measured clockwise from north. A degenerate segment has no direction.
    let bearing = 0;
    if (lengthSquared > 0) {
      bearing = (Math.atan2(dx, dy) / DEG + 360) % 360;
    }

    const line = this.lineList[segment.lineIndex];
    return {
      lineIndex: segment.lineIndex,
      segmentIndex: segment.segmentIndex,
      distanceM,
      t,
      bearing,
      snappedPoint: unproject({ x, y }, origin),
      lineId: line.id,
    };
  }

  private toResult(hit: SegmentHit): SnapResult {
    const line = this.lineList[hit.lineIndex];
    return {
      lineId: line.id,
      lokalId: line.lokalId,
      attributes: line.attributes,
      snappedPoint: hit.snappedPoint,
      distanceM: hit.distanceM,
      t: hit.t,
      bearing: hit.bearing,
      segmentIndex: hit.segmentIndex,
    };
  }

  /**
   * Snap a point to the nearest indexed trail.
   *
   * Returns `null` when no segment is within `radiusM`. With
   * `currentLineId` set, the current line is kept while it is within
   * `stickyRadiusM` (hysteresis); otherwise the nearest line within
   * `radiusM` wins.
   */
  snap(point: LonLat, options: SnapOptions = {}): SnapResult | null {
    assertLonLat(point, 'snap point');
    const radiusM = options.radiusM ?? DEFAULT_SNAP_RADIUS_M;
    // Hysteresis is derived from the radius, never fixed: D5 says leaving a snapped
    // line takes 1.5 × the radius, and the dock offers 20–300 m. A fixed 120 m
    // default made every call above 120 m throw — so the wider the user set the
    // radius, the more certainly snapping was dead.
    const stickyRadiusM =
      options.stickyRadiusM ?? Math.max(DEFAULT_STICKY_RADIUS_M, radiusM * 1.5);
    assertPositiveFinite('snap radiusM', radiusM);
    assertPositiveFinite('snap stickyRadiusM', stickyRadiusM);
    if (stickyRadiusM < radiusM) {
      throw new RangeError(
        `snap stickyRadiusM (${stickyRadiusM}) must be >= radiusM (${radiusM}); ` +
          `hysteresis cannot be tighter than the snap radius`,
      );
    }
    const currentLineId = options.currentLineId ?? null;
    if (this.segmentCount === 0) return null;

    // When a current line is supplied we must look far enough to find it.
    const searchRadiusM = currentLineId ? Math.max(radiusM, stickyRadiusM) : radiusM;
    const candidateIds = this.candidates(point, searchRadiusM);
    if (candidateIds.size === 0) return null;

    let best: SegmentHit | null = null;
    let sticky: SegmentHit | null = null;
    let examined = 0;
    const maxCandidates = options.maxCandidates ?? Number.POSITIVE_INFINITY;

    for (const segmentId of candidateIds) {
      if (examined++ >= maxCandidates) break;
      const hit = this.hit(segmentId, point);
      if (!best || hit.distanceM < best.distanceM) best = hit;
      if (currentLineId !== null && hit.lineId === currentLineId) {
        if (!sticky || hit.distanceM < sticky.distanceM) sticky = hit;
      }
    }

    if (sticky && sticky.distanceM <= stickyRadiusM) return this.toResult(sticky);
    if (best && best.distanceM <= radiusM) return this.toResult(best);
    return null;
  }
}

/**
 * Stateful wrapper around `SnapIndex` that remembers the current line and
 * applies hysteresis. Handy for pointer-move handlers.
 */
export class SnapTracker {
  private currentLineId: string | null = null;

  constructor(
    private readonly index: SnapIndex,
    private readonly options: SnapOptions = {},
  ) {}

  /** The line currently snapped to, or `null`. */
  get lineId(): string | null {
    return this.currentLineId;
  }

  snap(point: LonLat): SnapResult | null {
    const result = this.index.snap(point, {
      ...this.options,
      currentLineId: this.currentLineId,
    });
    this.currentLineId = result ? result.lineId : null;
    return result;
  }

  reset(): void {
    this.currentLineId = null;
  }
}
