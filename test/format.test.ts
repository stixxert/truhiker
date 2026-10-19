import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PACE,
  PACE_LIMITS,
  formatDistance,
  formatDistanceAxis,
  formatDuration,
  formatElevation,
  formatElevationRange,
  formatGrade,
  formatNumber,
  localeFor,
  naismithMinutes,
  normalizePace,
} from '../src/lib/format';

describe('formatNumber / localeFor', () => {
  it('uses Norwegian and English grouping and decimals, and renders non-finite values as an em dash', () => {
    expect(formatNumber(1234.5, 'no')).toBe('1\u00a0234,5');
    expect(formatNumber(1234.5, 'en')).toBe('1,234.5');
    expect(localeFor('no')).toBe('nb-NO');
    expect(localeFor('en')).toBe('en-GB');

    // Honesty: an unknown is never printed as NaN or 0.
    expect(formatNumber(Number.NaN, 'no')).toBe('—');
    expect(formatNumber(Number.POSITIVE_INFINITY, 'en')).toBe('—');
  });
});

describe('formatDistance', () => {
  it('switches to kilometres at 1 km, reduces precision as distance grows, and refuses bad input', () => {
    expect(formatDistance(0, 'no')).toBe('0 m');
    expect(formatDistance(999, 'no')).toBe('999 m');
    expect(formatDistance(1000, 'no')).toBe('1,00 km');
    expect(formatDistance(4212, 'no')).toBe('4,21 km');
    expect(formatDistance(42120, 'no')).toBe('42,1 km');
    expect(formatDistance(2_712_000, 'no')).toBe('2\u00a0712 km');
    expect(formatDistance(4212, 'en')).toBe('4.21 km');

    expect(formatDistance(-5, 'no')).toBe('—');
    expect(formatDistance(Number.NaN, 'no')).toBe('—');
  });
});

describe('formatDistanceAxis', () => {
  it('drops trailing zeros for chart ticks', () => {
    expect(formatDistanceAxis(0, 'no')).toBe('0 m');
    expect(formatDistanceAxis(500, 'no')).toBe('500 m');
    expect(formatDistanceAxis(1000, 'no')).toBe('1 km');
    expect(formatDistanceAxis(2500, 'no')).toBe('2,5 km');
    expect(formatDistanceAxis(2500, 'en')).toBe('2.5 km');
    expect(formatDistanceAxis(1_000_000, 'no')).toBe('1\u00a0000 km');
  });
});

describe('formatElevation', () => {
  it('uses "moh" in Norwegian, "m a.s.l." in English, and formats ranges with an en dash', () => {
    expect(formatElevation(2467.8, 'no')).toBe('2\u00a0468 moh');
    expect(formatElevation(2467.8, 'en')).toBe('2,468 m a.s.l.');
    expect(formatElevation(984.4, 'no', false)).toBe('984 m');
    expect(formatElevationRange(984.4, 2467.8, 'no')).toBe('984–2\u00a0468 moh');
  });
});

describe('formatDuration', () => {
  it('renders minutes below an hour, hours above, rounds, and rejects negatives', () => {
    expect(formatDuration(0, 'no')).toBe('0 min');
    expect(formatDuration(59.4, 'no')).toBe('59 min');
    expect(formatDuration(60, 'no')).toBe('1 t');
    expect(formatDuration(275, 'no')).toBe('4 t 35 min');
    expect(formatDuration(275, 'en')).toBe('4 h 35 min');
    expect(formatDuration(59.6, 'no')).toBe('1 t');
    expect(formatDuration(-1, 'no')).toBe('—');
  });
});

describe('formatGrade', () => {
  it('signs non-zero grades and keeps one decimal', () => {
    expect(formatGrade(8.34, 'no')).toMatch(/^\+8,3\s%$/);
    expect(formatGrade(-4.1, 'no')).toMatch(/^[-−]4,1\s%$/);
    expect(formatGrade(0, 'en')).toMatch(/^0%$/);
  });
});

describe('naismithMinutes / normalizePace', () => {
  it('adds flat time and one hour per 600 m of ascent, honours a custom pace, never credits descent, and returns NaN for unusable input', () => {
    // 10 km at 5 km/h = 2 h; 600 m at 600 m/h = 1 h.
    expect(naismithMinutes(10_000, 600, DEFAULT_PACE)).toBeCloseTo(180, 6);
    expect(naismithMinutes(10_000, 0, DEFAULT_PACE)).toBeCloseTo(120, 6);
    // 4 km/h and 400 m/h: 12 km = 3 h, 800 m = 2 h.
    expect(naismithMinutes(12_000, 800, { speedKmh: 4, ascentMPerHour: 400 })).toBeCloseTo(300, 6);
    expect(naismithMinutes(5000, -800, DEFAULT_PACE)).toBeCloseTo(60, 6);

    expect(Number.isNaN(naismithMinutes(Number.NaN, 100, DEFAULT_PACE))).toBe(true);
    expect(Number.isNaN(naismithMinutes(1000, 100, { speedKmh: 0, ascentMPerHour: 600 }))).toBe(true);

    // Pace is clamped to the supported range, with defaults for missing values.
    expect(normalizePace({ speedKmh: 0.2, ascentMPerHour: 99_999 })).toEqual({
      speedKmh: PACE_LIMITS.speedKmh.min,
      ascentMPerHour: PACE_LIMITS.ascentMPerHour.max,
    });
    expect(normalizePace({})).toEqual(DEFAULT_PACE);
    expect(normalizePace(null)).toEqual(DEFAULT_PACE);
  });
});
