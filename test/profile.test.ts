import { describe, expect, it } from 'vitest';

import { EARTH_RADIUS_M, type LonLat } from '../src/core/geo';
import {
  buildProfile,
  elevationGainLoss,
  gradeSeries,
  medianFilter,
  seaLevelWarning,
} from '../src/core/profile';

const DEG = Math.PI / 180;

/** A straight north–south route with (approximately) the given spacing. */
function route(pointCount: number, spacingM = 20): LonLat[] {
  const latStep = spacingM / (EARTH_RADIUS_M * DEG);
  return Array.from({ length: pointCount }, (_, i) => ({ lon: 8.3, lat: 61.6 + i * latStep }));
}

/**
 * Triangle wave: `cycles` oscillations of ±amplitude. Each peak/trough has a
 * 3-sample plateau so a 3-point median filter preserves the amplitude.
 */
function triangle(amplitude: number, samplesPerRamp: number, cycles: number): number[] {
  const plateau = 3;
  const period = 2 * (samplesPerRamp + plateau);
  const out: number[] = [];
  for (let i = 0; i < period * cycles; i++) {
    const phase = i % period;
    let value: number;
    if (phase < samplesPerRamp) value = (amplitude * phase) / samplesPerRamp;
    else if (phase < samplesPerRamp + plateau) value = amplitude;
    else if (phase < 2 * samplesPerRamp + plateau)
      value = (amplitude * (2 * samplesPerRamp + plateau - phase)) / samplesPerRamp;
    else value = 0;
    out.push(value);
  }
  return out;
}

describe('medianFilter', () => {
  it('removes a single spike, keeps a monotonic slope and rejects an even window', () => {
    const values = new Array<number>(100).fill(100);
    values[50] = 600;
    expect(medianFilter(values, 3).every((v) => v === 100)).toBe(true);

    const slope = Array.from({ length: 20 }, (_, i) => i * 10);
    expect(medianFilter(slope, 3)).toEqual(slope);

    expect(() => medianFilter([1, 2, 3], 4)).toThrow(RangeError);
  });
});

describe('elevationGainLoss — hysteresis state machine', () => {
  it('ignores sub-threshold noise, counts real swings in full, and returns zero below two samples', () => {
    // ±3 m sawtooth with a 5 m threshold: nothing is counted.
    const sawtooth = Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? 0 : 3));
    expect(elevationGainLoss(sawtooth, 5)).toEqual({ ascentM: 0, descentM: 0 });

    // ±20 m sawtooth: 50 rises of 20 m; the last rise is still open at the end.
    const big = Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? 0 : 20));
    const { ascentM, descentM } = elevationGainLoss(big, 5);
    expect(ascentM).toBe(1000);
    expect(descentM).toBe(980);

    // A 100 m climb with ±1 m noise: hysteresis must not accumulate the noise.
    const noisyClimb: number[] = [];
    for (let i = 0; i <= 100; i++) noisyClimb.push(i + (i % 2 === 0 ? 1 : -1));
    const clean = elevationGainLoss(noisyClimb, 5);
    expect(clean.ascentM).toBeGreaterThanOrEqual(99);
    expect(clean.ascentM).toBeLessThanOrEqual(102);
    expect(clean.descentM).toBe(0);

    expect(elevationGainLoss([], 5)).toEqual({ ascentM: 0, descentM: 0 });
    expect(elevationGainLoss([100], 5)).toEqual({ ascentM: 0, descentM: 0 });
  });
});

describe('gradeSeries', () => {
  it('computes mean grade over a window and damps a one-sample spike', () => {
    // 100 m rise over 1000 m, sampled every 100 m → 10 % everywhere.
    const distances = Array.from({ length: 11 }, (_, i) => i * 100);
    const elevations = distances.map((d) => d * 0.1);
    for (const g of gradeSeries(distances, elevations, 100)) expect(g).toBeCloseTo(10, 6);

    // A +1000 % point-to-point spike is never reported as a per-sample grade.
    const spiked = gradeSeries([0, 10, 20, 30, 40], [0, 0, 100, 0, 0], 100);
    for (const g of spiked) expect(Math.abs(g)).toBeLessThan(100);
  });
});

