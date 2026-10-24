/**
 * Turn a route and a per-point elevation series into an authoritative profile.
 *
 * Pipeline (order matters):
 *
 *   raw DEM elevations
 *     → fill NoData gaps (linear interpolation)
 *     → 3-point median filter          (kills single-pixel DEM spikes)
 *     → hysteresis gain/loss state machine (kills small-noise accumulation)
 *     → grade over a 100 m window      (kills point-to-point spikes)
 *
 * The two noise traps, documented because both produce spectacularly wrong
 * numbers when skipped:
 *
 * 1. **Hysteresis, not raw summing.** Summing every positive difference in a
 *    DEM profile accumulates float noise and terrain micro-relief into
 *    thousands of false metres of ascent. The state machine below only counts
 *    swings that exceed `hysteresisM` (default 5 m) from the last confirmed
 *    turning point. It is a committed-extreme machine, not a post-hoc filter:
 *    once a reversal exceeds the threshold, the *full* swing from the previous
 *    turning point is counted, so real climbing is not eroded away.
 *
 * 2. **Grade over a window, not per sample.** Per-sample grade on 10 m DEM
 *    pixels regularly exceeds ±100 %. Grade is the mean slope over a window of
 *    ~100 m centred on the sample.
 */

import { cumulativeDistances, type LonLat } from './geo';

interface ProfileSample {
  /** Distance along the route from the start, metres. */
  d: number;
  /** Elevation after gap-filling and median filtering, metres. */
  ele: number;
}

interface ProfileOptions {
  /** Median filter width; odd, >= 1. Default 3. Use 1 to disable. */
  medianWindow?: number;
  /** Hysteresis threshold in metres. Default 5. */
  hysteresisM?: number;
  /** Grade window in metres. Default 100. */
  gradeWindowM?: number;
  /**
   * Distance along the route for each coordinate, metres from the start — the
   * route's canonical distances. Supply them whenever the geometry arrived via
   * `buildRoute()`: it rescales those to the file's measured length, and a
   * profile that recomputes its own from the resampled line reports a *second*
   * length for the same route (measured on a dense zig-zag track: 152,930 m
   * against the route's 177,915 m). Omitted, the distances are haversine sums
   * over `coords`, unchanged.
   */
  distances?: readonly number[];
}

export interface Profile {
  samples: ProfileSample[];
  /** Total ascent in metres (hysteresis-filtered). */
  ascentM: number;
  /** Total descent in metres (hysteresis-filtered). */
  descentM: number;
  /** Steepest upward grade in percent (over the grade window). */
  maxGradePct: number;
  /** Steepest downward grade in percent (negative or zero). */
  minGradePct: number;
  /** Total route length in metres. */
  distanceM: number;
  /** Samples whose input elevation was NoData and was interpolated. */
  filledSamples: number;
  /**
   * The longest contiguous stretch at or below sea level, metres along the route.
   * The DTM is a bare-earth model that returns exactly 0 over the sea, so a walk
   * that dips to 0 between high ground is a line across water, not a descent.
   */
  seaLevelM: number;
}

/** At or below this, a sample is the sea surface rather than terrain (metres). */
const SEA_LEVEL_TOLERANCE_M = 0.5;

const DEFAULT_MEDIAN_WINDOW = 3;
const DEFAULT_HYSTERESIS_M = 5;
const DEFAULT_GRADE_WINDOW_M = 100;

/** Fill non-finite values by linear interpolation between finite neighbours. */
function fillGaps(values: readonly number[]): { values: number[]; filled: number } {
  const out = values.slice();
  const finiteIndices: number[] = [];
  for (let i = 0; i < out.length; i++) {
    if (Number.isFinite(out[i])) finiteIndices.push(i);
  }
  if (finiteIndices.length === 0) {
    throw new Error('buildProfile: every elevation is NoData/NaN — refusing to build a flat profile');
  }

  let filled = 0;
  // Leading gap: hold the first finite value.
  for (let i = 0; i < finiteIndices[0]; i++) {
    out[i] = out[finiteIndices[0]];
    filled++;
  }
  // Interior gaps: linear interpolation in sample index.
  for (let k = 0; k + 1 < finiteIndices.length; k++) {
    const a = finiteIndices[k];
    const b = finiteIndices[k + 1];
    if (b - a > 1) {
      for (let i = a + 1; i < b; i++) {
        const t = (i - a) / (b - a);
        out[i] = out[a] + (out[b] - out[a]) * t;
        filled++;
      }
    }
  }
  // Trailing gap: hold the last finite value.
  for (let i = finiteIndices[finiteIndices.length - 1] + 1; i < out.length; i++) {
    out[i] = out[finiteIndices[finiteIndices.length - 1]];
    filled++;
  }
  return { values: out, filled };
}

