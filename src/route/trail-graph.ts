/**
 * A routable graph built from trail polylines.
 *
 * Turrutebasen returns whole routes as independent `LineString`s; two routes that
 * meet on the ground usually share a vertex exactly, and sometimes end a few metres
 * apart. This module turns them into a node/edge graph and answers shortest-path
 * queries with A*.
 *
 * It deliberately does **not** invent connections: vertices are merged only when
 * they are within `mergeToleranceM` (haversine, metres), and a vertex is never
 * merged with the previous vertex of its own line (otherwise a densely sampled
 * trail would collapse into one node). Routes that cross without a shared or
 * near-shared vertex stay disconnected; the caller reports "no path" rather than
 * drawing a line across terrain.
 *
 * The data source is not part of the contract: any `TrailLine[]` works, so an OSM
 * graph can replace Turrutebasen without touching the router.
 */
import { haversine, type LonLat } from '../core/geo';

export interface TrailLine {
  /** Stable id from the source; used for provenance on the routed edges. */
  readonly id: string;
  readonly points: readonly LonLat[];
}

export interface TrailGraphOptions {
  /**
   * Vertices closer than this are the same node. Default 5 m: Turrutebasen
   * vertices are decimetre-precise where routes meet, and 5 m leaves room for
   * export rounding without bridging parallel trails.
   */
  readonly mergeToleranceM?: number;
}

export interface TrailGraph {
  readonly nodes: readonly LonLat[];
  readonly toleranceM: number;
  /** CSR adjacency: node i's neighbours are `edgeTo[edgeStart[i]..edgeStart[i+1])`. */
  readonly edgeStart: readonly number[];
  readonly edgeTo: readonly number[];
  /** Edge length in metres (haversine). */
  readonly edgeWeight: readonly number[];
  /** Source line id per directed edge. */
  readonly edgeLine: readonly (string | null)[];
}

export interface TrailPath {
  /** Node indices, start to end inclusive. */
  readonly nodes: readonly number[];
  readonly distanceM: number;
}

const DEFAULT_MERGE_TOLERANCE_M = 5;
/** Degrees of latitude per metre, near enough for a spatial hash cell. */
const DEG_PER_METRE = 1 / 111_320;

interface PendingEdge {
  readonly to: number;
  readonly weight: number;
  readonly line: string;
}

/**
 * Build the undirected graph.
 *
 * Complexity is O(vertices) expected: the spatial hash means each vertex only
 * checks a handful of neighbours, not the whole node list.
 */
export function buildTrailGraph(
  lines: readonly TrailLine[],
  options: TrailGraphOptions = {},
): TrailGraph {
  const toleranceM = options.mergeToleranceM ?? DEFAULT_MERGE_TOLERANCE_M;
  if (!(toleranceM > 0)) throw new RangeError(`merge tolerance must be positive, got ${toleranceM}`);

  const nodes: LonLat[] = [];
  const grid = new Map<string, number[]>();
  // Cell side in degrees. Slightly larger than the tolerance so a nearby vertex
  // is never more than two cells away at Norwegian latitudes (lon degrees are
  // shorter than lat degrees above the equator).
  const cellDeg = (toleranceM * 2) * DEG_PER_METRE;
  const edges: PendingEdge[][] = [];

  const keyOf = (point: LonLat): string =>
    `${Math.floor(point.lon / cellDeg)},${Math.floor(point.lat / cellDeg)}`;

  const findNode = (point: LonLat, previousOfLine: number | null): number | null => {
    const cx = Math.floor(point.lon / cellDeg);
    const cy = Math.floor(point.lat / cellDeg);
    let best: number | null = null;
    let bestDistance = toleranceM;
    for (let dx = -2; dx <= 2; dx += 1) {
      for (let dy = -2; dy <= 2; dy += 1) {
        const bucket = grid.get(`${cx + dx},${cy + dy}`);
        if (!bucket) continue;
        for (const candidate of bucket) {
          if (candidate === previousOfLine) continue;
          const distance = haversine(point, nodes[candidate] as LonLat);
          if (distance <= bestDistance) {
            best = candidate;
            bestDistance = distance;
          }
        }
      }
    }
    return best;
  };

  const addNode = (point: LonLat): number => {
    const index = nodes.length;
    nodes.push(point);
    edges.push([]);
    const key = keyOf(point);
    const bucket = grid.get(key);
    if (bucket) bucket.push(index);
    else grid.set(key, [index]);
    return index;
  };

  const connect = (from: number, to: number, weight: number, line: string): void => {
    if (from === to || !(weight > 0)) return;
    (edges[from] as PendingEdge[]).push({ to, weight, line });
    (edges[to] as PendingEdge[]).push({ to: from, weight, line });
  };

  for (const line of lines) {
    let previous: number | null = null;
    for (const point of line.points) {
      if (!Number.isFinite(point.lon) || !Number.isFinite(point.lat)) continue;
      const existing = findNode(point, previous);
      const node = existing ?? addNode(point);
      if (previous !== null) {
        connect(previous, node, haversine(nodes[previous] as LonLat, nodes[node] as LonLat), line.id);
      }
      previous = node;
    }
  }

  const edgeStart = new Array<number>(nodes.length + 1).fill(0);
  for (let i = 0; i < nodes.length; i += 1) edgeStart[i + 1] = (edgeStart[i] as number) + (edges[i] as PendingEdge[]).length;
  const edgeTo = new Array<number>(edgeStart[nodes.length] as number);
  const edgeWeight = new Array<number>(edgeTo.length);
  const edgeLine = new Array<string | null>(edgeTo.length).fill(null);
  for (let i = 0; i < nodes.length; i += 1) {
    let cursor = edgeStart[i] as number;
    for (const edge of edges[i] as PendingEdge[]) {
      edgeTo[cursor] = edge.to;
      edgeWeight[cursor] = edge.weight;
      edgeLine[cursor] = edge.line;
      cursor += 1;
    }
  }

  return { nodes, toleranceM, edgeStart, edgeTo, edgeWeight, edgeLine };
}

