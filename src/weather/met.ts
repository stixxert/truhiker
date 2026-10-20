/**
 * MET Norway Locationforecast 2.0 `compact` — the one network client.
 *
 * Called **directly from the browser**. MET's terms (quoted in
 * `src/weather/README.md`) allow simple cross-origin JavaScript requests and
 * identify the caller by `Origin`, which the browser sets automatically. We
 * therefore send **no** `User-Agent` (browsers cannot set it) and **no**
 * `If-Modified-Since` (not a CORS-safelisted header: it would trigger a
 * preflight, and MET does not support preflights). Caching is HTTP-level,
 * honouring the response's `Expires`, plus the injected `WeatherCache`.
 *
 * Measured 2026-10-19 against
 * `…/compact?lat=61.6363&lon=8.3124` with `Origin` and no `User-Agent`:
 * HTTP 200, `access-control-allow-origin: *`, 85 timeseries entries from
 * 2026-10-19T13:00Z to 2026-10-29T12:00Z (**10.0 days**), `expires` +30 min.
 * That is why the horizon is derived from the response and not from a
 * constant; see `pickSample()`.
 *
 * Coordinates are **truncated to 4 decimals** before the URL is built. That
 * maximises cache and dedupe hits (one request per rounded point) and follows
 * the coordinate rule in `docs/DECISIONS.md` (D4). The "5+ decimals returns 403"
 * claim in an earlier draft is **unverified from this environment**; truncation is
 * harmless either way.
 *
 * Nothing here interpolates, extrapolates or invents. A number is either in
 * MET's response or it is absent.
 */

import type { LonLat } from '../contracts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MET_FORECAST_ENDPOINT =
  'https://api.met.no/weatherapi/locationforecast/2.0/compact';

/** Decimals kept in `lat=`/`lon=`. Truncated, never rounded up. */
export const COORDINATE_DECIMALS = 4;

/**
 * Fallback horizon, days. **Not** the authority: a day is `beyond-horizon` when
 * the target time is past the last `timeseries` entry of the response we got.
 * This number is exposed for UI copy ("MET forecasts about ten days ahead") and
 * is the measured length (2026-10-19: 85 entries, 10.0 days). It is only used
 * when no response is available to measure.
 */
export const FORECAST_HORIZON_DAYS = 10;

/** How far past the last entry we still accept as "at the end of the series". */
export const HORIZON_TOLERANCE_MS = 3 * 3_600_000;

/**
 * Maximum distance between the target time and the closest timeseries entry.
 * MET's compact series is hourly for the first ~48 h and 6-hourly afterwards,
 * so any time inside the series is within 3 h of an entry; 7 h leaves margin
 * and still refuses a sample drawn from the wrong half of a day.
 */
export const MAX_SAMPLE_GAP_MS = 7 * 3_600_000;

/**
 * TTL used only when MET's response carries no usable `Expires` header. The
 * measured header is +30 minutes, so this matches observed behaviour rather
 * than inventing a longer cache life.
 */
export const DEFAULT_CACHE_TTL_MS = 30 * 60_000;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Coordinates: truncate to 4 decimals
// ---------------------------------------------------------------------------

/** One truncated point: the value, the exact URL text, and the cache key. */
export interface RoundedPoint {
  readonly point: LonLat;
  readonly latText: string;
  readonly lonText: string;
  /** `met:<lat4>:<lon4>` — the cache identity of a forecast. */
  readonly cacheKey: string;
}

function assertCoordinate(value: number, limit: number, label: string): void {
  if (!Number.isFinite(value) || Math.abs(value) > limit) {
    throw new RangeError(`${label} ${value} is not a finite value within ±${limit}°`);
  }
}

/** Truncate toward zero and normalise `-0` to `0`. */
function truncateCoordinate(value: number): number {
  const factor = 10 ** COORDINATE_DECIMALS;
  // The epsilon-free truncation can land one ulp low (e.g. 0.29 * 100 = 28.99…),
  // which only ever moves a point by ≤ 1e-4° (~11 m) and can never exceed four
  // decimals. Correctness of the promise ("≤ 4 decimals") does not depend on it.
  const truncated = Math.trunc(value * factor) / factor;
  return truncated === 0 ? 0 : truncated;
}