/**
 * Centred median filter. The first and last `floor(window/2)` samples are left
 * unchanged (a truncated even-sized window would bias them). NaN is assumed to
 * have been filled already; any remaining non-finite value is treated as
 * missing by the median.
 */
export function medianFilter(values: readonly number[], window = DEFAULT_MEDIAN_WINDOW): number[] {
  if (window === 1) return values.slice();
  if (!Number.isInteger(window) || window < 1 || window % 2 === 0) {
    throw new RangeError(`medianFilter: window must be an odd positive integer, got ${window}`);
  }
  const half = Math.floor(window / 2);
  const out = values.slice();
  // Leave the first/last `half` samples untouched: a truncated (even-sized)
  // window would bias the median at the ends. Interior samples use the full
  // window.
  for (let i = half; i < values.length - half; i++) {
    const slice: number[] = [];
    for (let j = i - half; j <= i + half; j++) {
      const v = values[j];
      if (Number.isFinite(v)) slice.push(v);
    }
    if (slice.length === 0) {
      out[i] = Number.NaN;
      continue;
    }
    slice.sort((a, b) => a - b);
    out[i] = slice[Math.floor(slice.length / 2)];
  }
  return out;
}

/**
 * Hysteresis gain/loss state machine.
 *
 * State:
 *   dir        current confirmed direction: 0 unknown, +1 up, -1 down
 *   lastTurn   elevation of the last confirmed turning point
 *   extreme    running extreme since `lastTurn` in the current direction
 *
 * - In direction 0 nothing is counted until a swing exceeds `threshold`.
 * - In direction +1 we track the running maximum; a drop of `threshold` or
 *   more below that maximum confirms the peak, at which point the gain
 *   `peak - lastTurn` is committed and direction flips.
 * - Symmetrically for -1.
 * - Whatever leg is still open at the end is committed.
 *
 * Tiny oscillations (< threshold) never move `lastTurn`, so they contribute
 * nothing; when a real swing happens, the full swing from the last confirmed
 * turning point is counted (the noise inside it is not double-counted).
 */
export function elevationGainLoss(
  elevations: readonly number[],
  thresholdM = DEFAULT_HYSTERESIS_M,
): { ascentM: number; descentM: number } {
  if (!(thresholdM >= 0) || !Number.isFinite(thresholdM)) {
    throw new RangeError(`elevationGainLoss: threshold must be >= 0, got ${thresholdM}`);
  }
  if (elevations.length < 2) return { ascentM: 0, descentM: 0 };

  let dir: -1 | 0 | 1 = 0;
  let lastTurn = elevations[0];
  let extreme = elevations[0];
  let ascent = 0;
  let descent = 0;

  for (let i = 1; i < elevations.length; i++) {
    const e = elevations[i];
    if (dir === 0) {
      if (e - extreme >= thresholdM) {
        dir = 1;
        extreme = e;
      } else if (extreme - e >= thresholdM) {
        dir = -1;
        extreme = e;
      }
    } else if (dir === 1) {
      if (e > extreme) {
        extreme = e;
      } else if (extreme - e >= thresholdM) {
        ascent += extreme - lastTurn;
        lastTurn = extreme;
        dir = -1;
        extreme = e;
      }
    } else {
      if (e < extreme) {
        extreme = e;
      } else if (e - extreme >= thresholdM) {
        descent += lastTurn - extreme;
        lastTurn = extreme;
        dir = 1;
        extreme = e;
      }
    }
  }

  if (dir === 1) ascent += extreme - lastTurn;
  else if (dir === -1) descent += lastTurn - extreme;

  return { ascentM: ascent, descentM: descent };
}

/**
 * Mean grade (percent) over a window of `windowM` metres centred on each
 * sample. End samples use the closest available window (clamped to the route
 * ends). Returns 0 where the route has no length.
 */
export function gradeSeries(
  distances: readonly number[],
  elevations: readonly number[],
  windowM = DEFAULT_GRADE_WINDOW_M,
): number[] {
  const n = distances.length;
  const grades = new Array<number>(n).fill(0);
  if (n < 2 || !(windowM > 0)) return grades;
  const half = windowM / 2;

  let j = 0; // last index at or before d[i] - half
  let k = 0; // first index at or after d[i] + half
  for (let i = 0; i < n; i++) {
    while (j + 1 < n && distances[j + 1] <= distances[i] - half) j++;
    if (k < i) k = i;
    while (k + 1 < n && distances[k] < distances[i] + half) k++;
    const span = distances[k] - distances[j];
    grades[i] = span > 0 ? ((elevations[k] - elevations[j]) / span) * 100 : 0;
  }
  return grades;
}

