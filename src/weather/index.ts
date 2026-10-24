/**
 * Weather planning for a multi-day route — MET Locationforecast 2.0 `compact`.
 *
 * The engine is small on purpose: one network client (`./met`), one cache
 * contract (`./cache`), no UI, no timers. It turns a `Trip` into one
 * `WeatherDay` per trip day, each sampled at **local midday Europe/Oslo** at
 * the point the day's walking reaches — or at the current instant for *today*,
 * whose midday is already behind the clock by the evening.
 *
 * ## The honesty rules, encoded here
 *
 * - A day is `beyond-horizon` when its target instant is past the **last
 *   `timeseries` entry of the response**. The horizon is measured per response
 *   (10.0 days on 2026-10-19), never assumed. A beyond-horizon sample carries
 *   `when`, `point` and `status` **and nothing else** — no `tempC`, no `0 °C`
 *   placeholder, no interpolated value.
 * - A day is `unavailable` when we tried and could not answer: HTTP error,
 *   network failure, no `fetch`, a corrupt body, a target before MET's series.
 *   The `reason` is shown as-is; one failure never aborts the plan.
 * - A missing `precipitation_amount` stays `undefined`. A measured `0.0` stays
 *   `0`: zero is a fact, absence is ignorance.
 * - No monthly averages, no extrapolation, no "typical weather".
 *
 * ## Request shape
 *
 * One request per **unique rounded point** (`met:<lat4>:<lon4>`), truncated to
 * four decimals, at most `concurrency` (default 2) in flight, at most
 * `maxPoints` (default 40) sampled days. A trip that stays in one valley for
 * three days makes one request, not three.
 *
 * ## Contract extension
 *
 * `src/contracts` fixes `WeatherPlan`. A plan also needs to say
 * *why* it is empty or sparser than the trip, so the returned object is a
 * `WeatherPlanDetail` — the same shape plus `notes`, `sampledEveryNDays` and
 * `daysTotal`. It is assignable to `WeatherPlan`, and the additions are
 * documented in `src/weather/README.md`.
 */

import type {
  LonLat,
  Trip,
  WeatherDay,
  WeatherPlan,
  WeatherSample,
} from '../contracts';
import { cumulativeDistances } from '../core/geo';
import { memoryWeatherCache, type CachedForecast, type WeatherCache } from './cache';
import {
  DEFAULT_CACHE_TTL_MS,
  FORECAST_HORIZON_DAYS,
  addDays,
  buildForecastUrl,
  isoDateToUtcMidnight,
  osloMidday,
  HORIZON_TOLERANCE_MS,
  parseForecast,
  pickSample,
  roundedPoint,
  todayInOslo,
  type MetForecastEntry,
} from './met';

export { fetchWarnings } from './alerts';
export { memoryWeatherCache } from './cache';
export type { CachedForecast, WeatherCache } from './cache';
export {
  MET_FORECAST_ENDPOINT,
  buildForecastUrl,
  forecastCacheKey,
  HORIZON_TOLERANCE_MS,
  parseForecast,
  pickSample,
  roundedPoint,
  todayInOslo,
} from './met';
export type { MetForecast, MetForecastEntry, MetSample, RoundedPoint } from './met';
export type { WeatherDay, WeatherPlan, WeatherSample, WeatherWarning } from '../contracts';

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

interface WeatherDeps {
  /** Injected so tests never touch the network. Defaults to `globalThis.fetch`. */
  fetch: typeof fetch;
  /** Cache keyed by `met:<lat4>:<lon4>`; TTL enforced from `expiresAt`. */
  cache: WeatherCache;
  /** Injected clock. Called once per plan. */
  now: () => Date;
  /** Maximum sampled days/points. Default 40. */
  maxPoints?: number;
  /** Maximum concurrent upstream requests. Default 2. */
  concurrency?: number;
}

/**
 * Hard ceiling on one MET request.
 *
 * `fetch` has no default timeout: against a MET that accepts the connection and
 * never answers, the weather plan waited for the browser's own timeout — minutes
 * of "Henter varsel …" with no way out. Every other live client in this app has a
 * timeout; this one did not.
 */
const MET_REQUEST_TIMEOUT_MS = 15_000;

const DEFAULT_MAX_POINTS = 40;
const DEFAULT_CONCURRENCY = 2;

/**
 * A `WeatherPlan` plus the two facts the UI needs to stay honest about what is
 * missing: `notes` (why the plan is empty or partial) and `sampledEveryNDays`
 * (1 = every trip day was sampled).
 */