describe('buildProfile', () => {
  it('counts a clean climb and descent, and removes median-filter noise and single spikes', () => {
    const coords = route(202, 20); // ~4 km
    // Up 100 m over the first half, down 100 m over the second.
    const elevations = Array.from({ length: 202 }, (_, i) =>
      i <= 101 ? (100 * i) / 101 : (100 * (202 - i)) / 101,
    );
    const profile = buildProfile(coords, elevations, { hysteresisM: 5 });
    expect(profile.distanceM).toBeGreaterThan(3900);
    expect(profile.distanceM).toBeLessThan(4100);
    expect(profile.ascentM).toBeGreaterThan(98);
    expect(profile.ascentM).toBeLessThan(102);
    expect(profile.descentM).toBeGreaterThan(97);
    expect(profile.descentM).toBeLessThan(102);
    expect(profile.maxGradePct).toBeGreaterThan(0);
    expect(profile.minGradePct).toBeLessThan(0);

    // A ±3 m triangle wave is not ascent; ±20 m is counted in full.
    const small = triangle(3, 30, 5);
    expect(buildProfile(route(small.length, 20), small, { hysteresisM: 5 })).toMatchObject({
      ascentM: 0,
      descentM: 0,
    });
    const large = triangle(20, 30, 5);
    const largeProfile = buildProfile(route(large.length, 20), large, { hysteresisM: 5 });
    expect(largeProfile.ascentM).toBeGreaterThan(99);
    expect(largeProfile.ascentM).toBeLessThanOrEqual(100);
    expect(largeProfile.descentM).toBeGreaterThan(99);
    expect(largeProfile.descentM).toBeLessThanOrEqual(100);

    // A single 500 m DEM spike is filtered before it can become ascent.
    const spiked = new Array<number>(101).fill(1000);
    spiked[50] = 1500;
    const spikeProfile = buildProfile(route(101, 20), spiked, { hysteresisM: 5 });
    expect(spikeProfile.ascentM).toBe(0);
    expect(spikeProfile.descentM).toBe(0);
    expect(spikeProfile.samples.every((s) => s.ele === 1000)).toBe(true);
  });

  it('fills NoData gaps, refuses an all-NoData series, and validates its input', () => {
    const profile = buildProfile(route(6, 20), [100, 100, Number.NaN, Number.NaN, 100, 100]);
    expect(profile.filledSamples).toBe(2);
    expect(profile.samples.map((s) => s.ele)).toEqual([100, 100, 100, 100, 100, 100]);

    expect(() => buildProfile(route(10), new Array<number>(10).fill(Number.NaN))).toThrow(
      /every elevation is NoData/,
    );
    expect(() => buildProfile(route(3), [1, 2])).toThrow(/same length/);
    expect(() => buildProfile(route(3), [1, 2, 3], { medianWindow: 4 })).toThrow(RangeError);
    expect(buildProfile([], [])).toEqual({
      samples: [],
      ascentM: 0,
      descentM: 0,
      maxGradePct: 0,
      minGradePct: 0,
      distanceM: 0,
      filledSamples: 0,
      seaLevelM: 0,
    });
  });
});

describe('sea level', () => {
  it('measures the longest stretch at sea level, because 0 m over water is not terrain', () => {
    // 7 points, 200 m apart: high, high, then four at sea level, then high.
    const coords = route(7, 200);
    const profile = buildProfile(coords, [1200, 1200, 0, 0, 0, 0, 1200]);
    // The run spans from the first 0 m sample to the last: 3 * 200 m.
    expect(profile.seaLevelM).toBeCloseTo(600, 0);

    // A route that never touches the sea reports nothing.
    expect(buildProfile(route(4, 200), [800, 795, 790, 785]).seaLevelM).toBe(0);
    // Sea level throughout is a coastal walk, not a crossing, but it is still measured.
    const flat = buildProfile(route(4, 200), [0, 0, 0, 0]);
    expect(flat.seaLevelM).toBeCloseTo(600, 0);
    expect(flat.ascentM).toBe(0);
  });
});

describe('seaLevelWarning', () => {
  it('speaks only when the stretch is long and the route is otherwise high', () => {
    const crossing = buildProfile(route(7, 200), [1200, 1200, 0, 0, 0, 0, 1200]);
    expect(seaLevelWarning(crossing)).toBeCloseTo(600, 0);

    // A genuine coastal walk: at 0 m the whole way, nothing to warn about.
    expect(seaLevelWarning(buildProfile(route(4, 200), [0, 0, 0, 0]))).toBeNull();
    // A dip shorter than the threshold is a beach, not a crossing.
    const dip = buildProfile(route(9, 40), [1200, 1200, 0, 0, 0, 1200, 1200, 1200, 1200]);
    expect(dip.seaLevelM).toBeLessThan(300);
    expect(seaLevelWarning(dip)).toBeNull();
  });
});