/** A stretch at least this long at sea level is worth naming (metres). */
export const SEA_LEVEL_WARN_M = 300;
/** ...and only when the rest of the route rises this far above it (metres). */
export const SEA_LEVEL_RELIEF_M = 50;

/**
 * The sea-level stretch worth telling the user about, in metres, or `null`.
 *
 * The DTM returns exactly 0 over the sea, so a route that dips to 0 between high
 * ground is a line across water. The relief test keeps a genuine coastal walk
 * (0 m throughout, nothing to warn about) quiet.
 */
export function seaLevelWarning(profile: Profile): number | null {
  if (!(profile.seaLevelM >= SEA_LEVEL_WARN_M) || profile.samples.length === 0) return null;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const sample of profile.samples) {
    if (sample.ele < min) min = sample.ele;
    if (sample.ele > max) max = sample.ele;
  }
  return max - min > SEA_LEVEL_RELIEF_M ? profile.seaLevelM : null;
}

/**
 * Longest contiguous run of samples at or below sea level, in metres along the
 * route. Zero when the route never reaches the sea.
 */
function seaLevelRunM(samples: readonly ProfileSample[]): number {
  let longest = 0;
  let start: number | null = null;
  for (const sample of samples) {
    if (sample.ele <= SEA_LEVEL_TOLERANCE_M) {
      if (start === null) start = sample.d;
      longest = Math.max(longest, sample.d - start);
    } else {
      start = null;
    }
  }
  return longest;
}

/**
 * Build a profile from a route and its elevations.
 *
 * `coords` and `elevations` are parallel arrays. The route need not be evenly
 * resampled; distances are computed with haversine, unless `options.distances`
 * carries the route's own (see `ProfileOptions.distances`). NoData (`NaN`)
 * elevations are linearly interpolated; if every elevation is NoData this throws
 * rather than returning a flat profile.
 */
export function buildProfile(
  coords: readonly LonLat[],
  elevations: readonly number[],
  options: ProfileOptions = {},
): Profile {
  if (coords.length !== elevations.length) {
    throw new Error(
      `buildProfile: coords (${coords.length}) and elevations (${elevations.length}) must have the same length`,
    );
  }
  const given = options.distances;
  if (given !== undefined && given.length !== coords.length) {
    throw new Error(
      `buildProfile: coords (${coords.length}) and distances (${given.length}) must have the same length`,
    );
  }
  if (coords.length === 0) {
    return {
      samples: [],
      ascentM: 0,
      descentM: 0,
      maxGradePct: 0,
      minGradePct: 0,
      distanceM: 0,
      filledSamples: 0,
      seaLevelM: 0,
    };
  }

  const medianWindow = options.medianWindow ?? DEFAULT_MEDIAN_WINDOW;
  const hysteresisM = options.hysteresisM ?? DEFAULT_HYSTERESIS_M;
  const gradeWindowM = options.gradeWindowM ?? DEFAULT_GRADE_WINDOW_M;

  const distances = given ?? cumulativeDistances(coords);
  const { values: filledValues, filled } = fillGaps(elevations);
  const smoothed = medianFilter(filledValues, medianWindow);
  const { ascentM, descentM } = elevationGainLoss(smoothed, hysteresisM);
  const grades = gradeSeries(distances, smoothed, gradeWindowM);

  let maxGradePct = Number.NEGATIVE_INFINITY;
  let minGradePct = Number.POSITIVE_INFINITY;
  for (const g of grades) {
    if (!Number.isFinite(g)) continue;
    if (g > maxGradePct) maxGradePct = g;
    if (g < minGradePct) minGradePct = g;
  }
  if (!Number.isFinite(maxGradePct)) maxGradePct = 0;
  if (!Number.isFinite(minGradePct)) minGradePct = 0;

  const samples: ProfileSample[] = smoothed.map((ele, i) => ({ d: distances[i], ele }));

  return {
    samples,
    ascentM,
    descentM,
    maxGradePct,
    minGradePct,
    distanceM: distances[distances.length - 1],
    filledSamples: filled,
    seaLevelM: seaLevelRunM(samples),
  };
}