export interface WeatherPlanDetail extends WeatherPlan {
  /** English, human-readable reasons and caveats. Empty for a full plan. */
  readonly notes: readonly string[];
  /**
   * Sampling stride in days when the trip needed more than `maxPoints` points.
   * `1` means every day is represented.
   */
  readonly sampledEveryNDays: number;
  /** Trip length in days before sampling (`ceil(totalKm / dailyKm)`). */
  readonly daysTotal: number;
}

/** MET Locationforecast 2.0 currently reaches ~10 days ahead (measured). */
export function forecastHorizonDays(): number {
  return FORECAST_HORIZON_DAYS;
}

// ---------------------------------------------------------------------------
// Route geometry
// ---------------------------------------------------------------------------

interface FlatRoute {
  readonly points: readonly LonLat[];
  readonly cumulative: readonly number[];
  readonly totalM: number;
}

/**
 * Flatten the trip's legs into one polyline and cumulative distances.
 *
 * Geometry is the source of truth, not `leg.distanceM`: the legs are the thing
 * the user drew, and a stored distance that disagrees must not move a sample.
 * A leg's first point is dropped when it repeats the previous leg's last point,
 * so a junction is not a zero-length step.
 */
function flattenTrip(trip: Trip): FlatRoute {
  const points: LonLat[] = [];
  for (const leg of trip.legs) {
    for (const point of leg.points) {
      if (!Number.isFinite(point.lon) || !Number.isFinite(point.lat)) continue;
      const previous = points[points.length - 1];
      if (previous && previous.lon === point.lon && previous.lat === point.lat) continue;
      points.push({ lon: point.lon, lat: point.lat });
    }
  }
  const cumulative = cumulativeDistances(points);
  const totalM = points.length > 1 ? cumulative[cumulative.length - 1] : 0;
  return { points, cumulative, totalM };
}

