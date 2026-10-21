/**
 * Reroute a span of a leg onto the trail network.
 *
 * This is **re-snapping, not routing**. It can only ever move geometry onto
 * trails that are already in the index; it never invents a path, never bridges
 * two unconnected trails, and never guesses what a missing stretch would have
 * looked like. What it does, precisely:
 *
 * 1. Each vertex in `[from..to]` independently asks the (pre-populated)
 *    `SnapIndex` for the nearest trail point within `radiusM` (default 75 m).
 *    No hysteresis: a vertex more than `radiusM` from every trail stays put,
 *    which is what makes the radius mean what it says.
 * 2. A snapped vertex moves to the snapped position. Its elevation is kept
 *    verbatim — the snapped point is a few tens of metres away and re-sampling
 *    elevation is the UI's job, not the editor's.
 * 3. A run of ≥2 consecutive vertices that snapped to the **same** `lineId` is
 *    replaced by the corresponding stretch of that line's own polyline, walked
 *    in the direction the route travels. So a route that cuts a corner across a
 *    switchback follows the switchback.
 * 4. Runs on **different** lines are never joined. Each run gets its own
 *    stretch, the vertices between them are left exactly as they were, and the
 *    leg records `{kind:'edited', label:'off-trail gap'}`.
 * 5. If nothing snaps at all, the geometry is returned untouched and the leg
 *    records `{kind:'edited', label:'off-trail'}`.
 *
 * Synchronous, offline, no I/O: `SnapIndex` is populated by the caller.
 */

import type { ElevationSource, Leg, RoutePoint, Trip } from '../contracts';
import { cumulativeDistances } from '../core/geo';
import type { LonLat } from '../core/geo';
import type { SnapIndex, SnapResult } from '../snap';
import { RouteEditError } from './errors';
import { recomputeLeg } from './metrics';
import { copyPoint } from './points';
import {
  EDITED_MARKER,
  OFF_TRAIL_GAP_LABEL,
  OFF_TRAIL_LABEL,
  SNAPPED_MARKER,
  appendProvenance,
  ensureProvenance,
} from './provenance';
import { nextUpdatedAt } from './time';

/** Default snap radius for rerouting, metres. Matches the snapping engine. */
export const DEFAULT_REROUTE_RADIUS_M = 75;

