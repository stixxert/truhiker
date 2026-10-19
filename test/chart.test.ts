import { describe, expect, it } from 'vitest';

import {
  aggregateColumns,
  distanceAxis,
  elevationAtDistance,
  elevationAxis,
  elevationDomain,
  gradeAtDistance,
  indexAtDistance,
  niceStep,
} from '../src/lib/chart';
import type { ProfilePoint } from '../src/lib/chart';

function ramp(from: number, to: number, count: number, distanceM: number): ProfilePoint[] {
  return Array.from({ length: count }, (_, i) => ({
    d: (distanceM * i) / (count - 1),
    ele: from + ((to - from) * i) / (count - 1),
  }));
}

describe('elevationDomain', () => {
  it('returns the true min/max, enforces a minimum span, and survives an empty or NoData series', () => {
    expect(elevationDomain(ramp(900, 1400, 50, 1000))).toEqual({ min: 900, max: 1400 });

    // A flat route must not be drawn as a spike.
    const flat = elevationDomain(
      [
        { d: 0, ele: 1000 },
        { d: 10, ele: 1000 },
      ],
      100,
    );
    expect(flat.max - flat.min).toBeCloseTo(100, 6);
    expect((flat.min + flat.max) / 2).toBeCloseTo(1000, 6);

    expect(elevationDomain([])).toEqual({ min: 0, max: 100 });
    expect(elevationDomain([{ d: 0, ele: Number.NaN }], 40)).toEqual({ min: 0, max: 40 });
  });
});

describe('niceStep / elevationAxis / distanceAxis', () => {
  it('picks 1/2/2.5/5 multiples, pads the domain, and anchors the distance axis at zero', () => {
    expect(niceStep(500, 5)).toBe(100);
    expect(niceStep(120, 5)).toBe(25);
    expect(niceStep(3, 5)).toBe(1);

    const axis = elevationAxis(ramp(1037, 1583, 100, 5000), 5);
    expect(axis.step).toBe(200);
    // The domain is padded beyond the data, not clamped to it.
    expect(axis.min).toBeLessThan(1037);
    expect(axis.max).toBeGreaterThan(1583);
    expect(axis.ticks).toEqual([1200, 1400, 1600]);

    // A flat route stays readable instead of collapsing to a line.
    const flat = elevationAxis(
      [
        { d: 0, ele: 1000 },
        { d: 100, ele: 1000 },
      ],
      5,
    );
    expect(flat.max - flat.min).toBeGreaterThanOrEqual(100);
    expect(flat.ticks.length).toBeGreaterThanOrEqual(2);

    // The axis always covers the data and keeps the tick count bounded.
    const wide = elevationAxis(ramp(12, 3412, 500, 90_000), 6);
    expect(wide.min).toBeLessThanOrEqual(12);
    expect(wide.max).toBeGreaterThanOrEqual(3412);
    expect(wide.ticks.length).toBeLessThanOrEqual(8);
    for (const tick of wide.ticks) {
      expect(tick).toBeGreaterThanOrEqual(wide.min - 1e-9);
      expect(tick).toBeLessThanOrEqual(wide.max + 1e-9);
    }

    // The distance axis uses a round step anchored at zero, scales to 3,000 km
    // without producing 3,000 labels, and handles a degenerate distance.
    const { stepM, ticks } = distanceAxis(4212, 6);
    expect(stepM).toBe(1000);
    expect(ticks).toEqual([0, 1000, 2000, 3000, 4000]);

    const long = distanceAxis(3_000_000, 7);
    expect(long.stepM).toBe(500_000);
    expect(long.ticks.length).toBeLessThanOrEqual(7);
    expect(long.ticks[0]).toBe(0);
    expect(long.ticks[long.ticks.length - 1]).toBeLessThanOrEqual(3_000_000);

    expect(distanceAxis(0).ticks).toEqual([0]);
  });
});

describe('elevationAtDistance / gradeAtDistance', () => {
  const points = ramp(1000, 1200, 101, 10_000); // 2 % ramp

  it('interpolates, clamps beyond the ends, reports the windowed grade, and handles empty/single series', () => {
    expect(elevationAtDistance(points, 5000)).toBeCloseTo(1100, 6);
    expect(elevationAtDistance(points, 0)).toBeCloseTo(1000, 6);
    expect(elevationAtDistance(points, 1234)).toBeCloseTo(1024.68, 4);
    expect(elevationAtDistance(points, -500)).toBeCloseTo(1000, 6);
    expect(elevationAtDistance(points, 999_999)).toBeCloseTo(1200, 6);

    expect(gradeAtDistance(points, 5000, 100)).toBeCloseTo(2, 6);
    expect(gradeAtDistance(ramp(1200, 1000, 101, 10_000), 5000, 100)).toBeCloseTo(-2, 6);
    expect(gradeAtDistance(ramp(500, 500, 10, 1000), 500, 100)).toBeCloseTo(0, 6);

    expect(Number.isNaN(elevationAtDistance([], 10))).toBe(true);
    expect(gradeAtDistance([], 10)).toBe(0);
    expect(gradeAtDistance([{ d: 0, ele: 10 }], 0)).toBe(0);
  });
});

describe('indexAtDistance / aggregateColumns', () => {
  it('finds the nearest sample and keeps the full min/max envelope when downsampling', () => {
    const points = ramp(0, 100, 11, 1000);
    expect(indexAtDistance(points, 0)).toBe(0);
    expect(indexAtDistance(points, 99)).toBe(1);
    expect(indexAtDistance(points, 101)).toBe(1);
    expect(indexAtDistance(points, 1051)).toBe(10);
    expect(indexAtDistance([], 5)).toBe(-1);

    const zigzag: ProfilePoint[] = [];
    for (let i = 0; i < 10_000; i++) {
      const d = (i / 9999) * 100_000;
      // A fast zig-zag that would disappear with naive decimation.
      const ele = 1000 + (i % 7 === 0 ? 200 : 0) + Math.sin(i / 500) * 50;
      zigzag.push({ d, ele });
    }
    const columns = aggregateColumns(zigzag, 0, 100_000, 800);
    expect(columns).toHaveLength(800);
    expect(Math.min(...columns.map((c) => c.min))).toBeCloseTo(Math.min(...zigzag.map((p) => p.ele)), 6);
    expect(Math.max(...columns.map((c) => c.max))).toBeCloseTo(Math.max(...zigzag.map((p) => p.ele)), 6);

    // Columns with no samples are interpolated, so a short route spans the chart.
    const short = aggregateColumns(ramp(1000, 1100, 5, 40), 0, 40, 100);
    expect(short).toHaveLength(100);
    for (const column of short) {
      expect(Number.isFinite(column.min)).toBe(true);
      expect(Number.isFinite(column.max)).toBe(true);
    }
    expect(short[0]!.min).toBeCloseTo(1000, 6);
    expect(short[99]!.max).toBeCloseTo(1100, 6);

    // The requested distance range is covered exactly.
    const range = aggregateColumns(ramp(0, 100, 50, 5000), 0, 5000, 10);
    expect(range[0]!.d0).toBe(0);
    expect(range[9]!.d1).toBe(5000);

    // An empty profile yields NaN columns rather than throwing.
    const empty = aggregateColumns([], 0, 100, 4);
    expect(empty).toHaveLength(4);
    expect(Number.isNaN(empty[0]!.min)).toBe(true);
  });
});