/** Linear interpolation along the polyline at `distanceM` (clamped). */
function pointAt(route: FlatRoute, distanceM: number): LonLat {
  const { points, cumulative } = route;
  if (points.length === 0) throw new Error('cannot sample an empty route');
  const target = Math.max(0, Math.min(distanceM, route.totalM));
  if (points.length === 1 || target <= 0) return { ...points[0] };
  if (target >= route.totalM) return { ...points[points.length - 1] };

  // Binary search for the segment containing `target`.
  let low = 0;
  let high = cumulative.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (cumulative[middle] <= target) low = middle;
    else high = middle;
  }
  const start = cumulative[low];
  const end = cumulative[low + 1];
  const span = end - start;
  const t = span > 0 ? (target - start) / span : 0;
  return {
    lon: points[low].lon + (points[low + 1].lon - points[low].lon) * t,
    lat: points[low].lat + (points[low + 1].lat - points[low].lat) * t,
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Run `worker` over `items` with at most `limit` promises in flight. */
async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

/**
 * Expiry for a cache entry: MET's `Expires` header verbatim (the `Headers` API
 * is case-insensitive, so `get('expires')` honours the lowercased form), or a
 * documented 30-minute fallback when the header is absent or unparseable.
 * A header in the past is stored as-is — that simply means "refetch next time".
 */
function cacheExpiry(response: Response, nowMs: number): string {
  const header = response.headers.get('expires');
  if (header) {
    const parsed = Date.parse(header);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date(nowMs + DEFAULT_CACHE_TTL_MS).toISOString();
}

function forecastSample(
  when: string,
  point: LonLat,
  entry: MetForecastEntry & { readonly tempC: number },
  issuedAt: string | undefined,
  expiresAt: string,
): WeatherSample {
  return {
    when,
    point,
    status: 'forecast',
    tempC: entry.tempC,
    ...(entry.windMs !== undefined ? { windMs: entry.windMs } : {}),
    ...(entry.precipMm !== undefined ? { precipMm: entry.precipMm } : {}),
    ...(entry.symbol !== undefined ? { symbol: entry.symbol } : {}),
    ...(issuedAt !== undefined ? { issuedAt } : {}),
    expiresAt,
  };
}

/** A beyond-horizon sample carries **no** numeric or forecast field. */
function beyondHorizonSample(when: string, point: LonLat): WeatherSample {
  return { when, point, status: 'beyond-horizon' };
}

function unavailableSample(when: string, point: LonLat, reason: string): WeatherSample {
  return { when, point, status: 'unavailable', reason };
}

/**
 * One line for the UI: what actually changes a plan is wind and precipitation,
 * so both appear next to the temperature. A 6-hour accumulation is labelled.
 */
function headlineFor(entry: MetForecastEntry & { readonly tempC: number }): string {
  const parts = [`${entry.tempC.toFixed(1)} °C`];
  if (entry.windMs !== undefined) parts.push(`wind ${entry.windMs.toFixed(1)} m/s`);
  if (entry.precipMm !== undefined) {
    const window = entry.precipPeriod === '6h' ? '/6 h' : '';
    parts.push(`${entry.precipMm.toFixed(1)} mm${window}`);
  }
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// The planner
// ---------------------------------------------------------------------------

/**
 * Assemble a weather plan for `trip`.
 *
 * Returns an empty plan (never throws) when there is nothing honest to say:
 * `dailyKm <= 0`, zero-length geometry, or no `startDate`. The reason is in
 * `notes`.
 */
export async function planTripWeather(
  trip: Trip,
  deps: Partial<WeatherDeps> = {},
): Promise<WeatherPlanDetail> {
  const nowDate = (deps.now ?? (() => new Date()))();
  const nowMs = nowDate.getTime();
  const assembledAt = nowDate.toISOString();
  const cache = deps.cache ?? memoryWeatherCache();
  const maxPoints = positiveInteger(deps.maxPoints, DEFAULT_MAX_POINTS);
  const concurrency = positiveInteger(deps.concurrency, DEFAULT_CONCURRENCY);
  const fetchImpl: typeof fetch | undefined =
    deps.fetch ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined);

  const notes: string[] = [];
  const buildPlan = (
    days: WeatherDay[],
    daysTotal: number,
    sampledEveryNDays: number,
  ): WeatherPlanDetail => ({
    days,
    warnings: [],
    assembledAt,
    hasForecast: days.some((day) => day.sample.status === 'forecast'),
    notes,
    sampledEveryNDays,
    daysTotal,
  });
  const emptyPlan = (): WeatherPlanDetail => buildPlan([], 0, 1);

  const dailyKm = trip.profile.dailyKm;
  if (!(typeof dailyKm === 'number' && Number.isFinite(dailyKm)) || dailyKm <= 0) {
    notes.push(
      `profile.dailyKm is ${String(dailyKm)}: without a daily distance there is no place on the ` +
        `route for a given day, so no weather can be requested`,
    );
    return emptyPlan();
  }

  const route = flattenTrip(trip);
  if (!(route.totalM > 0)) {
    notes.push(
      'the trip has no measurable distance (fewer than two distinct points), so there is no ' +
        'route position to ask the weather for',
    );
    return emptyPlan();
  }

  // Today's calendar date in the same time zone the samples are placed in. A
  // sample for *today* may not be in the past (see the slot loop below).
  const todayIso = todayInOslo(nowDate);

  const startDate = trip.profile.startDate;
  if (!startDate) {
    notes.push(
      'the trip has no startDate: a weather day is a calendar date, and without one the timeline ' +
        'has nothing to attach a forecast to',
    );
    return emptyPlan();
  }
  try {
    isoDateToUtcMidnight(startDate);
  } catch (error) {
    notes.push(`the trip's startDate cannot be used: ${errorMessage(error)}`);
    return emptyPlan();
  }

  // --- Trip days ----------------------------------------------------------

  const metresPerDay = dailyKm * 1000;
  const daysTotal = Math.max(1, Math.ceil(route.totalM / metresPerDay));
  const sampledEveryNDays = Math.max(1, Math.ceil(daysTotal / maxPoints));
  if (sampledEveryNDays > 1) {
    notes.push(
      `this trip spans ${daysTotal} days; capped at ${maxPoints} forecast points it is sampled ` +
        `every ${sampledEveryNDays} days`,
    );
  }

  interface Slot {
    readonly dayIndex: number;
    readonly date: string;
    readonly distanceM: number;
    readonly point: LonLat;
    readonly whenIso: string;
    readonly targetMs: number;
    readonly key?: string;
    readonly failure?: string;
  }

  const slots: Slot[] = [];
  for (let dayIndex = 0; dayIndex < daysTotal; dayIndex += sampledEveryNDays) {
    const distanceM = Math.min(dayIndex * metresPerDay, route.totalM);
    const point = pointAt(route, distanceM);
    const date = addDays(startDate, dayIndex);
    // Local midday is the right target for a day that has not started yet, but
    // by the evening it is hours behind the clock — and in "now" weather mode the
    // trip starts *today*, so day 0 asked MET for an instant MET's series cannot
    // cover. That answer was "requested time … precedes MET's series", shown to
    // the user as "the trip starts before the forecast begins": a cause that does
    // not exist when the user never gave a start date. Only today moves, and only
    // forward; a genuinely past trip day keeps reporting that honestly.
    const middayMs = osloMidday(date).getTime();
    const targetMs = date === todayIso ? Math.max(middayMs, nowMs) : middayMs;
    let key: string | undefined;
    let failure: string | undefined;
    try {
      key = roundedPoint(point).cacheKey;
    } catch (error) {
      failure = errorMessage(error);
    }
    slots.push({
      dayIndex,
      date,
      distanceM,
      point,
      whenIso: new Date(targetMs).toISOString(),
      targetMs,
      ...(key !== undefined ? { key } : {}),
      ...(failure !== undefined ? { failure } : {}),
    });
  }

  // --- One upstream request per unique rounded point ----------------------

  const uniquePoints = new Map<string, LonLat>();
  for (const slot of slots) {
    if (slot.key !== undefined && !uniquePoints.has(slot.key)) {
      uniquePoints.set(slot.key, slot.point);
    }
  }

  type Outcome =
    | { readonly ok: true; readonly forecast: ReturnType<typeof parseForecast>; readonly expiresAt: string }
    | { readonly ok: false; readonly reason: string };

  /** The earliest day each point has to answer for. Used to skip needless requests. */
  const earliestTargetMs = new Map<string, number>();
  for (const slot of slots) {
    if (slot.key === undefined) continue;
    const previous = earliestTargetMs.get(slot.key);
    if (previous === undefined || slot.targetMs < previous) {
      earliestTargetMs.set(slot.key, slot.targetMs);
    }
  }

  const outcomes = new Map<string, Outcome>();
  const pending: string[] = [];
  let cacheReadFailed = false;
  let cacheWriteFailed = false;

  for (const key of uniquePoints.keys()) {
    let cached: CachedForecast | null = null;
    try {
      cached = await cache.get(key);
    } catch {
      cacheReadFailed = true;
    }
    if (cached) {
      const expiresMs = Date.parse(cached.expiresAt);
      if (Number.isFinite(expiresMs) && expiresMs > nowMs) {
        try {
          outcomes.set(key, {
            ok: true,
            forecast: parseForecast(cached.body),
            expiresAt: cached.expiresAt,
          });
          continue;
        } catch {
          // A corrupt cache entry is a miss, never a failure.
        }
      }
    }
    pending.push(key);
  }
  if (cacheReadFailed) {
    notes.push('the weather cache could not be read; every point was requested from MET');
  }

  // --- The forecast horizon is global, so one response is enough ------------
  //
  // Without this, a 150-day trip sends ~40 requests purely to be told that the
  // last 140 days are beyond the horizon. One response answers that for all of
  // them, and MET's terms ask us not to generate unnecessary traffic.
  let horizonMs: number | undefined;
  const considerHorizon = (forecast: ReturnType<typeof parseForecast>): void => {
    const entries = forecast.entries;
    const last = entries[entries.length - 1];
    if (last === undefined) return;
    if (horizonMs === undefined || last.timeMs > horizonMs) horizonMs = last.timeMs;
  };
  for (const outcome of outcomes.values()) if (outcome.ok) considerHorizon(outcome.forecast);

  if (horizonMs === undefined && fetchImpl && pending.length > 1) {
    pending.sort(
      (a, b) => (earliestTargetMs.get(a) ?? 0) - (earliestTargetMs.get(b) ?? 0),
    );
    const probeKey = pending.shift();
    const probePoint = probeKey !== undefined ? uniquePoints.get(probeKey) : undefined;
    if (probeKey !== undefined && probePoint) {
      try {
        const response = await fetchImpl(buildForecastUrl(probePoint), {
          signal: AbortSignal.timeout(MET_REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status} from MET Locationforecast`);
        const body: unknown = await response.json();
        const expiresAt = cacheExpiry(response, nowMs);
        try {
          await cache.set(probeKey, { body, expiresAt });
        } catch {
          cacheWriteFailed = true;
        }
        const forecast = parseForecast(body);
        outcomes.set(probeKey, { ok: true, forecast, expiresAt });
        considerHorizon(forecast);
      } catch (error) {
        outcomes.set(probeKey, { ok: false, reason: errorMessage(error) });
      }
    }
  }

  if (horizonMs !== undefined && pending.length > 0) {
    const horizonLimit = horizonMs + HORIZON_TOLERANCE_MS;
    const keep: string[] = [];
    let skipped = 0;
    for (const key of pending) {
      const target = earliestTargetMs.get(key);
      if (target === undefined || target <= horizonLimit) keep.push(key);
      else skipped += 1;
    }
    if (skipped > 0) {
      pending.length = 0;
      pending.push(...keep);
      notes.push(
        `${skipped} forecast point${skipped === 1 ? '' : 's'} served only days beyond the ` +
          `forecast horizon and ${skipped === 1 ? 'was' : 'were'} not requested`,
      );
    }
  }

  let fetchFailures = 0;
  if (pending.length > 0) {
    if (!fetchImpl) {
      const reason = 'no fetch implementation is available in this environment';
      for (const key of pending) outcomes.set(key, { ok: false, reason });
      fetchFailures = pending.length;
      notes.push('this environment provides no fetch, so no forecast could be requested');
    } else {
      await mapLimit(pending, concurrency, async (key) => {
        const point = uniquePoints.get(key);
        try {
          if (!point) throw new Error(`internal: no point for cache key ${key}`);
          const url = buildForecastUrl(point);
          const response = await fetchImpl(url, {
            signal: AbortSignal.timeout(MET_REQUEST_TIMEOUT_MS),
          });
          if (!response.ok) {
            throw new Error(`HTTP ${response.status} from MET Locationforecast`);
          }
          const body: unknown = await response.json();
          const expiresAt = cacheExpiry(response, nowMs);
          try {
            await cache.set(key, { body, expiresAt });
          } catch {
            cacheWriteFailed = true;
          }
          outcomes.set(key, { ok: true, forecast: parseForecast(body), expiresAt });
        } catch (error) {
          outcomes.set(key, { ok: false, reason: errorMessage(error) });
        }
      });
      for (const outcome of outcomes.values()) if (!outcome.ok) fetchFailures += 1;
      if (fetchFailures > 0) {
        notes.push(
          `${fetchFailures} forecast point${fetchFailures === 1 ? '' : 's'} could not be ` +
            `retrieved; those days are marked unavailable with the reason`,
        );
      }
    }
  }
  if (cacheWriteFailed) {
    notes.push('the weather cache could not be written; forecasts were shown but not stored');
  }

  // --- Assemble the days --------------------------------------------------

  const days: WeatherDay[] = [];
  let beyondHorizonDays = 0;
  let seriesEndIso: string | undefined;

  for (const slot of slots) {
    let sample: WeatherSample;
    let headline: string | undefined;
    if (slot.failure !== undefined || slot.key === undefined) {
      sample = unavailableSample(
        slot.whenIso,
        slot.point,
        slot.failure ?? 'the sampled coordinate is not valid',
      );
    } else {
      const outcome = outcomes.get(slot.key);
      if (horizonMs !== undefined && slot.targetMs > horizonMs + HORIZON_TOLERANCE_MS) {
        beyondHorizonDays += 1;
        const lastIso = new Date(horizonMs).toISOString();
        if (seriesEndIso === undefined || lastIso > seriesEndIso) seriesEndIso = lastIso;
        sample = beyondHorizonSample(slot.whenIso, slot.point);
      } else if (!outcome) {
        sample = unavailableSample(slot.whenIso, slot.point, 'no forecast result for this point');
      } else if (!outcome.ok) {
        sample = unavailableSample(slot.whenIso, slot.point, outcome.reason);
      } else {
        const picked = pickSample(outcome.forecast, slot.targetMs);
        if (picked.status === 'beyond-horizon') {
          beyondHorizonDays += 1;
          const last = outcome.forecast.entries[outcome.forecast.entries.length - 1];
          const lastIso = new Date(last.timeMs).toISOString();
          if (seriesEndIso === undefined || lastIso > seriesEndIso) seriesEndIso = lastIso;
          sample = beyondHorizonSample(slot.whenIso, slot.point);
        } else if (picked.status === 'unavailable') {
          sample = unavailableSample(slot.whenIso, slot.point, picked.reason);
        } else {
          sample = forecastSample(
            slot.whenIso,
            slot.point,
            picked.entry,
            picked.issuedAt,
            outcome.expiresAt,
          );
          headline = headlineFor(picked.entry);
        }
      }
    }

    const day: WeatherDay = {
      dayIndex: slot.dayIndex,
      date: slot.date,
      distanceM: slot.distanceM,
      point: slot.point,
      sample,
      ...(headline !== undefined ? { headline } : {}),
    };
    days.push(day);
  }

  if (beyondHorizonDays > 0) {
    notes.push(
      `${beyondHorizonDays} of ${days.length} sampled day${days.length === 1 ? '' : 's'} fall past ` +
        `the last entry of MET's series${seriesEndIso ? ` (${seriesEndIso})` : ''}; they are marked ` +
        `beyond-horizon and carry no numbers`,
    );
  }

  return buildPlan(days, daysTotal, sampledEveryNDays);
}
