import { describe, expect, it } from 'vitest';

import { haversine, type LonLat } from '../../src/core/geo';
import {
  buildTrailGraph,
  findPath,
  nearestNode,
  pathPoints,
  type TrailLine,
} from '../../src/route/trail-graph';

const point = (lon: number, lat: number): LonLat => ({ lon, lat });
const line = (id: string, points: LonLat[]): TrailLine => ({ id, points });

const A = point(8.3, 61.5);
const B = point(8.31, 61.5);
const C = point(8.32, 61.5);
const D = point(8.31, 61.51);

describe('trail graph', () => {
  it('joins lines at a shared vertex and routes across the fork', () => {
    const graph = buildTrailGraph([
      line('west', [A, B, C]),
      line('north', [B, D]),
    ]);
    // A, B, C, D — B is shared, not duplicated.
    expect(graph.nodes).toHaveLength(4);

    const start = nearestNode(graph, C, 1)?.node;
    const end = nearestNode(graph, D, 1)?.node;
    expect(start).toBeDefined();
    expect(end).toBeDefined();

    const path = findPath(graph, start as number, end as number);
    expect(path).not.toBeNull();
    expect(path?.nodes.map((index) => graph.nodes[index])).toEqual([C, B, D]);
    const expected = haversine(C, B) + haversine(B, D);
    expect(path?.distanceM).toBeCloseTo(expected, 3);
    expect(pathPoints(graph, path!).every((p) => p.lon === C.lon || p.lon === B.lon || p.lon === D.lon)).toBe(true);
  });

  it('returns no path between disconnected components instead of bridging them', () => {
    const far = point(8.5, 61.5);
    const farther = point(8.51, 61.5);
    const graph = buildTrailGraph([
      line('west', [A, B]),
      line('east', [far, farther]),
    ]);
    const start = nearestNode(graph, B, 1)?.node as number;
    const end = nearestNode(graph, farther, 1)?.node as number;
    expect(findPath(graph, start, end)).toBeNull();
  });

  it('merges near-touching endpoints only within the stated tolerance', () => {
    // ~3.3 m north of B (1e-5 deg lat is about 1.11 m).
    const near = point(8.31, 61.50003);
    const loose = buildTrailGraph(
      [line('a', [A, B]), line('b', [near, C])],
      { mergeToleranceM: 10 },
    );
    expect(loose.nodes).toHaveLength(3);
    expect(findPath(loose, nearestNode(loose, A, 1)!.node, nearestNode(loose, C, 1)!.node)).not.toBeNull();

    const strict = buildTrailGraph(
      [line('a', [A, B]), line('b', [near, C])],
      { mergeToleranceM: 1 },
    );
    expect(strict.nodes).toHaveLength(4);
    expect(findPath(strict, nearestNode(strict, A, 1)!.node, nearestNode(strict, C, 1)!.node)).toBeNull();
  });

  it('keeps duplicate overlapping lines as parallel edges without collapsing geometry', () => {
    const graph = buildTrailGraph([
      line('one', [A, B, C]),
      line('two', [A, B, C]),
    ]);
    expect(graph.nodes).toHaveLength(3);
    // Four directed edges per distinct undirected pair (two lines, both ways).
    const degree = graph.edgeStart[2]! - graph.edgeStart[1]!;
    expect(degree).toBe(4);
    const path = findPath(graph, nearestNode(graph, A, 1)!.node, nearestNode(graph, C, 1)!.node);
    expect(path?.nodes).toHaveLength(3);
    expect(path?.distanceM).toBeCloseTo(haversine(A, B) + haversine(B, C), 3);
  });

  it('prefers the shorter of two connections', () => {
    const detour = point(8.305, 61.51);
    const graph = buildTrailGraph([
      line('direct', [A, B]),
      line('detour', [A, detour, B]),
    ]);
    const start = nearestNode(graph, A, 1)!.node;
    const end = nearestNode(graph, B, 1)!.node;
    const path = findPath(graph, start, end);
    expect(path?.nodes).toEqual([start, end]);
    expect(path?.distanceM).toBeCloseTo(haversine(A, B), 3);
  });

  it('nearestNode respects its radius and rejects invalid tolerances', () => {
    const graph = buildTrailGraph([line('a', [A, B])]);
    expect(nearestNode(graph, A, 0.5)?.distanceM).toBeCloseTo(0, 6);
    expect(nearestNode(graph, point(8.4, 61.6), 1000)).toBeNull();
    expect(() => buildTrailGraph([line('a', [A, B])], { mergeToleranceM: 0 })).toThrow(RangeError);
    expect(() => findPath(graph, -1, 0)).toThrow(RangeError);
  });
});
