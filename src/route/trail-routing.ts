/**
 * Point-to-point routing on a trail graph.
 *
 * The two clicked points are not trail vertices, so each is projected onto the
 * nearest trail segment within a stated radius and becomes a temporary node. The
 * route then runs from projection to projection; the returned polyline starts and
 * ends exactly where the user's points were snapped, never at an arbitrary
 * segment endpoint.
 *
 * Every failure is a code the UI can translate. There is deliberately no
 * straight-line fallback: if no trail is near a point, or the network is
 * disconnected, the caller is told which one it was.
 */
import { haversine, type LonLat } from '../core/geo';
import {
  buildTrailGraph,
  findPath,
  pathPoints,
  type TrailGraph,
  type TrailGraphOptions,
  type TrailLine,
} from './trail-graph';

export type RoutingFailureCode =
  | 'no-trail-near-start'
  | 'no-trail-near-end'
  | 'no-path'
  | 'area-too-large'
  | 'network-unavailable';

export type RouteBetweenResult =
  | {
      readonly kind: 'ok';
      readonly points: readonly LonLat[];
      readonly distanceM: number;
      /** Where each endpoint actually snapped, for the UI and provenance. */
      readonly snappedStart: LonLat;
      readonly snappedEnd: LonLat;
    }
  | { readonly kind: 'failed'; readonly code: RoutingFailureCode };

export interface RouteBetweenOptions extends TrailGraphOptions {
  /** How far a clicked point may be from a trail. Default 250 m. */
  readonly maxSnapDistanceM?: number;
}

interface Projection {
  /** CSR edge index; `(from,to)` is that edge's direction. */
  readonly edge: number;
  readonly from: number;
  readonly to: number;
  /** Position along the edge, 0 at `from`, 1 at `to`. */
  readonly t: number;
  readonly point: LonLat;
  readonly distanceM: number;
}

const DEFAULT_MAX_SNAP_M = 250;

/**
 * Closest point on segment a→b, in a local equirectangular frame. The frame is
 * only used to find the position along the segment; all reported distances are
 * haversine metres.
 */
function projectOnSegment(point: LonLat, a: LonLat, b: LonLat): { t: number; point: LonLat } {
  const cosLat = Math.cos((point.lat * Math.PI) / 180);
  const ax = (a.lon - point.lon) * cosLat;
  const ay = a.lat - point.lat;
  const bx = (b.lon - point.lon) * cosLat;
  const by = b.lat - point.lat;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  if (!(lengthSquared > 0)) return { t: 0, point: a };
  const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared));
  return {
    t,
    point: { lon: a.lon + (b.lon - a.lon) * t, lat: a.lat + (b.lat - a.lat) * t },
  };
}

/** Nearest trail segment within `maxDistanceM`, scanning the CSR edges. */
function nearestEdge(graph: TrailGraph, point: LonLat, maxDistanceM: number): Projection | null {
  let best: Projection | null = null;
  for (let from = 0; from < graph.nodes.length; from += 1) {
    const start = graph.edgeStart[from] as number;
    const end = graph.edgeStart[from + 1] as number;
    for (let edge = start; edge < end; edge += 1) {
      const to = graph.edgeTo[edge] as number;
      const { t, point: projected } = projectOnSegment(
        point,
        graph.nodes[from] as LonLat,
        graph.nodes[to] as LonLat,
      );
      const distanceM = haversine(point, projected);
      if (distanceM <= maxDistanceM && (best === null || distanceM < best.distanceM)) {
        best = { edge, from, to, t, point: projected, distanceM };
      }
    }
  }
  return best;
}

interface PendingEdge {
  readonly to: number;
  readonly weight: number;
  readonly line: string | null;
}

/**
 * Copy the graph and append a node on each projected edge, connected to both of
 * that edge's endpoints with proportional weights. Keeping the original edge is
 * harmless: travelling it is never cheaper than the split path, and it remains
 * a real trail.
 *
 * When both points land on the same segment, a direct virtual edge is added so a
 * short route along that segment is not detoured through its endpoints.
 */
