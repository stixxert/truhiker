/**
 * Chart maths for the elevation profile.
 *
 * Everything here is pure: domains, ticks, interpolation, grade at a point and
 * the per-pixel-column aggregation used to draw tens of thousands of samples in
 * ~1 px columns. The renderer in `src/ui/profile-chart.ts` only converts these
 * numbers to canvas coordinates, which is what makes this testable without a
 * browser.
 */

export interface ProfilePoint {
  /** Distance from the start, metres. */
  d: number;
  /** Elevation, metres. */
  ele: number;
}

interface ValueDomain {
  min: number;
  max: number;
}

export interface Axis {
  min: number;
  max: number;
  step: number;
  ticks: number[];
}

/**
 * Domain for the vertical axis with a minimum span so that a flat route does
 * not degenerate into a 1-pixel band (and does not imply relief that is not
 * there).
 */
export function elevationDomain(
  points: readonly ProfilePoint[],
  minSpanM = 100,
): ValueDomain {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    if (!Number.isFinite(point.ele)) continue;
    if (point.ele < min) min = point.ele;
    if (point.ele > max) max = point.ele;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: minSpanM };
  const span = max - min;
  if (span >= minSpanM) return { min, max };
  const centre = (min + max) / 2;
  const half = minSpanM / 2;
  return { min: centre - half, max: centre + half };
}

const NICE_MULTIPLIERS = [1, 2, 2.5, 5, 10] as const;

/** Smallest "nice" step (1/2/2.5/5 × 10ⁿ) that keeps ticks under `maxTicks`. */
export function niceStep(range: number, maxTicks: number): number {
  if (!(range > 0) || maxTicks < 1) return 1;
  const rough = range / maxTicks;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  for (const multiplier of NICE_MULTIPLIERS) {
    const candidate = multiplier * magnitude;
    if (candidate >= rough) return candidate;
  }
  return 10 * magnitude;
}

/**
 * Vertical axis with a small padding around the data and round tick values
 * inside it, so labels read "1 200", "1 400", "1 600" while the chart still
 * uses its full height (snapping the axis to the ticks themselves would waste
 * up to a whole step at the top and bottom).
 */
export function elevationAxis(points: readonly ProfilePoint[], maxTicks = 5): Axis {
  const domain = elevationDomain(points);
  const span = domain.max - domain.min;
  const step = niceStep(span, maxTicks);
  const pad = Math.max(span * 0.06, step * 0.12);
  const min = domain.min - pad;
  const max = domain.max + pad;
  const ticks: number[] = [];
  const first = Math.ceil(min / step - 1e-9) * step;
  // Guard against floating-point drift with a relative epsilon.
  for (let value = first; value <= max + step * 1e-6; value += step) {
    ticks.push(Number(value.toFixed(6)));
    if (ticks.length > 1000) break;
  }
  return { min, max, step, ticks };
}

const DISTANCE_STEPS_M = [
  100, 250, 500, 1_000, 2_000, 2_500, 5_000, 10_000, 20_000, 25_000, 50_000, 100_000, 200_000,
  250_000, 500_000, 1_000_000, 2_000_000,
] as const;

/** Horizontal axis: a round distance step that yields at most `maxTicks` labels. */
export function distanceAxis(maxDistanceM: number, maxTicks = 7): { stepM: number; ticks: number[] } {
  if (!Number.isFinite(maxDistanceM) || maxDistanceM <= 0) {
    return { stepM: 1000, ticks: [0] };
  }
  let stepM = DISTANCE_STEPS_M[DISTANCE_STEPS_M.length - 1];
  for (const candidate of DISTANCE_STEPS_M) {
    if (maxDistanceM / candidate <= Math.max(1, maxTicks - 1)) {
      stepM = candidate;
      break;
    }
  }
  const ticks: number[] = [];
  for (let d = 0; d <= maxDistanceM + stepM * 1e-6; d += stepM) {
    ticks.push(d);
    if (ticks.length > 1000) break;
  }
  return { stepM, ticks };
}