export interface RerouteOptions {
  /** Maximum distance from a vertex to a trail, metres. Default 75. */
  radiusM?: number;
  /** Pre-populated trail index. Required: rerouting never fetches. */
  snapIndex: SnapIndex;
  /** Clock for `updatedAt` (inject it in tests). Default `() => new Date()`. */
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

interface LinePosition {
  segmentIndex: number;
  t: number;
}

/** Scalar position along a polyline measured in vertex indices. */
function positionOnLine(position: LinePosition): number {
  return position.segmentIndex + position.t;
}

function interpolateOnLine(coords: readonly LonLat[], position: LinePosition): LonLat {
  const a = coords[position.segmentIndex];
  const b = coords[position.segmentIndex + 1];
  if (!b) return { lon: a.lon, lat: a.lat };
  return {
    lon: a.lon + (b.lon - a.lon) * position.t,
    lat: a.lat + (b.lat - a.lat) * position.t,
  };
}

/**
 * The stretch of `coords` between two positions on it, walked from `first` to
 * `last`. Integer vertices strictly between the two positions are included, so
 * bends of the trail survive; the endpoints are interpolated exactly on the
 * line. Direction follows travel, not the line's digitisation order.
 */
function stretchAlong(coords: readonly LonLat[], first: LinePosition, last: LinePosition): LonLat[] {
  const n = coords.length;
  const pFirst = positionOnLine(first);
  const pLast = positionOnLine(last);
  const out: LonLat[] = [interpolateOnLine(coords, first)];
  if (pFirst === pLast) return out;

  const forward = pLast > pFirst;
  const startVertex = forward ? Math.floor(pFirst) + 1 : Math.ceil(pFirst) - 1;
  const endVertex = forward ? Math.ceil(pLast) - 1 : Math.floor(pLast) + 1;
  const step = forward ? 1 : -1;
  for (let vertex = startVertex; forward ? vertex <= endVertex : vertex >= endVertex; vertex += step) {
    if (vertex > 0 && vertex < n) {
      out.push({ lon: coords[vertex].lon, lat: coords[vertex].lat });
    }
  }
  out.push(interpolateOnLine(coords, last));
  return out;
}

function round01(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Turn a stretch of trail geometry into route points.
 *
 * Elevation of the run's own first/last vertex is preserved; vertices the
 * reroute inserts get elevation linearly interpolated along the stretch
 * between those two, rounded to 0.1 m. That keeps the leg's ascent/descent
 * meaningful without pretending the intermediate points were sampled; the UI
 * re-samples from the DEM afterwards. If either endpoint has no elevation, the
 * inserted vertices get `eleSource:'none'` and no `ele` at all.
 */
function stretchToPoints(
  geometry: readonly LonLat[],
  startPoint: RoutePoint,
  endPoint: RoutePoint,
): RoutePoint[] {
  const distances = cumulativeDistances(geometry);
  const total = distances[distances.length - 1] ?? 0;
  const eleA = startPoint.ele;
  const eleB = endPoint.ele;
  const canInterpolate = eleA !== undefined && eleB !== undefined && total > 0;
  const insertedSource: ElevationSource = startPoint.eleSource ?? endPoint.eleSource ?? 'none';

  return geometry.map((vertex, index) => {
    const isFirst = index === 0;
    const isLast = index === geometry.length - 1;
    const source = isFirst ? startPoint : isLast ? endPoint : undefined;
    const ele = source ? source.ele : canInterpolate ? round01((eleA as number) + ((eleB as number) - (eleA as number)) * (distances[index] / total)) : undefined;
    const point: { lon: number; lat: number; ele?: number; eleSource?: ElevationSource } = {
      lon: vertex.lon,
      lat: vertex.lat,
    };
    if (ele !== undefined) {
      point.ele = ele;
      point.eleSource = source?.eleSource ?? insertedSource;
    } else {
      point.eleSource = 'none';
    }
    return point;
  });
}

/** A single snapped vertex: new position, elevation untouched, and marked snapped. */
function snappedVertex(original: RoutePoint, snap: SnapResult): RoutePoint {
  const point: {
    lon: number;
    lat: number;
    ele?: number;
    eleSource?: ElevationSource;
    snapped?: boolean;
  } = {
    lon: snap.snappedPoint.lon,
    lat: snap.snappedPoint.lat,
    // Per-vertex provenance (D5): this vertex is on a trail, and the ones the
    // re-snap could not place are not — a leg-level flag could not say that.
    snapped: true,
  };
  if (original.ele !== undefined) point.ele = original.ele;
  if (original.eleSource !== undefined) point.eleSource = original.eleSource;
  return point;
}

/** Drop consecutive vertices at exactly the same position (zero-length legs). */
function dedupeConsecutive(points: readonly RoutePoint[]): RoutePoint[] {
  const out: RoutePoint[] = [];
  for (const point of points) {
    const previous = out[out.length - 1];
    if (previous && previous.lon === point.lon && previous.lat === point.lat) continue;
    out.push(point);
  }
  return out;
}

// ---------------------------------------------------------------------------
// rerouteSpan
// ---------------------------------------------------------------------------

/**
 * Re-snap `legId`'s `points[from..to]` onto the trail index and return a new
 * trip. Throws `RouteEditError` for an unknown leg, a bad span, or a missing
 * index — always before touching anything.
 */
export function rerouteSpan(
  trip: Trip,
  legId: string,
  from: number,
  to: number,
  opts: RerouteOptions,
): Trip {
  const radiusM = opts.radiusM ?? DEFAULT_REROUTE_RADIUS_M;
  if (!Number.isFinite(radiusM) || !(radiusM > 0)) {
    throw new RangeError(`rerouteSpan: radiusM must be a positive finite number, got ${radiusM}`);
  }
  const snapIndex = opts.snapIndex;
  if (!snapIndex || typeof snapIndex.snap !== 'function') {
    throw new RouteEditError('invalid-command', 'rerouteSpan requires a SnapIndex in opts.snapIndex');
  }

  const legIndex = trip.legs.findIndex((leg) => leg.id === legId);
  if (legIndex < 0) {
    throw new RouteEditError('unknown-leg', `leg '${legId}' is not part of trip '${trip.id}'`);
  }
  const leg = trip.legs[legIndex];
  const pointCount = leg.points.length;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > pointCount - 1 || from > to) {
    throw new RouteEditError(
      'index-out-of-range',
      `rerouteSpan on leg '${leg.id}': span ${String(from)}..${String(to)} is not a valid span of ` +
        `${pointCount} points`,
    );
  }

  const now = opts.now ? opts.now() : new Date();

  const snaps: (SnapResult | null)[] = [];
  for (let index = from; index <= to; index++) {
    const point = leg.points[index];
    snaps.push(snapIndex.snap({ lon: point.lon, lat: point.lat }, { radiusM }));
  }

  const snapCount = snaps.reduce((count, snap) => (snap ? count + 1 : count), 0);

  // Nothing within R: leave the geometry exactly as it was and say so.
  if (snapCount === 0) {
    const provenance = ensureProvenance(leg.provenance, {
      kind: 'edited',
      label: OFF_TRAIL_LABEL,
      modified: true,
    });
    const nextLeg: Leg = recomputeLeg({ ...leg, provenance });
    const legs = [...trip.legs.slice(0, legIndex), nextLeg, ...trip.legs.slice(legIndex + 1)];
    return { ...trip, legs, updatedAt: nextUpdatedAt(trip.updatedAt, now) };
  }

  // Walk the span, replacing same-trail runs with the trail's own polyline.
  const spanOut: RoutePoint[] = [];
  const distinctLines = new Set<string>();
  let index = 0;
  while (index < snaps.length) {
    const snap = snaps[index];
    if (!snap) {
      spanOut.push(copyPoint(leg.points[from + index]));
      index += 1;
      continue;
    }

    let runEnd = index;
    while (runEnd + 1 < snaps.length) {
      const next = snaps[runEnd + 1];
      if (!next || next.lineId !== snap.lineId) break;
      runEnd += 1;
    }
    distinctLines.add(snap.lineId);

    const originalStart = leg.points[from + index];
    const originalEnd = leg.points[from + runEnd];
    const line = snapIndex.getLine(snap.lineId);
    const firstSnap = snaps[index] as SnapResult;
    const lastSnap = snaps[runEnd] as SnapResult;

    if (runEnd === index || !line) {
      // One vertex on this trail (or a line the index no longer holds): just
      // move it. There is no stretch to follow.
      for (let k = index; k <= runEnd; k++) {
        spanOut.push(snappedVertex(leg.points[from + k], snaps[k] as SnapResult));
      }
    } else {
      const geometry = stretchAlong(line.coords, firstSnap, lastSnap);
      // Pin the ends to the exact snapped positions rather than the
      // interpolated ones (same value up to float error).
      geometry[0] = { lon: firstSnap.snappedPoint.lon, lat: firstSnap.snappedPoint.lat };
      geometry[geometry.length - 1] = {
        lon: lastSnap.snappedPoint.lon,
        lat: lastSnap.snappedPoint.lat,
      };
      spanOut.push(...stretchToPoints(geometry, originalStart, originalEnd));
    }

    index = runEnd + 1;
  }

  const inserted = dedupeConsecutive(spanOut);
  const points = [
    ...leg.points.slice(0, from),
    ...inserted,
    ...leg.points.slice(to + 1),
  ];
  if (points.length < 2) {
    throw new RouteEditError(
      'leg-too-short',
      `rerouteSpan on leg '${leg.id}' would leave ${points.length} point(s); a leg needs at least 2`,
    );
  }

  let provenance = appendProvenance(leg.provenance, EDITED_MARKER);
  provenance = ensureProvenance(provenance, SNAPPED_MARKER);
  if (distinctLines.size >= 2 || snapCount < snaps.length) {
    provenance = ensureProvenance(provenance, {
      kind: 'edited',
      label: OFF_TRAIL_GAP_LABEL,
      modified: true,
    });
  }

  const nextLeg: Leg = recomputeLeg({ ...leg, points, provenance });
  const legs = [...trip.legs.slice(0, legIndex), nextLeg, ...trip.legs.slice(legIndex + 1)];
  return { ...trip, legs, updatedAt: nextUpdatedAt(trip.updatedAt, now) };
}