function withSnapNodes(
  graph: TrailGraph,
  start: Projection,
  end: Projection,
): { graph: TrailGraph; startNode: number; endNode: number } {
  const startNode = graph.nodes.length;
  const endNode = graph.nodes.length + 1;
  const nodes: LonLat[] = [...graph.nodes, start.point, end.point];
  const adjacency: PendingEdge[][] = nodes.map(() => []);

  for (let from = 0; from < graph.nodes.length; from += 1) {
    const begin = graph.edgeStart[from] as number;
    const stop = graph.edgeStart[from + 1] as number;
    for (let edge = begin; edge < stop; edge += 1) {
      (adjacency[from] as PendingEdge[]).push({
        to: graph.edgeTo[edge] as number,
        weight: graph.edgeWeight[edge] as number,
        line: graph.edgeLine[edge] ?? null,
      });
    }
  }

  const addEdge = (a: number, b: number, weight: number, line: string | null): void => {
    if (a === b || !(weight > 0)) return;
    (adjacency[a] as PendingEdge[]).push({ to: b, weight, line });
    (adjacency[b] as PendingEdge[]).push({ to: a, weight, line });
  };

  const attachProjection = (node: number, projection: Projection): number => {
    const length = graph.edgeWeight[projection.edge] as number;
    const line = graph.edgeLine[projection.edge] ?? null;
    addEdge(node, projection.from, projection.t * length, line);
    addEdge(node, projection.to, (1 - projection.t) * length, line);
    return length;
  };

  const startLength = attachProjection(startNode, start);
  attachProjection(endNode, end);

  // Same physical segment: connect the projections directly. The two CSR edges
  // may run in opposite directions, so normalise the position before comparing.
  const sameSegment =
    (start.from === end.from && start.to === end.to) ||
    (start.from === end.to && start.to === end.from);
  if (sameSegment && startLength > 0) {
    // The two CSR edges may be the same segment in opposite directions. Express
    // both positions from the lower node id so the difference is meaningful.
    const low = Math.min(start.from, start.to);
    const position = (projection: Projection): number =>
      projection.from === low ? projection.t : 1 - projection.t;
    addEdge(
      startNode,
      endNode,
      Math.abs(position(start) - position(end)) * startLength,
      graph.edgeLine[start.edge] ?? null,
    );
  }

  const edgeStart = new Array<number>(nodes.length + 1).fill(0);
  for (let i = 0; i < nodes.length; i += 1) {
    edgeStart[i + 1] = (edgeStart[i] as number) + (adjacency[i] as PendingEdge[]).length;
  }
  const edgeTo = new Array<number>(edgeStart[nodes.length] as number);
  const edgeWeight = new Array<number>(edgeTo.length);
  const edgeLine = new Array<string | null>(edgeTo.length).fill(null);
  for (let i = 0; i < nodes.length; i += 1) {
    let cursor = edgeStart[i] as number;
    for (const edge of adjacency[i] as PendingEdge[]) {
      edgeTo[cursor] = edge.to;
      edgeWeight[cursor] = edge.weight;
      edgeLine[cursor] = edge.line;
      cursor += 1;
    }
  }
  return {
    graph: { nodes, toleranceM: graph.toleranceM, edgeStart, edgeTo, edgeWeight, edgeLine },
    startNode,
    endNode,
  };
}

/** Route between two arbitrary points. */
export function routeBetweenPoints(
  graph: TrailGraph,
  start: LonLat,
  end: LonLat,
  options: RouteBetweenOptions = {},
): RouteBetweenResult {
  const maxSnap = options.maxSnapDistanceM ?? DEFAULT_MAX_SNAP_M;
  if (!(maxSnap > 0)) throw new RangeError(`maxSnapDistanceM must be positive, got ${maxSnap}`);

  const startProjection = nearestEdge(graph, start, maxSnap);
  if (!startProjection) return { kind: 'failed', code: 'no-trail-near-start' };
  const endProjection = nearestEdge(graph, end, maxSnap);
  if (!endProjection) return { kind: 'failed', code: 'no-trail-near-end' };

  const extended = withSnapNodes(graph, startProjection, endProjection);
  const path = findPath(extended.graph, extended.startNode, extended.endNode);
  if (!path) return { kind: 'failed', code: 'no-path' };

  return {
    kind: 'ok',
    points: pathPoints(extended.graph, path),
    distanceM: path.distanceM,
    snappedStart: startProjection.point,
    snappedEnd: endProjection.point,
  };
}

/** Build and route in one step; used by tests and by the network loader's caller. */
export function routeBetweenLines(
  lines: readonly TrailLine[],
  start: LonLat,
  end: LonLat,
  options: RouteBetweenOptions = {},
): RouteBetweenResult {
  const graph = buildTrailGraph(lines, { mergeToleranceM: options.mergeToleranceM });
  return routeBetweenPoints(graph, start, end, options);
}