/** Elevation at an arbitrary distance, linearly interpolated between samples. */
export function elevationAtDistance(points: readonly ProfilePoint[], distance: number): number {
  const n = points.length;
  if (n === 0) return Number.NaN;
  if (n === 1 || distance <= points[0].d) return points[0].ele;
  if (distance >= points[n - 1].d) return points[n - 1].ele;

  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].d <= distance) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  const span = b.d - a.d;
  if (!(span > 0)) return a.ele;
  const t = (distance - a.d) / span;
  return a.ele + (b.ele - a.ele) * t;
}

/** Index of the sample nearest to `distance` (binary search). */
export function indexAtDistance(points: readonly ProfilePoint[], distance: number): number {
  const n = points.length;
  if (n === 0) return -1;
  if (distance <= points[0].d) return 0;
  if (distance >= points[n - 1].d) return n - 1;

  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].d <= distance) lo = mid;
    else hi = mid;
  }
  return distance - points[lo].d <= points[hi].d - distance ? lo : hi;
}

/**
 * Mean grade (percent) over a window centred on `distance`, matching the
 * core's 100 m grade window. Clamped to the route ends.
 */
export function gradeAtDistance(
  points: readonly ProfilePoint[],
  distance: number,
  windowM = 100,
): number {
  if (points.length < 2) return 0;
  const half = windowM / 2;
  const dStart = Math.max(points[0].d, distance - half);
  const dEnd = Math.min(points[points.length - 1].d, distance + half);
  if (!(dEnd > dStart)) return 0;
  const rise = elevationAtDistance(points, dEnd) - elevationAtDistance(points, dStart);
  return (rise / (dEnd - dStart)) * 100;
}

/** Aggregated vertical extent of the samples that fall inside one pixel column. */
export interface ProfileColumn {
  /** Distance range the column covers. */
  d0: number;
  d1: number;
  min: number;
  max: number;
  mean: number;
  first: number;
  last: number;
}

/**
 * Downsample a profile into `columns` distance buckets for drawing.
 *
 * Each bucket keeps its min/max envelope (so a 3,000 km route still shows every
 * spike instead of aliasing them away) plus a mean for the line. Buckets with no
 * samples — a short route stretched over a wide chart — are filled by linear
 * interpolation, so the profile still spans the full width.
 */
export function aggregateColumns(
  points: readonly ProfilePoint[],
  d0: number,
  d1: number,
  columns: number,
): ProfileColumn[] {
  const count = Math.max(1, Math.floor(columns));
  const out: ProfileColumn[] = [];
  if (points.length === 0 || !(d1 > d0)) {
    for (let i = 0; i < count; i++) {
      out.push({ d0: 0, d1: 0, min: Number.NaN, max: Number.NaN, mean: Number.NaN, first: Number.NaN, last: Number.NaN });
    }
    return out;
  }

  const step = (d1 - d0) / count;
  let index = 0;
  for (let i = 0; i < count; i++) {
    const start = d0 + i * step;
    const end = i === count - 1 ? d1 : start + step;
    // Include a sample exactly on the upper edge only in the final column.
    const upperInclusive = i === count - 1;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let sum = 0;
    let n = 0;
    let first = Number.NaN;
    let last = Number.NaN;

    while (index < points.length && points[index].d < start) index++;
    let cursor = index;
    while (cursor < points.length) {
      const point = points[cursor];
      const inside = upperInclusive ? point.d <= end : point.d < end;
      if (!inside) break;
      if (Number.isFinite(point.ele)) {
        if (Number.isNaN(first)) first = point.ele;
        last = point.ele;
        if (point.ele < min) min = point.ele;
        if (point.ele > max) max = point.ele;
        sum += point.ele;
        n++;
      }
      cursor++;
    }

    if (n === 0) {
      const value = elevationAtDistance(points, (start + end) / 2);
      min = value;
      max = value;
      sum = value;
      n = 1;
      first = value;
      last = value;
    }

    out.push({ d0: start, d1: end, min, max, mean: sum / n, first, last });
  }
  return out;
}