/** Nearest node within `maxDistanceM`, or `null`. Linear: graphs here are small. */
export function nearestNode(
  graph: TrailGraph,
  point: LonLat,
  maxDistanceM: number,
): { node: number; distanceM: number } | null {
  let best: number | null = null;
  let bestDistance = maxDistanceM;
  for (let i = 0; i < graph.nodes.length; i += 1) {
    const distance = haversine(point, graph.nodes[i] as LonLat);
    if (distance <= bestDistance) {
      best = i;
      bestDistance = distance;
    }
  }
  return best === null ? null : { node: best, distanceM: bestDistance };
}

/** Node coordinates for a path. */
export function pathPoints(graph: TrailGraph, path: TrailPath): LonLat[] {
  return path.nodes.map((index) => graph.nodes[index] as LonLat);
}

interface HeapEntry {
  readonly node: number;
  readonly score: number;
}

/** Minimal binary min-heap: A* over a few thousand nodes does not need more. */
class MinHeap {
  private readonly items: HeapEntry[] = [];

  get size(): number {
    return this.items.length;
  }

  push(entry: HeapEntry): void {
    this.items.push(entry);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if ((this.items[parent] as HeapEntry).score <= (this.items[index] as HeapEntry).score) break;
      [this.items[parent], this.items[index]] = [this.items[index] as HeapEntry, this.items[parent] as HeapEntry];
      index = parent;
    }
  }

  pop(): HeapEntry | null {
    const first = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0 && last) {
      this.items[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < this.items.length && (this.items[left] as HeapEntry).score < (this.items[smallest] as HeapEntry).score) smallest = left;
        if (right < this.items.length && (this.items[right] as HeapEntry).score < (this.items[smallest] as HeapEntry).score) smallest = right;
        if (smallest === index) break;
        [this.items[smallest], this.items[index]] = [this.items[index] as HeapEntry, this.items[smallest] as HeapEntry];
        index = smallest;
      }
    }
    return first ?? null;
  }
}

/**
 * A* shortest path by distance. The heuristic is the straight-line distance to
 * the goal, which can never exceed the trail distance, so the result is optimal.
 * Returns `null` when no trail connects the two nodes.
 */
export function findPath(graph: TrailGraph, from: number, to: number): TrailPath | null {
  if (from < 0 || to < 0 || from >= graph.nodes.length || to >= graph.nodes.length) {
    throw new RangeError(`node index out of range: ${from}, ${to}`);
  }
  if (from === to) return { nodes: [from], distanceM: 0 };

  const goal = graph.nodes[to] as LonLat;
  const gScore = new Float64Array(graph.nodes.length).fill(Number.POSITIVE_INFINITY);
  const cameFrom = new Int32Array(graph.nodes.length).fill(-1);
  const closed = new Uint8Array(graph.nodes.length);
  const open = new MinHeap();
  gScore[from] = 0;
  open.push({ node: from, score: haversine(graph.nodes[from] as LonLat, goal) });

  while (open.size > 0) {
    const current = open.pop() as HeapEntry;
    if (closed[current.node]) continue;
    if (current.node === to) break;
    closed[current.node] = 1;
    const start = graph.edgeStart[current.node] as number;
    const end = graph.edgeStart[current.node + 1] as number;
    for (let edge = start; edge < end; edge += 1) {
      const next = graph.edgeTo[edge] as number;
      if (closed[next]) continue;
      const tentative = (gScore[current.node] as number) + (graph.edgeWeight[edge] as number);
      if (tentative < (gScore[next] as number)) {
        gScore[next] = tentative;
        cameFrom[next] = current.node;
        open.push({
          node: next,
          score: tentative + haversine(graph.nodes[next] as LonLat, goal),
        });
      }
    }
  }

  if (!Number.isFinite(gScore[to])) return null;
  const nodes: number[] = [];
  for (let cursor = to; cursor !== -1; cursor = cameFrom[cursor] as number) {
    nodes.push(cursor);
    if (cursor === from) break;
  }
  nodes.reverse();
  return { nodes, distanceM: gScore[to] as number };
}