/** Exactly the text that appears after `lat=` / `lon=`. */
function coordinateText(value: number): string {
  const truncated = truncateCoordinate(value);
  const fixed = truncated.toFixed(COORDINATE_DECIMALS);
  if (!fixed.includes('.')) return fixed;
  return fixed.replace(/0+$/, '').replace(/\.$/, '');
}

/** Truncate a point to 4 decimals and derive its cache key. */
export function roundedPoint(point: LonLat): RoundedPoint {
  assertCoordinate(point.lat, 90, 'latitude');
  assertCoordinate(point.lon, 180, 'longitude');
  const latText = coordinateText(point.lat);
  const lonText = coordinateText(point.lon);
  return {
    point: { lat: truncateCoordinate(point.lat), lon: truncateCoordinate(point.lon) },
    latText,
    lonText,
    cacheKey: `met:${latText}:${lonText}`,
  };
}

/**
 * `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=<4dp>&lon=<4dp>`
 *
 * No other query parameters, no headers: the browser's `Origin` is the
 * identification MET asks for.
 */
export function buildForecastUrl(point: LonLat): string {
  const { latText, lonText } = roundedPoint(point);
  return `${MET_FORECAST_ENDPOINT}?lat=${latText}&lon=${lonText}`;
}

/** `met:<lat4>:<lon4>` for a point. Equivalent to `roundedPoint(point).cacheKey`. */
export function forecastCacheKey(point: LonLat): string {
  return roundedPoint(point).cacheKey;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** One hourly (or 6-hourly) slot of MET's compact series. */
export interface MetForecastEntry {
  readonly time: string;
  readonly timeMs: number;
  /**
   * °C from `instant.details.air_temperature`. Absent when MET did not send it —
   * never defaulted.
   */
  readonly tempC?: number;
  /** m/s from `instant.details.wind_speed`. */
  readonly windMs?: number;
  /**
   * mm from `next_1_hours.details.precipitation_amount`, falling back to
   * `next_6_hours`. A genuine `0` is a fact and is preserved; a missing value
   * stays `undefined`.
   */
  readonly precipMm?: number;
  /** Which accumulation window `precipMm` came from, so it can be labelled. */
  readonly precipPeriod?: '1h' | '6h';
  /** `next_1_hours.summary.symbol_code`, falling back to `next_6_hours`. */
  readonly symbol?: string;
}

export interface MetForecast {
  /** `properties.meta.updated_at` — when MET published this run. */
  readonly issuedAt?: string;
  /** Sorted by `timeMs`, ascending. Never empty (an empty series throws). */
  readonly entries: readonly MetForecastEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseTime(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function block(
  data: Record<string, unknown>,
  name: string,
): Record<string, unknown> | undefined {
  const value = data[name];
  return isRecord(value) ? value : undefined;
}

function pickPrecipitation(
  oneHour: Record<string, unknown> | undefined,
  sixHours: Record<string, unknown> | undefined,
): { value?: number; period?: '1h' | '6h' } {
  const fromOne = finiteNumber(
    oneHour && isRecord(oneHour.details) ? oneHour.details.precipitation_amount : undefined,
  );
  if (fromOne !== undefined) return { value: fromOne, period: '1h' };
  const fromSix = finiteNumber(
    sixHours && isRecord(sixHours.details) ? sixHours.details.precipitation_amount : undefined,
  );
  if (fromSix !== undefined) return { value: fromSix, period: '6h' };
  return {};
}

function pickSymbol(
  oneHour: Record<string, unknown> | undefined,
  sixHours: Record<string, unknown> | undefined,
): string | undefined {
  for (const candidate of [oneHour, sixHours]) {
    if (!candidate) continue;
    const summary = isRecord(candidate.summary) ? candidate.summary : undefined;
    if (summary && typeof summary.symbol_code === 'string' && summary.symbol_code.length > 0) {
      return summary.symbol_code;
    }
  }
  return undefined;
}

/**
 * Parse a Locationforecast 2.0 compact document.
 *
 * Throws on a document that is not a forecast (no `properties`, no
 * `timeseries`, no valid entries). It never returns a partially invented
 * series: the caller turns the throw into `status: 'unavailable'`.
 */
export function parseForecast(body: unknown): MetForecast {
  if (!isRecord(body)) throw new Error('MET response is not a JSON object');
  const properties = body.properties;
  if (!isRecord(properties)) throw new Error('MET response has no `properties` object');

  const meta = isRecord(properties.meta) ? properties.meta : undefined;
  const issuedMs = meta ? parseTime(meta.updated_at) : undefined;

  const series = properties.timeseries;
  if (!Array.isArray(series)) throw new Error('MET response has no `properties.timeseries` array');

  const entries: MetForecastEntry[] = [];
  for (const raw of series as unknown[]) {
    if (!isRecord(raw)) continue;
    const timeMs = parseTime(raw.time);
    if (timeMs === undefined) continue;
    const data = isRecord(raw.data) ? raw.data : undefined;
    if (!data) continue;

    const instant = block(data, 'instant');
    const details = instant && isRecord(instant.details) ? instant.details : undefined;
    const tempC = details ? finiteNumber(details.air_temperature) : undefined;
    const windMs = details ? finiteNumber(details.wind_speed) : undefined;

    const oneHour = block(data, 'next_1_hours');
    const sixHours = block(data, 'next_6_hours');
    const precipitation = pickPrecipitation(oneHour, sixHours);
    const symbol = pickSymbol(oneHour, sixHours);

    const entry: MetForecastEntry = {
      time: new Date(timeMs).toISOString(),
      timeMs,
      ...(tempC !== undefined ? { tempC } : {}),
      ...(windMs !== undefined ? { windMs } : {}),
      ...(precipitation.value !== undefined ? { precipMm: precipitation.value } : {}),
      ...(precipitation.period !== undefined ? { precipPeriod: precipitation.period } : {}),
      ...(symbol !== undefined ? { symbol } : {}),
    };
    entries.push(entry);
  }

  if (entries.length === 0) throw new Error('MET response timeseries has no usable entries');
  entries.sort((a, b) => a.timeMs - b.timeMs);

  return {
    ...(issuedMs !== undefined ? { issuedAt: new Date(issuedMs).toISOString() } : {}),
    entries,
  };
}

// ---------------------------------------------------------------------------
// Horizon and sample selection — derived from the response, not a constant
// ---------------------------------------------------------------------------

/**
 * Outcome of asking a forecast for one instant.
 *
 * There is deliberately no `interpolated` and no `extrapolated` member: those
 * would be invented numbers.
 */
export type MetSample =
  | {
      readonly status: 'forecast';
      /** `tempC` is guaranteed present; a forecast without a temperature is not one. */
      readonly entry: MetForecastEntry & { readonly tempC: number };
      readonly issuedAt?: string;
    }
  | { readonly status: 'beyond-horizon' }
  | { readonly status: 'unavailable'; readonly reason: string };

/**
 * Choose the entry closest to `targetMs`, or say why there is none.
 *
 * - target **past the series end** by more than `HORIZON_TOLERANCE_MS`
 *   → `beyond-horizon`. No entry is returned, so no number can leak.
 * - target before the series, or more than `MAX_SAMPLE_GAP_MS` from the closest
 *   entry → `unavailable` with a reason. MET has no past weather here.
 * - the closest entry carries no `air_temperature` → `unavailable`; a missing
 *   temperature is not `0 °C`.
 */
export function pickSample(forecast: MetForecast, targetMs: number): MetSample {
  const entries = forecast.entries;
  if (entries.length === 0) {
    return { status: 'unavailable', reason: 'MET returned an empty timeseries' };
  }
  const first = entries[0];
  const last = entries[entries.length - 1];

  if (targetMs > last.timeMs + HORIZON_TOLERANCE_MS) {
    return { status: 'beyond-horizon' };
  }
  if (targetMs < first.timeMs - MAX_SAMPLE_GAP_MS) {
    return {
      status: 'unavailable',
      reason:
        `requested time ${new Date(targetMs).toISOString()} precedes MET's series, ` +
        `which starts ${first.time}`,
    };
  }

  let closest = first;
  for (const entry of entries) {
    if (Math.abs(entry.timeMs - targetMs) < Math.abs(closest.timeMs - targetMs)) closest = entry;
    // Entries are sorted; once we are past the target the closest cannot improve.
    if (entry.timeMs > targetMs) break;
  }

  if (Math.abs(closest.timeMs - targetMs) > MAX_SAMPLE_GAP_MS) {
    return {
      status: 'unavailable',
      reason: `no MET entry within ${MAX_SAMPLE_GAP_MS / HOUR_MS} h of the requested time`,
    };
  }
  if (closest.tempC === undefined) {
    return {
      status: 'unavailable',
      reason: `the MET entry at ${closest.time} carries no air_temperature`,
    };
  }

  return {
    status: 'forecast',
    entry: closest as MetForecastEntry & { readonly tempC: number },
    ...(forecast.issuedAt !== undefined ? { issuedAt: forecast.issuedAt } : {}),
  };
}

// ---------------------------------------------------------------------------
// Trip-day time model: local midday in Europe/Oslo
// ---------------------------------------------------------------------------

const OSLO_TIME_ZONE = 'Europe/Oslo';
const MIDDAY_HOUR_LOCAL = 12;

let osloFormatter: Intl.DateTimeFormat | null | undefined;

function osloFormatterOrNull(): Intl.DateTimeFormat | null {
  if (osloFormatter === undefined) {
    try {
      osloFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: OSLO_TIME_ZONE,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      osloFormatter = null;
    }
  }
  return osloFormatter;
}

/** Last Sunday of a month (0-based month), as a UTC timestamp at 00:00. */
function lastSundayUtc(year: number, monthIndex: number): number {
  const endOfMonth = new Date(Date.UTC(year, monthIndex + 1, 0));
  return Date.UTC(year, monthIndex, endOfMonth.getUTCDate() - endOfMonth.getUTCDay());
}

/**
 * The EU/CET summer-time rule, used only when `Intl` with a time zone is
 * unavailable: +02:00 from the last Sunday of March 01:00 UTC to the last
 * Sunday of October 01:00 UTC, +01:00 otherwise.
 */
function euOsloOffsetMs(utcMs: number): number {
  const year = new Date(utcMs).getUTCFullYear();
  const dstStart = lastSundayUtc(year, 2) + HOUR_MS;
  const dstEnd = lastSundayUtc(year, 9) + HOUR_MS;
  return utcMs >= dstStart && utcMs < dstEnd ? 2 * HOUR_MS : HOUR_MS;
}

function osloOffsetMs(utcMs: number): number {
  const formatter = osloFormatterOrNull();
  if (!formatter) return euOsloOffsetMs(utcMs);
  const parts = formatter.formatToParts(new Date(utcMs));
  const part = (type: string): number => {
    const found = parts.find((candidate) => candidate.type === type);
    return found ? Number(found.value) : Number.NaN;
  };
  const asIfUtc = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );
  if (!Number.isFinite(asIfUtc)) return euOsloOffsetMs(utcMs);
  return asIfUtc - utcMs;
}

/** Validate `YYYY-MM-DD` and return UTC midnight of that calendar date. */
export function isoDateToUtcMidnight(isoDate: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) throw new RangeError(`expected an ISO date (YYYY-MM-DD), got "${isoDate}"`);
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== isoDate) {
    throw new RangeError(`"${isoDate}" is not a real calendar date`);
  }
  return time;
}

/** Add whole days to an ISO date, in UTC so DST can never move the date. */
export function addDays(isoDate: string, days: number): string {
  return new Date(isoDateToUtcMidnight(isoDate) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Today's calendar date in Europe/Oslo, as `YYYY-MM-DD`. */
export function todayInOslo(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Oslo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: string): string => parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/**
 * Local midday (12:00 Europe/Oslo) of a calendar date, as a UTC instant.
 *
 * Midday is never within an hour of a DST transition, so a single offset
 * refinement is exact.
 */
export function osloMidday(isoDate: string): Date {
  const naiveMidday = isoDateToUtcMidnight(isoDate) + MIDDAY_HOUR_LOCAL * HOUR_MS;
  const guess = naiveMidday - osloOffsetMs(naiveMidday);
  const refined = naiveMidday - osloOffsetMs(guess);
  return new Date(refined);
}
